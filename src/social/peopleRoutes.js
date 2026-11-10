import { Router } from "express";
import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { Block, Follow, Friendship, Presence, Privacy, Profile, Subscription, pairKey } from "./models.js";
import { audienceAllows, blocked, canMessage, cleanUsername, ensureNotBlocked, isFollower, isFriend, limitValue, privacyFor, relationship, objectId, requireId, requireUser, safeUser, userById, usersByIds } from "./helpers.js";
import { notify } from "./notify.js";
import { friendRequestLimiter } from "./rateLimit.js";
import { body, wrap } from "./routeUtils.js";
import mongoose from "mongoose";
import { emitUser, userOnline } from "./events.js";

const router = Router();
const id = (req) => requireId(req.params.id);
const other = async (req) => { const target = id(req); if (target === req.user.id) throw new AppError("You cannot do that to yourself.", 400); await requireUser(target); return target; };
const participantList = async (rows, getId) => {
  const ids = rows.map(getId).filter(Boolean);
  const users = await usersByIds(ids);
  return rows.map((row) => ({ ...row, user: users.get(getId(row)) ?? null })).filter((v) => v.user);
};

async function profileOf(viewer, target) {
  await ensureNotBlocked(viewer, target);
  const [user, p, pr, rel, friendCount, followers, following, subscribers] = await Promise.all([
    requireUser(target), Profile.findOne({ userId: target }).lean(), privacyFor(target), relationship(viewer, target),
    Friendship.countDocuments({ members: target, status: "accepted" }),
    Follow.countDocuments({ target, status: "accepted" }), Follow.countDocuments({ follower: target, status: "accepted" }),
    Subscription.countDocuments({ creator: target }),
  ]);
  const visible = (await audienceAllows(viewer, target, pr.profileVisibility)) && (!pr.privateProfile || viewer === target || rel.friends || rel.following);
  const messagePerm = viewer === target ? { allowed: false } : await canMessage(viewer, target);
  const friendsList = await audienceAllows(viewer, target, pr.friendsListVisibility);
  return { ...user, image: visible ? user.image : null, ...(!visible ? {} : { bio: p?.bio || "", avatarId: p?.avatarId || null, coverId: p?.coverId || null, location: p?.location || "", website: p?.website || "" }), isPrivate: !visible || Boolean(pr.privateProfile), friendCount: friendsList ? friendCount : null, followerCount: followers, followingCount: following, subscriberCount: subscribers, relationship: rel, canMessage: messagePerm.allowed, canViewFriends: friendsList };
}

