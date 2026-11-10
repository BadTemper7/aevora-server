import { Router } from "express";
import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { Block, Conversation, Media, Message, pairKey } from "./models.js";
import { blocked, canMessage, cleanText, audienceAllows, privacyFor, limitValue, objectId, requireId, requireUser, usersByIds } from "./helpers.js";
import { isSupportedReactionEmoji } from "./reactionOptions.js";
import { messageSendLimiter } from "./rateLimit.js";
import { body, wrap } from "./routeUtils.js";
import { emitConversation, emitUser } from "./events.js";
import { conversationMatchesTab } from "./conversationFilters.js";
import { conversationUnreadPipeline } from "./unreadSummary.js";

const router = Router();
/** Resolve every attachment once per page. This metadata is display-only; downloads
 * still go through the existing owner/conversation authorization route. */
async function hydrateMessageAttachments(rows) {
  if (!rows.length || rows.every((row) => Array.isArray(row.attachments))) return rows;
  const ids = [...new Set(rows.flatMap((row) => (row.mediaIds || []).map(String)))];
  if (!ids.length) return rows.map((row) => ({ ...row, attachments: [] }));
  const media = await Media.find({ _id: { $in: ids }, status: 'ready' })
    .select('_id originalName kind mime size').lean();
  const byId = new Map(media.map((asset) => [String(asset._id), {
    id: String(asset._id), name: asset.originalName, kind: asset.kind, mime: asset.mime, size: asset.size,
  }]));
  return rows.map((row) => ({ ...row, attachments: (row.mediaIds || []).map((id) => byId.get(String(id))).filter(Boolean) }));
}
async function messagesForViewer(items, conversation, viewer) {
  const blockedIds = new Set();
  const permittedRead = new Set([viewer]);
  for (const m of conversation.members) if (m.userId !== viewer) {
    if (await blocked(viewer, m.userId)) blockedIds.add(m.userId);
    else if (await audienceAllows(viewer, m.userId, (await privacyFor(m.userId)).readReceiptsVisibility || "friends")) permittedRead.add(m.userId);
  }
  const visible = items.filter((m) => !blockedIds.has(m.senderId) && !(m.hiddenFor || []).includes(viewer) && (!m.expiresAt || new Date(m.expiresAt) > new Date())).map((m) => {
    const raw = m.toObject?.() || m;
    return { ...raw, readBy: (raw.readBy || []).filter((x) => permittedRead.has(x)) };
  });
  return hydrateMessageAttachments(visible);
}
// Newly-created messages need only the sender's own read receipt. Batch block
// checks once rather than querying each member's privacy settings N times.
// Full history and subsequent read events remain privacy-filtered separately.
async function emitNewMessage(conversation, message) {
  const raw = message.toObject?.() || message;
  const sender = raw.senderId;
  const targets = conversation.members.filter((m) => m.accepted && m.userId !== sender).map((m) => m.userId);
  const rows = targets.length ? await Block.find({ $or: [
    { blocker: sender, blocked: { $in: targets } },
    { blocked: sender, blocker: { $in: targets } },
  ] }).select("blocker blocked").lean() : [];
  const excluded = new Set(rows.map((row) => row.blocker === sender ? row.blocked : row.blocker));
  emitUser(sender, "message:new", { conversationId: String(conversation._id), message: raw });
  for (const recipient of targets) if (!excluded.has(recipient)) {
    emitUser(recipient, "message:new", {
      conversationId: String(conversation._id), message: { ...raw, readBy: [] },
    });
  }
}

async function emitMessage(conversation, event, message) {
  const obj = message.toObject?.() || message;
  await Promise.all(conversation.members.filter((m) => m.accepted).map(async (member) => {
    if (await blocked(obj.senderId, member.userId) && member.userId !== obj.senderId) return;
    const safe = (await messagesForViewer([obj], conversation, member.userId))[0];
    if (safe) emitUser(member.userId, event, { conversationId: String(conversation._id), message: safe });
  }));
}