// More-specific routes precede /users/:username.
router.get("/users/search", wrap(async (req) => {
  const q = cleanUsername(req.query.q).replace(/[^a-z0-9_]/g, "").slice(0, 30);
  if (q.length < 2) return [];
  const results = await mongoose.connection.db.collection("user").find({ username: { $regex: `^${q}`, $options: "i" } }, { projection: { _id: 1, id: 1, username: 1, name: 1, image: 1 } }).limit(25).toArray();
  const deny = await Block.find({ $or: [{ blocker: req.user.id }, { blocked: req.user.id }] }).lean();
  const deniedIds = new Set(deny.map((b) => b.blocker === req.user.id ? b.blocked : b.blocker));
  return results.map(safeUser).filter((u) => u && u.id !== req.user.id && !deniedIds.has(u.id)).map((u) => ({ ...u, image: null }));
}));
router.get("/users/suggestions", wrap(async (req) => {
  const mine = await Friendship.find({ members: req.user.id, status: "accepted" }).lean();
  const friends = new Set(mine.flatMap((r) => r.members.filter((x) => x !== req.user.id)));
  const second = friends.size ? await Friendship.find({ members: { $in: [...friends] }, status: "accepted" }).limit(500).lean() : [];
  const counts = new Map();
  for (const rel of second) for (const candidate of rel.members) if (candidate !== req.user.id && !friends.has(candidate) && !rel.members.includes(req.user.id)) counts.set(candidate, (counts.get(candidate) || 0) + 1);
  const deny = await Block.find({ $or: [{ blocker: req.user.id }, { blocked: req.user.id }] }).lean();
  const blockedIds = new Set(deny.map((b) => b.blocker === req.user.id ? b.blocked : b.blocker));
  let candidates = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => !blockedIds.has(id)).slice(0, 12);
  if (candidates.length < 5) {
    const recent = await mongoose.connection.db.collection("user").find({ username: { $type: "string" } }, { projection: { _id: 1, id: 1, username: 1 } }).sort({ createdAt: -1 }).limit(32).toArray();
    const rejected = new Set([req.user.id, ...friends, ...blockedIds, ...candidates]);
    candidates.push(...recent.map(safeUser).filter((u) => u && !rejected.has(u.id)).slice(0,8).map((u) => u.id));
  }
  const users = await usersByIds(candidates);
  return candidates.map((id) => ({ ...users.get(id), mutualCount: counts.get(id) || 0 })).filter((x) => x.username);
}));
router.get("/users/:id/connections", wrap(async (req) => {
  const target = id(req); await requireUser(target); await ensureNotBlocked(req.user.id, target);
  const { tab = "friends" } = req.query;
  let ids = [];
  if (tab === "friends") {
    const p = await privacyFor(target);
    if (!await audienceAllows(req.user.id, target, p.friendsListVisibility)) throw new AppError("Friends list is private.", 403);
    ids = (await Friendship.find({ members: target, status: "accepted" }).limit(100).lean()).flatMap((r) => r.members.filter((x) => x !== target));
  } else if (tab === "followers" || tab === "following") {
    const rows = await Follow.find(tab === "followers" ? { target, status: "accepted" } : { follower: target, status: "accepted" }).sort({ createdAt: -1 }).limit(100).lean();
    ids = rows.map((r) => tab === "followers" ? r.follower : r.target);
  } else if (tab === "subscribers") {
    // Subscriber identities are only available to the account owner.
    if (req.user.id !== target) throw new AppError("Subscriber list is private.", 403);
    ids = (await Subscription.find({ creator: target }).limit(100).lean()).map((r) => r.subscriber);
  } else throw new AppError("Unsupported list type.", 400);
  const users = await usersByIds(ids);
  const results = [];
  for (const person of ids) if (users.has(person) && !await blocked(req.user.id, person)) results.push(users.get(person));
  return results;
}));
router.get("/users/:username", wrap(async (req) => {
  const username = cleanUsername(req.params.username);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new AppError("Profile not found.", 404);
  const person = await mongoose.connection.db.collection("user").findOne({ username: { $regex: `^${username}$`, $options: "i" } }, { projection: { id: 1 } });
  if (!person) throw new AppError("Profile not found.", 404);
  return profileOf(req.user.id, String(person._id ?? person.id));
}));
router.get("/profile/me", wrap(async (req) => profileOf(req.user.id, req.user.id)));
router.patch("/profile/me", wrap(async (req) => {
  const payload = body(req, z.object({ bio: z.string().max(500).optional(), location: z.string().max(100).optional(), website: z.union([z.literal(""), z.string().url().max(300).regex(/^https?:\/\//i, "Use http or https URLs.")]).optional(), avatarId: z.string().optional(), coverId: z.string().optional() }).strict());
  if (payload.avatarId || payload.coverId) {
    const { Media } = await import("./models.js");
    for (const [field, purpose] of [["avatarId", "avatar"], ["coverId", "cover"]]) if (payload[field]) {
      const m = await Media.findOne({ _id: objectId(payload[field]), ownerId: req.user.id, status: "ready", kind: { $in: ["image", "gif"] }, purpose });
      if (!m) throw new AppError("Image is not ready or is not owned by you.", 400);
    }
  }
  await Profile.updateOne({ userId: req.user.id }, { $set: payload }, { upsert: true });
  return profileOf(req.user.id, req.user.id);
}));

router.post("/friends/:id/request", friendRequestLimiter, wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  const p = await privacyFor(target);
  if (p.friendRequestAudience === "nobody" || (p.friendRequestAudience === "followers" && !await isFollower(req.user.id, target))) throw new AppError("This user is not accepting friend requests.", 403);
  const key = pairKey(req.user.id, target);
  let rel;
  try { rel = await Friendship.create({ key, members: [req.user.id, target].sort(), from: req.user.id, to: target, status: "pending" }); }
  catch (error) {
    if (error.code === 11000) throw new AppError("A friend request or friendship already exists.", 409);
    throw error;
  }
  await notify({ to: target, from: req.user.id, type: "friend_request", entityId: rel.id, title: `${req.user.username} sent you a friend request`, dedupeKey: `friend:${rel.id}` });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { status: "sent" };
}));
router.post("/friends/:id/respond", wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  const { action } = body(req, z.object({ action: z.enum(["accept", "decline"]) }));
  const query = { key: pairKey(req.user.id, target), to: req.user.id, from: target, status: "pending" };
  const updated = action === "accept" ? await Friendship.findOneAndUpdate(query, { $set: { status: "accepted" } }, { new: true }) : await Friendship.findOneAndDelete(query);
  if (!updated) throw new AppError("No pending friend request was found.", 404);
  if (action === "accept") await notify({ to: target, from: req.user.id, type: "friend_accepted", entityId: updated.id, actorName: req.user.username, title: `${req.user.username} accepted your friend request`, dedupeKey: `friend-accepted:${updated.id}` });
  for (const person of [req.user.id, target]) emitUser(person, "relationship:changed", { userId: person === target ? req.user.id : target });
  return { status: action === "accept" ? "friends" : "none" };
}));
router.delete("/friends/:id", wrap(async (req) => {
  const target = await other(req); const removed = await Friendship.findOneAndDelete({ key: pairKey(req.user.id, target), $or: [{ status: "accepted" }, { from: req.user.id, status: "pending" }] });
  if (!removed) throw new AppError("No friendship or sent request was found.", 404);
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { status: "none" };
}));
// Cursor-based friend directory. Search executes on the actual users collection.
router.get("/friends/contacts", wrap(async (req) => {
  const count = limitValue(req.query.limit, 50);
  const q = String(req.query.q || "").trim().slice(0, 40);
  const query = { members: req.user.id, status: "accepted" };
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await mongoose.connection.db.collection("user").find({ $or: [
      { username: { $regex: escaped, $options: "i" } },
      { name: { $regex: escaped, $options: "i" } },
    ] }, { projection: { _id: 1, id: 1 } }).limit(100).toArray();
    const matches = [...new Set(users.flatMap((u) => [String(u._id ?? ""), String(u.id ?? "")]).filter((id) => id && id !== req.user.id))];
    if (!matches.length) return { items: [], nextCursor: null };
    query.$and = [{ members: req.user.id }, { members: { $in: matches } }];
  }
  if (req.query.before) query._id = { $lt: objectId(req.query.before) };
  const rows = await Friendship.find(query).sort({ _id: -1 }).limit(count).lean();
  const users = await usersByIds(rows.flatMap((r) => r.members.filter((id) => id !== req.user.id)));
  const denied = await Block.find({ $or: [{ blocker: req.user.id }, { blocked: req.user.id }] }).lean();
  const hidden = new Set(denied.map((b) => b.blocker === req.user.id ? b.blocked : b.blocker));
  const items = rows.map((r) => ({
    id: String(r._id), user: users.get(r.members.find((id) => id !== req.user.id)),
  })).filter((r) => r.user && !hidden.has(r.user.id));
  return { items, nextCursor: rows.length === count ? String(rows.at(-1)._id) : null };
}));

// Presence is scoped to accepted friends, and every status respects its owner's privacy.
router.get("/friends/presence", wrap(async (req) => {
  const wanted = String(req.query.ids || "").split(",").slice(0, 100).filter((id) => /^[a-zA-Z0-9_-]{6,128}$/.test(id) && id !== req.user.id);
  const conditions = { members: req.user.id, status: "accepted" };
  if (wanted.length) conditions.$and = [{ members: req.user.id }, { members: { $in: wanted } }];
  const mine = await Friendship.find(conditions).limit(100).lean();
  const ids = [...new Set(mine.flatMap((rel) => rel.members.filter((id) => id !== req.user.id)))];
  const result = {};
  await Promise.all(ids.map(async (target) => {
    if (await blocked(req.user.id, target)) return;
    const privacy = await privacyFor(target);
    const onlineVisible = privacy.onlineVisibility === "everyone" || privacy.onlineVisibility === "friends";
    const activeVisible = privacy.lastActiveVisibility === "everyone" || privacy.lastActiveVisibility === "friends";
    if (!onlineVisible && !activeVisible) { result[target] = { visible: false }; return; }
    const [online, recent] = await Promise.all([
      onlineVisible ? userOnline(target) : Promise.resolve(false),
      activeVisible ? Presence.findOne({ userId: target }).select("lastActiveAt").lean() : Promise.resolve(null),
    ]);
    result[target] = { visible: onlineVisible, online, lastActiveAt: recent?.lastActiveAt || null };
  }));
  return result;
}));

router.get("/friends", wrap(async (req) => {
  const tab = ["friends", "sent", "received"].includes(req.query.tab) ? req.query.tab : "friends";
  const query = tab === "friends" ? { members: req.user.id, status: "accepted" } : { [tab === "sent" ? "from" : "to"]: req.user.id, status: "pending" };
  const rows = await Friendship.find(query).sort({ createdAt: -1 }).limit(100).lean();
  return participantList(rows, (r) => r.members.find((x) => x !== req.user.id));
}));
router.get("/friends/mutual/:id", wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  const pr = await privacyFor(target);
  if (!await audienceAllows(req.user.id, target, pr.friendsListVisibility)) throw new AppError("Friends list is private.", 403);
  const rows = await Friendship.find({ members: req.user.id, status: "accepted" }).lean();
  const ids = rows.flatMap((r) => r.members.filter((x) => x !== req.user.id));
  const mutual = await Friendship.find({ members: { $all: [target] }, status: "accepted" }).lean();
  const shared = mutual.flatMap((r) => r.members.filter((x) => x !== target)).filter((x) => ids.includes(x));
  return [...(await usersByIds(shared)).values()];
}));

router.post("/follows/:id", wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  const p = await privacyFor(target); if (p.followAudience === "nobody") throw new AppError("This profile does not accept followers.", 403);
  const status = p.privateProfile ? "pending" : "accepted";
  try { await Follow.create({ follower: req.user.id, target, status }); } catch (error) { if (error.code === 11000) throw new AppError("Already following or requested.", 409); throw error; }
  await notify({ to: target, from: req.user.id, type: status === "pending" ? "follow_request" : "new_follow", entityId: req.user.id, title: `${req.user.username} ${status === "pending" ? "requested to follow you" : "started following you"}`, dedupeKey: `follow:${req.user.id}:${target}` });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { status };
}));
router.delete("/follows/:id", wrap(async (req) => {
  const target = await other(req); await Follow.deleteOne({ follower: req.user.id, target });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { status: "none" };
}));
router.post("/follows/:id/respond", wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  const { action } = body(req, z.object({ action: z.enum(["accept", "decline"]) }));
  const query = { follower: target, target: req.user.id, status: "pending" };
  const doc = action === "accept" ? await Follow.findOneAndUpdate(query, { $set: { status: "accepted" } }, { new: true }) : await Follow.findOneAndDelete(query);
  if (!doc) throw new AppError("Follow request not found.", 404);
  if (action === "accept") await notify({ to: target, from: req.user.id, type: "follow_accepted", entityId: req.user.id, title: `${req.user.username} approved your follow request`, dedupeKey: `follow-approved:${target}:${req.user.id}` });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { status: action === "accept" ? "accepted" : "none" };
}));
router.get("/follows", wrap(async (req) => {
  const tab = ["followers", "following", "requests"].includes(req.query.tab) ? req.query.tab : "following";
  const query = tab === "following" ? { follower: req.user.id } : { target: req.user.id, status: tab === "requests" ? "pending" : "accepted" };
  const rows = await Follow.find(query).sort({ createdAt: -1 }).limit(100).lean();
  return participantList(rows, (r) => tab === "following" ? r.target : r.follower);
}));
router.delete("/followers/:id", wrap(async (req) => {
  const target = await other(req);
  await Follow.deleteOne({ follower: target, target: req.user.id });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { removed: true };
}));
router.patch("/follows/:id/notifications", wrap(async (req) => {
  const target = await other(req); const { enabled } = body(req, z.object({ enabled: z.boolean() }));
  const result = await Follow.findOneAndUpdate({ follower: req.user.id, target, status: "accepted" }, { notificationsEnabled: enabled }, { new: true });
  if (!result) throw new AppError("Not following this account.", 404);
  return { enabled: result.notificationsEnabled };
}));