const memberOf = (c, userId) => c.members.find((m) => m.userId === userId);
const allowMember = (c, userId, { requireAccepted = true } = {}) => {
  const member = memberOf(c, userId);
  if (!member || member.requestState === "rejected" || (requireAccepted && !member.accepted)) throw new AppError("You are not an active participant in this conversation.", 403);
  return member;
};
const loadConversation = async (req, { active = true } = {}) => {
  const c = await Conversation.findById(objectId(req.params.id));
  if (!c) throw new AppError("Conversation not found.", 404);
  allowMember(c, req.user.id, { requireAccepted: active });
  return c;
};
async function serializeConversation(c, viewer) {
  const raw = c.toObject?.() || c;
  const users = await usersByIds(raw.members.map((m) => m.userId));
  const me = raw.members.find((m) => m.userId === viewer);
  const others = raw.members.filter((m) => m.userId !== viewer);
  const blockRows = await Block.find({ $or: [{ blocker: viewer }, { blocked: viewer }] }).lean();
  const hidden = new Set(blockRows.map((b) => b.blocker === viewer ? b.blocked : b.blocker));
  const unread = me?.accepted ? await Message.countDocuments({ conversationId: raw._id, senderId: { $nin: [viewer, ...hidden] }, hiddenFor: { $ne: viewer }, deletedAt: null, createdAt: { $gt: me.lastReadAt || new Date(0) }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }) : 0;
  let lastPreview = raw.lastPreview, lastMessageAt = raw.lastMessageAt;
  if (hidden.size) {
    const lastVisible = await Message.findOne({ conversationId: raw._id, senderId: { $nin: [...hidden] }, deletedAt: null }).sort({ createdAt: -1 }).select("text kind createdAt").lean();
    lastPreview = lastVisible?.text?.slice(0, 120) || (lastVisible ? "Attachment" : "");
    lastMessageAt = lastVisible?.createdAt || null;
  }
  return { id: String(raw._id), type: raw.type, contextType: raw.contextType || "general", name: raw.name || (raw.type === "direct" ? users.get(others[0]?.userId)?.name : "Group chat"), avatarId: raw.avatarId || null, createdBy: raw.createdBy, members: raw.members.map((m) => ({ user: users.get(m.userId), role: m.role, accepted: m.accepted, requestState: m.requestState })), lastPreview, lastMessageAt, unread, theme: raw.theme || "default", quickEmoji: raw.quickEmoji || "👍", disappearingSeconds: raw.disappearingSeconds || 0, nicknames: raw.nicknames?.length ? raw.nicknames : me?.nicknames || [], settings: { pinned: me?.pinned || false, muted: me?.muted || false, archived: me?.archived || false, manuallyUnread: me?.manuallyUnread || false }, requestState: me?.requestState || "none" };
}
async function assertCanSend(c, senderId) {
  allowMember(c, senderId);
  if (c.type === "direct") {
    const target = c.members.find((m) => m.userId !== senderId);
    if (!target || await blocked(senderId, target.userId) || target.requestState === "rejected") throw new AppError("Messaging is not permitted.", 403);
    // Sender of an unanswered request may send only the initial message.
    if (!target.accepted && await Message.exists({ conversationId: c._id, senderId })) throw new AppError("Wait for your message request to be accepted.", 403);
  }
}

router.get("/conversations/unread-count", wrap(async (req) => {
  const blocks = await Block.find({ $or: [{ blocker: req.user.id }, { blocked: req.user.id }] })
    .select('blocker blocked').lean();
  const hidden = blocks.map(row => row.blocker === req.user.id ? row.blocked : row.blocker);
  const [result] = await Conversation.aggregate(conversationUnreadPipeline(req.user.id, hidden));
  return { unread: result?.unread || 0, conversations: result?.conversations || 0 };
}));
router.get("/conversations", wrap(async (req) => {
  const tab = ["inbox", "marketplace", "groups", "requests", "archived"].includes(req.query.tab) ? req.query.tab : "inbox";
  // Filter in MongoDB *before* pagination so older group/Marketplace chats
  // are not hidden by a busy direct-message inbox.
  const criteria = { "members.userId": req.user.id };
  if (tab === "inbox") { criteria.type = "direct"; criteria.contextType = { $ne: "marketplace" }; }
  if (tab === "groups") { criteria.type = "group"; criteria.contextType = { $ne: "marketplace" }; }
  if (tab === "marketplace") criteria.contextType = "marketplace";
  if (tab === "requests") criteria.members = { $elemMatch: { userId: req.user.id, requestState: "pending" } };
  if (tab === "archived") criteria.members = { $elemMatch: { userId: req.user.id, archived: true } };
  const docs = await Conversation.find(criteria).sort({ lastMessageAt: -1, _id: -1 }).limit(100).lean();
  const matches = docs.filter((c) => conversationMatchesTab(c, memberOf(c, req.user.id), tab));
  return Promise.all(matches.slice(0, 60).map((c) => serializeConversation(c, req.user.id)));
}));
router.post("/conversations", wrap(async (req) => {
  const input = body(req, z.discriminatedUnion("type", [
    z.object({ type: z.literal("direct"), userId: z.string() }),
    z.object({ type: z.literal("group"), userIds: z.array(z.string()).min(2).max(48), name: z.string().trim().min(2).max(80) }),
  ]));
  if (input.type === "direct") {
    const target = requireId(input.userId);
    if (target === req.user.id) throw new AppError("Cannot message yourself.", 400);
    await requireUser(target);
    const allowed = await canMessage(req.user.id, target);
    if (!allowed.allowed) throw new AppError("This user is not accepting messages from you.", 403);
    const key = pairKey(req.user.id, target);
    let c = await Conversation.findOne({ pairKey: key });
    if (!c) try {
      c = await Conversation.create({ type: "direct", pairKey: key, createdBy: req.user.id,
        members: [ { userId: req.user.id, role: "member", requestState: "accepted", accepted: true }, { userId: target, role: "member", accepted: !allowed.request, requestState: allowed.request ? "pending" : "accepted" } ],
      });
    } catch (error) { if (error.code === 11000) c = await Conversation.findOne({ pairKey: key }); else throw error; }
    const m = memberOf(c, req.user.id);
    if (m?.requestState === "rejected") throw new AppError("This message request was rejected.", 403);
    return serializeConversation(c, req.user.id);
  }
  const members = [...new Set(input.userIds.map(requireId))].filter((id) => id !== req.user.id);
  if (members.length < 2) throw new AppError("Group chat requires at least two other users.", 400);
  for (const target of members) { await requireUser(target); const policy = await canMessage(req.user.id, target); if (!policy.allowed) throw new AppError("At least one user does not allow invitations.", 403); }
  const c = await Conversation.create({ type: "group", createdBy: req.user.id, name: input.name,
    members: [ { userId: req.user.id, role: "owner", accepted: true, requestState: "accepted" }, ...members.map((userId) => ({ userId, accepted: false, requestState: "pending" })) ],
  });
  return serializeConversation(c, req.user.id);
}));
router.get("/conversations/:id", wrap(async (req) => serializeConversation(await loadConversation(req, { active: false }), req.user.id)));
router.post("/conversations/:id/respond", wrap(async (req) => {
  const c = await loadConversation(req, { active: false });
  const m = memberOf(c, req.user.id);
  if (m.requestState !== "pending") throw new AppError("No pending invitation or message request.", 409);
  const { action } = body(req, z.object({ action: z.enum(["accept", "reject"]) }));
  m.requestState = action === "accept" ? "accepted" : "rejected"; m.accepted = action === "accept";
  await c.save();
  emitConversation(c, "conversation:updated", { id: c.id });
  emitUser(c.createdBy, "conversation:updated", { id: c.id });
  return { status: m.requestState };
}));
router.delete("/conversations/:id/request", wrap(async (req) => {
  const c = await loadConversation(req, { active: false });
  const mine = memberOf(c, req.user.id);
  if (mine.requestState !== "pending") throw new AppError("This is not an active request.", 409);
  mine.requestState = "rejected";
  mine.accepted = false;
  mine.hiddenAt = new Date();
  await c.save();
  emitUser(c.createdBy, "conversation:updated", { id: c.id });
  return { deleted: true };
}));
router.patch("/conversations/:id/settings", wrap(async (req) => {
  const c = await loadConversation(req, { active: false });
  const data = body(req, z.object({ pinned: z.boolean().optional(), muted: z.boolean().optional(), archived: z.boolean().optional(), hidden: z.boolean().optional(), manuallyUnread: z.boolean().optional() }).strict());
  const m = memberOf(c, req.user.id);
  for (const [key, value] of Object.entries(data)) if (key === "hidden") m.hiddenAt = value ? new Date() : undefined; else m[key] = value;
  await c.save(); emitUser(req.user.id, "conversation:updated", { id: c.id }); return { settings: { pinned: m.pinned, muted: m.muted, archived: m.archived, manuallyUnread: m.manuallyUnread } };
}));
router.patch("/conversations/:id/customize", wrap(async (req) => {
  const c = await loadConversation(req);
  const data = body(req, z.object({
    theme: z.enum(["default", "blue", "violet", "emerald", "rose"]).optional(),
    quickEmoji: z.string().min(1).max(64).refine(isSupportedReactionEmoji, "Choose one emoji.").optional(),
    disappearingSeconds: z.union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(2592000)]).optional(),
    nickname: z.object({ userId: z.string(), value: z.string().trim().max(40) }).optional(),
  }).strict());
  const mine = memberOf(c, req.user.id);
  if (data.nickname) {
    if (!c.members.some((m) => m.userId === data.nickname.userId)) throw new AppError("Participant not found.", 404);
    c.nicknames = (c.nicknames || []).filter((n) => n.userId !== data.nickname.userId);
    if (data.nickname.value) c.nicknames.push({ userId: data.nickname.userId, value: data.nickname.value });
    await c.save();
    emitConversation(c, "conversation:updated", { id: c.id });
  } else {
    if (c.type === "group" && !["owner", "admin"].includes(mine.role)) throw new AppError("Only group administrators may change shared settings.", 403);
    Object.assign(c, data); await c.save(); emitConversation(c, "conversation:updated", { id: c.id });
  }
  return serializeConversation(c, req.user.id);
}));
router.patch("/conversations/:id/group", wrap(async (req) => {
  const c = await loadConversation(req);
  const member = memberOf(c, req.user.id);
  if (c.type !== "group" || !["admin", "owner"].includes(member.role)) throw new AppError("Only group administrators can edit group details.", 403);
  const change = body(req, z.object({ name: z.string().trim().min(2).max(80).optional(), avatarId: z.string().optional() }).strict());
  if (change.avatarId) {
    const image = await Media.findOne({ _id: objectId(change.avatarId), ownerId: req.user.id, kind: { $in: ["image", "gif"] }, status: "ready" });
    if (!image) throw new AppError("Invalid group avatar.", 400);
  }
  Object.assign(c, change); await c.save(); emitConversation(c, "conversation:updated", { id: c.id }); return serializeConversation(c, req.user.id);
}));
router.post("/conversations/:id/members", wrap(async (req) => {
  const c = await loadConversation(req); const mine = memberOf(c, req.user.id);
  if (c.type !== "group" || !["owner", "admin"].includes(mine.role)) throw new AppError("Only administrators can add members.", 403);
  const target = requireId(body(req, z.object({ userId: z.string() })).userId); await requireUser(target);
  if (c.members.some((m) => m.userId === target)) throw new AppError("User is already a participant.", 409);
  if (c.members.length >= 50) throw new AppError("Group is full.", 400);
  if (!(await canMessage(req.user.id, target)).allowed) throw new AppError("This user does not permit invitations.", 403);
  c.members.push({ userId: target, accepted: false, requestState: "pending" }); await c.save();
  return { invited: true };
}));
router.delete("/conversations/:id/members/:memberId", wrap(async (req) => {
  const c = await loadConversation(req); if (c.type !== "group") throw new AppError("Not a group.", 400);
  const mine = memberOf(c, req.user.id), target = memberOf(c, requireId(req.params.memberId));
  if (!target) throw new AppError("Participant not found.", 404);
  if (target.role === "owner" && target.userId !== req.user.id) throw new AppError("Group owner cannot be removed.", 403);
  if (target.userId !== req.user.id && (!["owner", "admin"].includes(mine.role) || (mine.role === "admin" && target.role !== "member"))) throw new AppError("Insufficient group permissions.", 403);
  if (target.role === "owner" && c.members.filter((m) => m.userId !== target.userId && m.accepted).length) throw new AppError("Transfer ownership before leaving.", 409);
  c.members = c.members.filter((m) => m.userId !== target.userId); await c.save();
  emitUser(target.userId, "conversation:removed", { id: c.id }); emitConversation(c, "conversation:updated", { id: c.id }); return { removed: true };
}));
router.patch("/conversations/:id/members/:memberId", wrap(async (req) => {
  const c = await loadConversation(req); const mine = memberOf(c, req.user.id);
  if (c.type !== "group" || mine.role !== "owner") throw new AppError("Only the group owner can manage administrators.", 403);
  const target = memberOf(c, requireId(req.params.memberId)); if (!target || !target.accepted) throw new AppError("Participant not found.", 404);
  const { role } = body(req, z.object({ role: z.enum(["owner", "admin", "member"]) }));
  if (role === "owner") { mine.role = "admin"; target.role = "owner"; c.createdBy = target.userId; }
  else if (target.role === "owner") throw new AppError("Transfer ownership first.", 409);
  else target.role = role;
  await c.save(); emitConversation(c, "conversation:updated", { id: c.id }); return { ok: true };
}));