router.post("/subscriptions/:id", wrap(async (req) => {
  const target = await other(req); await ensureNotBlocked(req.user.id, target);
  try { await Subscription.create({ subscriber: req.user.id, creator: target }); } catch (error) { if (error.code === 11000) throw new AppError("Already subscribed.", 409); throw error; }
  await notify({ to: target, from: req.user.id, type: "new_subscriber", entityId: req.user.id, title: `${req.user.username} subscribed to your videos`, dedupeKey: `sub:${req.user.id}:${target}` });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { subscribed: true };
}));
router.delete("/subscriptions/:id", wrap(async (req) => {
  const target = await other(req); await Subscription.deleteOne({ subscriber: req.user.id, creator: target });
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { subscribed: false };
}));
router.get("/subscriptions", wrap(async (req) => {
  const list = await Subscription.find({ subscriber: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  return participantList(list, (r) => r.creator);
}));
router.patch("/subscriptions/:id/notifications", wrap(async (req) => {
  const target = await other(req); const { enabled } = body(req, z.object({ enabled: z.boolean() }));
  const doc = await Subscription.findOneAndUpdate({ subscriber: req.user.id, creator: target }, { notificationsEnabled: enabled }, { new: true });
  if (!doc) throw new AppError("Not subscribed to this creator.", 404);
  return { enabled: doc.notificationsEnabled };
}));

router.post("/blocks/:id", wrap(async (req) => {
  const target = await other(req);
  await Block.updateOne({ blocker: req.user.id, blocked: target }, { $setOnInsert: { blocker: req.user.id, blocked: target } }, { upsert: true });
  await Promise.all([
    Friendship.deleteOne({ key: pairKey(req.user.id, target) }),
    Follow.deleteMany({ $or: [{ follower: req.user.id, target }, { follower: target, target: req.user.id }] }),
    Subscription.deleteMany({ $or: [{ subscriber: req.user.id, creator: target }, { subscriber: target, creator: req.user.id }] }),
  ]);
  emitUser(target, "relationship:changed", { userId: req.user.id });
  return { blocked: true };
}));
router.delete("/blocks/:id", wrap(async (req) => {
  const target = await other(req); await Block.deleteOne({ blocker: req.user.id, blocked: target });
  return { blocked: false };
}));
router.get("/blocks", wrap(async (req) => participantList(await Block.find({ blocker: req.user.id }).lean(), (r) => r.blocked)));

const privacyPatch = z.object({
  messagePolicy: z.enum(["friends", "anyone", "custom"]).optional(),
  allowUsers: z.array(z.string()).max(100).optional(), denyUsers: z.array(z.string()).max(100).optional(),
  allowFriends: z.boolean().optional(), allowFollowers: z.boolean().optional(), allowSubscribers: z.boolean().optional(),
  profileVisibility: z.enum(["public", "followers", "friends", "private"]).optional(),
  friendRequestAudience: z.enum(["everyone", "followers", "nobody"]).optional(),
  followAudience: z.enum(["everyone", "nobody"]).optional(),
  communityInviteAudience: z.enum(["everyone", "friends", "nobody"]).optional(),
  friendsListVisibility: z.enum(["public", "friends", "private"]).optional(),
  onlineVisibility: z.enum(["everyone", "friends", "nobody"]).optional(),
  lastActiveVisibility: z.enum(["everyone", "friends", "nobody"]).optional(),
  readReceiptsVisibility: z.enum(["everyone", "friends", "nobody"]).optional(),
  commentAudience: z.enum(["everyone", "followers", "friends", "nobody"]).optional(),
  mentionAudience: z.enum(["everyone", "followers", "friends", "nobody"]).optional(),
  videoDefaultVisibility: z.enum(["public", "friends", "subscribers", "private"]).optional(),
  privateProfile: z.boolean().optional(),
}).strict();
router.get("/privacy", wrap(async (req) => privacyFor(req.user.id)));
router.patch("/privacy", wrap(async (req) => {
  const update = body(req, privacyPatch);
  for (const key of ["allowUsers", "denyUsers"]) if (update[key]) {
    update[key] = [...new Set(update[key].map(requireId).filter((u) => u !== req.user.id))];
    for (const v of update[key]) await requireUser(v);
  }
  return Privacy.findOneAndUpdate({ userId: req.user.id }, { $set: update }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
}));
export default router;