router.get("/conversations/:id/messages", wrap(async (req) => {
  const c = await loadConversation(req, { active: false });
  if (c.type === "group") allowMember(c, req.user.id);
  const count = limitValue(req.query.limit, 50);
  const query = { conversationId: c._id, hiddenFor: { $ne: req.user.id }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  if (req.query.before) query._id = { $lt: objectId(req.query.before) };
  const items = await Message.find(query).sort({ _id: -1 }).limit(count).lean();
  return { items: await messagesForViewer(items.reverse(), c, req.user.id), nextCursor: items.length === count ? String(items[0]._id) : null };
}));
router.get("/conversations/:id/pinned", wrap(async (req) => {
  const c = await loadConversation(req);
  const rows = await Message.find({ conversationId: c._id, pinnedAt: { $ne: null }, hiddenFor: { $ne: req.user.id }, deletedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }).sort({ pinnedAt: -1 }).limit(50).lean();
  return messagesForViewer(rows, c, req.user.id);
}));
router.get("/conversations/:id/messages/around/:messageId", wrap(async (req) => {
  const c = await loadConversation(req);
  const _id = objectId(req.params.messageId);
  const target = await Message.findOne({ _id, conversationId: c._id, hiddenFor: { $ne: req.user.id } }).lean();
  if (!target) throw new AppError("Message not found.", 404);
  const query = { conversationId: c._id, hiddenFor: { $ne: req.user.id }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  const [older, newer] = await Promise.all([
    Message.find({ ...query, _id: { $lt: _id } }).sort({ _id: -1 }).limit(12).lean(),
    Message.find({ ...query, _id: { $gt: _id } }).sort({ _id: 1 }).limit(12).lean(),
  ]);
  return messagesForViewer([...older.reverse(), target, ...newer], c, req.user.id);
}));
router.get("/conversations/:id/attachments", wrap(async (req) => {
  const c = await loadConversation(req);
  const type = ["media", "files", "links"].includes(req.query.type) ? req.query.type : "media";
  const kind = type === "files" ? ["file"] : ["image", "gif", "video"];
  const query = { conversationId: c._id, deletedAt: null, hiddenFor: { $ne: req.user.id }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] };
  if (type === "links") query.text = { $regex: "https?://", $options: "i" };
  else query.kind = { $in: [...kind, "mixed"] };
  const rows = await messagesForViewer(await Message.find(query).sort({ createdAt: -1 }).limit(100).lean(), c, req.user.id);
  if (type === "links") return rows;
  return rows.map((msg) => ({ ...msg, attachments: (msg.attachments || []).filter((asset) => kind.includes(asset.kind)) }))
    .filter((msg) => msg.attachments.length > 0);
}));
router.get("/conversations/:id/search", wrap(async (req) => {
  const c = await loadConversation(req);
  const q = cleanText(req.query.q, 100);
  if (q.length < 2) return [];
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await Message.find({ conversationId: c._id, hiddenFor: { $ne: req.user.id }, deletedAt: null, text: { $regex: safe, $options: "i" } }).sort({ createdAt: -1 }).limit(50).lean();
  return messagesForViewer(rows, c, req.user.id);
}));
router.post("/conversations/:id/messages", messageSendLimiter, wrap(async (req) => {
  const c = await loadConversation(req); await assertCanSend(c, req.user.id);
  // Only the GIPHY content ID is stored. Browser clients resolve the image
  // directly with GIPHY, so media URLs are never cached in MongoDB.
  const gifSchema = z.object({ source: z.literal("giphy"), id: z.string().regex(/^[A-Za-z0-9_-]{1,90}$/) }).strict();
  const data = body(req, z.object({ text: z.string().max(5000).optional(), mediaIds: z.array(z.string()).max(4).default([]), kind: z.enum(["text", "image", "video", "gif", "file", "mixed"]).default("text"), gif: gifSchema.optional(), replyTo: z.string().optional(), clientId: z.string().uuid() }).strict());
  const text = cleanText(data.text || "", 5000);
  if (!text && !data.mediaIds.length && !data.gif) throw new AppError("Message cannot be empty.", 400);
  if (data.gif && (data.kind !== "gif" || data.mediaIds.length)) throw new AppError("Invalid GIF message.", 400);
  if (data.mediaIds.length) {
    const ids = data.mediaIds.map(objectId);
    const assets = await Media.find({ _id: { $in: ids }, ownerId: req.user.id, status: "ready", purpose: "message" }).lean();
    if (assets.length !== ids.length) throw new AppError("An attachment is missing or still processing.", 409);
    const expectedKinds = new Set(assets.map((asset) => asset.kind));
    const expectedKind = expectedKinds.size > 1 ? "mixed" : [...expectedKinds][0];
    if (expectedKind !== data.kind) throw new AppError("Attachment type does not match message type.", 400);
    if (new Set(data.mediaIds).size !== data.mediaIds.length) throw new AppError("Duplicate attachment ID.", 400);
  }
  let replyTo;
  if (data.replyTo) {
    replyTo = await Message.findOne({ _id: objectId(data.replyTo), conversationId: c.id });
    if (!replyTo) throw new AppError("Original message not found.", 404);
    if (await blocked(req.user.id, replyTo.senderId)) throw new AppError("You cannot reply to messages from a blocked account.", 403);
  }
  let msg;
  try { msg = await Message.create({ conversationId: c._id, senderId: req.user.id, clientId: data.clientId, text, kind: data.kind, gif: data.gif, mediaIds: data.mediaIds.map(objectId), replyTo: replyTo?._id, expiresAt: c.disappearingSeconds ? new Date(Date.now() + c.disappearingSeconds * 1000) : undefined, deliveredTo: [req.user.id], readBy: [req.user.id] }); }
  catch (error) {
    if (error.code !== 11000) throw error;
    msg = await Message.findOne({ conversationId: c._id, senderId: req.user.id, clientId: data.clientId });
    if (!msg) throw error;
  }
  // Emit as soon as the Message document is durable. Do not wait for a second
  // database write to update the conversation preview before delivery.
  const storedMessage = (await hydrateMessageAttachments([msg.toObject()]))[0];
  void emitNewMessage(c, storedMessage).catch((error) => console.error("Message broadcast failed", { messageId: msg.id, error: error.message }));
  // Atomic preview guard prevents rapid concurrent sends from replacing a newer preview.
  await Conversation.updateOne({ _id: c._id, $or: [{ lastMessageAt: { $lte: msg.createdAt } }, { lastMessageAt: null }] }, { $set: { lastMessageAt: msg.createdAt, lastPreview: text.slice(0, 120) || (data.kind === "video" ? "Video" : data.kind === "gif" ? "GIF" : data.kind === "file" ? "File" : "Attachment") } });
  emitConversation(c, "conversation:updated", { id: c.id });
  // Ordinary messages belong to conversation unread tracking, never the bell.
  return storedMessage;
}));
router.post("/conversations/:id/read", wrap(async (req) => {
  const c = await loadConversation(req); const now = new Date();
  const m = memberOf(c, req.user.id); m.lastReadAt = now; m.manuallyUnread = false; await c.save();
  await Message.updateMany({ conversationId: c.id, senderId: { $ne: req.user.id }, createdAt: { $lte: now } }, { $addToSet: { readBy: req.user.id, deliveredTo: req.user.id } });
  const privacy = await privacyFor(req.user.id);
  for (const member of c.members) if (member.accepted && (member.userId === req.user.id || await audienceAllows(member.userId, req.user.id, privacy.readReceiptsVisibility || "friends"))) emitUser(member.userId, "conversation:read", { id: c.id, userId: req.user.id, readAt: now });
  return { ok: true };
}));
router.patch("/messages/:id", wrap(async (req) => {
  const message = await Message.findById(objectId(req.params.id)); if (!message) throw new AppError("Message not found.", 404);
  const c = await Conversation.findById(message.conversationId); if (!c) throw new AppError("Conversation not found.", 404); allowMember(c, req.user.id);
  if (message.senderId !== req.user.id || message.deletedAt) throw new AppError("You can only edit your own messages.", 403);
  const { text } = body(req, z.object({ text: z.string().trim().min(1).max(5000) }));
  message.text = cleanText(text); message.editedAt = new Date(); await message.save();
  await emitMessage(c, "message:updated", message); return message;
}));
router.delete("/messages/:id", wrap(async (req) => {
  const msg = await Message.findById(objectId(req.params.id)); if (!msg) throw new AppError("Message not found.", 404);
  const c = await Conversation.findById(msg.conversationId); if (!c) throw new AppError("Conversation not found.", 404); allowMember(c, req.user.id);
  if (msg.senderId !== req.user.id && !(c.type === "group" && ["owner", "admin"].includes(memberOf(c, req.user.id).role))) throw new AppError("You cannot delete this message for everyone.", 403);
  msg.deletedAt = new Date(); msg.text = ""; msg.mediaIds = []; msg.gif = undefined; msg.reactions = []; msg.pinnedAt = undefined; msg.pinnedBy = undefined; await msg.save();
  await emitMessage(c, "message:updated", msg); return { deleted: true };
}));
router.delete("/messages/:id/me", wrap(async (req) => {
  const msg = await Message.findById(objectId(req.params.id));
  if (!msg) throw new AppError("Message unavailable.", 404);
  const c = await Conversation.findById(msg.conversationId);
  if (!c) throw new AppError("Conversation unavailable.", 404);
  allowMember(c, req.user.id);
  await Message.updateOne({ _id: msg._id }, { $addToSet: { hiddenFor: req.user.id } });
  // Only this person's devices are notified; all other participants keep their copy.
  emitUser(req.user.id, "message:hidden", { conversationId: String(c._id), messageId: String(msg._id) });
  return { hidden: true };
}));
router.patch("/messages/:id/pin", wrap(async (req) => {
  const msg = await Message.findById(objectId(req.params.id));
  if (!msg || msg.deletedAt || (msg.expiresAt && msg.expiresAt <= new Date())) throw new AppError("Message unavailable.", 404);
  const c = await Conversation.findById(msg.conversationId);
  if (!c) throw new AppError("Conversation unavailable.", 404);
  const mine = allowMember(c, req.user.id);
  if (c.type === "group" && !["owner", "admin"].includes(mine.role)) throw new AppError("Only group administrators can pin messages.", 403);
  if (await blocked(req.user.id, msg.senderId)) throw new AppError("Message unavailable.", 404);
  const { pinned } = body(req, z.object({ pinned: z.boolean() }).strict());
  if (pinned && !msg.pinnedAt) {
    const limit = Math.max(1, Math.min(100, Number(process.env.MAX_PINNED_MESSAGES) || 20));
    if (await Message.countDocuments({ conversationId: c._id, pinnedAt: { $ne: null }, deletedAt: null }) >= limit) throw new AppError(`You can pin up to ${limit} messages.`, 409);
  }
  msg.pinnedAt = pinned ? new Date() : undefined;
  msg.pinnedBy = pinned ? req.user.id : undefined;
  await msg.save();
  await emitMessage(c, "message:updated", msg);
  emitConversation(c, "conversation:updated", { id: c.id });
  return { id: msg.id, pinnedAt: msg.pinnedAt || null };
}));
router.post("/messages/:id/reactions", wrap(async (req) => {
  const msg = await Message.findById(objectId(req.params.id)); if (!msg || msg.deletedAt) throw new AppError("Message unavailable.", 404);
  const c = await Conversation.findById(msg.conversationId); if (!c) throw new AppError("Conversation not found.", 404); allowMember(c, req.user.id);
  if (await blocked(req.user.id, msg.senderId)) throw new AppError("You cannot react to messages from a blocked account.", 403);
  const { emoji } = body(req, z.object({ emoji: z.string().max(64).refine(isSupportedReactionEmoji, "Choose one emoji reaction.") }));
  msg.reactions = msg.reactions.filter((r) => r.userId !== req.user.id);
  msg.reactions.push({ userId: req.user.id, emoji }); await msg.save();
  await emitMessage(c, "message:updated", msg);
  return msg;
}));
router.delete("/messages/:id/reactions", wrap(async (req) => {
  const msg = await Message.findById(objectId(req.params.id)); if (!msg) throw new AppError("Message unavailable.", 404);
  const c = await Conversation.findById(msg.conversationId); if (!c) throw new AppError("Conversation not found.", 404); allowMember(c, req.user.id);
  msg.reactions = msg.reactions.filter((r) => r.userId !== req.user.id); await msg.save();
  await emitMessage(c, "message:updated", msg); return msg;
}));
export default router;
export { allowMember };
