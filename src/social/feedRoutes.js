import { Router } from "express";
import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import {
  EventJob, Follow, Media, SocialPost, SocialPostComment,
  SocialPostInteraction,
} from "./models.js";
import { canSeePost } from "./feedRules.js";
import { cleanText, limitValue, objectId, usersByIds } from "./helpers.js";
import { body, wrap } from "./routeUtils.js";
import { notify } from "./notify.js";

const router = Router();
const visibility = z.enum(["public", "friends", "followers", "private"]);
const mediaList = z.array(z.string()).max(4).default([]);

async function validateMedia(ids, ownerId, purpose, kinds) {
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new AppError("Select each attachment once.", 400);
  if (!ids.length) return [];
  const items = await Media.find({ _id: { $in: ids.map(objectId) }, ownerId, purpose, status: "ready", kind: { $in: kinds } }).lean();
  if (items.length !== ids.length) throw new AppError("An attachment is still processing or does not belong to you.", 400);
  return ids.map(objectId);
}
async function authorizedPost(req) {
  const post = await SocialPost.findById(objectId(req.params.id));
  if (!post || !await canSeePost(req.user.id, post)) throw new AppError("Post not found.", 404);
  return post;
}
async function serializedPosts(posts, viewer) {
  const users = await usersByIds(posts.map((post) => post.ownerId));
  const interactions = await SocialPostInteraction.find({ postId: { $in: posts.map((post) => post._id) }, userId: viewer }).lean();
  const mine = new Map(interactions.map((it) => [String(it.postId), it]));
  return posts.map((post) => ({
    id: String(post._id), author: users.get(post.ownerId) || { id: post.ownerId, username: "unknown", name: "Account" },
    own: post.ownerId === viewer, content: post.content, createdAt: post.createdAt,
    visibility: post.visibility, mediaIds: post.mediaIds.map(String),
    likes: post.likesCount || 0, commentCount: post.commentsCount || 0,
    liked: Boolean(mine.get(String(post._id))?.liked), saved: Boolean(mine.get(String(post._id))?.saved),
  }));
}
router.get("/feed/trending", wrap(async (req) => {
  const recent = await SocialPost.find({ visibility: "public", createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }).sort({ _id: -1 }).limit(120).select("content ownerId visibility").lean();
  const counts = new Map();
  for (const post of recent) {
    if (!post.content || !await canSeePost(req.user.id, post)) continue;
    const tags = new Set([...post.content.matchAll(/#([a-z0-9_]{2,40})\b/gi)].map((match) => match[1].toLowerCase()));
    for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, posts]) => ({ tag, posts }));
}));
router.get("/feed/posts", wrap(async (req) => {
  const count = limitValue(req.query.limit, 16);
  const audience = req.query.audience === "following" ? "following" : "everyone";
  const filter = {};
  const tag = String(req.query.tag || "").trim().toLowerCase();
  if (tag && /^[a-z0-9_]{2,40}$/.test(tag)) filter.content = { $regex: `#${tag}(?![a-z0-9_])`, $options: "i" };
  if (req.query.before) filter._id = { $lt: objectId(req.query.before) };
  if (audience === "following") {
    const following = await Follow.find({ follower: req.user.id, status: "accepted" }).select("target").lean();
    filter.ownerId = { $in: [req.user.id, ...following.map((f) => f.target)] };
  }
  const batch = Math.min(100, count * 5);
  const rows = await SocialPost.find(filter).sort({ _id: -1 }).limit(batch).lean();
  const hiddenRows = await SocialPostInteraction.find({ postId: { $in: rows.map((row) => row._id) }, userId: req.user.id, hidden: true }).select("postId").lean();
  const hidden = new Set(hiddenRows.map((row) => String(row.postId)));
  const visible = [];
  let scanned = 0;
  for (const post of rows) {
    scanned += 1;
    if (!hidden.has(String(post._id)) && await canSeePost(req.user.id, post)) visible.push(post);
    if (visible.length >= count) break;
  }
  const hasMore = scanned < rows.length || rows.length === batch;
  return { items: await serializedPosts(visible, req.user.id), nextCursor: hasMore && scanned ? String(rows[scanned - 1]._id) : null };
}));
router.post("/feed/posts", wrap(async (req) => {
  const input = body(req, z.object({ content: z.string().max(2000).default(""), mediaIds: mediaList, visibility: visibility.default("public") }).strict());
  const content = cleanText(input.content, 2000);
  if (!content && !input.mediaIds.length) throw new AppError("Write something or attach a photo.", 400);
  const mediaIds = await validateMedia(input.mediaIds, req.user.id, "post", ["image", "gif"]);
  const post = await SocialPost.create({ ownerId: req.user.id, content, mediaIds, visibility: input.visibility });
  // Durable outbox: notification fan-out runs outside the publishing request.
  await EventJob.updateOne({ type: "post_published", entityId: post.id }, { $setOnInsert: { type: "post_published", entityId: post.id, ownerId: req.user.id, status: "pending" } }, { upsert: true });
  return (await serializedPosts([post.toObject()], req.user.id))[0];
}));
router.get("/feed/posts/:id", wrap(async (req) => {
  const post = await authorizedPost(req);
  return (await serializedPosts([post.toObject()], req.user.id))[0];
}));
router.delete("/feed/posts/:id", wrap(async (req) => {
  const post = await SocialPost.findOneAndDelete({ _id: objectId(req.params.id), ownerId: req.user.id });
  if (!post) throw new AppError("Post not found or not yours.", 404);
  await Promise.all([SocialPostInteraction.deleteMany({ postId: post._id }), SocialPostComment.deleteMany({ postId: post._id })]);
  return { deleted: true };
}));
router.post("/feed/posts/:id/like", wrap(async (req) => {
  const post = await authorizedPost(req);
  const { liked } = body(req, z.object({ liked: z.boolean() }));
  let interaction = await SocialPostInteraction.findOne({ postId: post._id, userId: req.user.id });
  if (!interaction) {
    try { interaction = await SocialPostInteraction.create({ postId: post._id, userId: req.user.id }); }
    catch (e) { if (e.code !== 11000) throw e; }
  }
  const change = await SocialPostInteraction.updateOne({ postId: post._id, userId: req.user.id, liked: !liked }, { $set: { liked } });
  if (change.modifiedCount) await SocialPost.updateOne({ _id: post._id }, { $inc: { likesCount: liked ? 1 : -1 } });
  const result = await SocialPost.findById(post._id).lean();
  return { liked, likes: Math.max(0, result?.likesCount || 0) };
}));
router.post("/feed/posts/:id/save", wrap(async (req) => {
  const post = await authorizedPost(req);
  const { saved } = body(req, z.object({ saved: z.boolean() }));
  await SocialPostInteraction.updateOne({ postId: post._id, userId: req.user.id }, { $set: { saved }, $setOnInsert: { liked: false } }, { upsert: true });
  return { saved };
}));
router.post("/feed/posts/:id/hide", wrap(async (req) => {
  const post = await authorizedPost(req);
  await SocialPostInteraction.updateOne({ postId: post._id, userId: req.user.id }, { $set: { hidden: true } }, { upsert: true });
  return { hidden: true };
}));
router.get("/feed/posts/:id/comments", wrap(async (req) => {
  const post = await authorizedPost(req);
  const filter = { postId: post._id };
  if (req.query.before) filter._id = { $lt: objectId(req.query.before) };
  const limit = limitValue(req.query.limit, 30);
  const rows = await SocialPostComment.find(filter).sort({ _id: -1 }).limit(limit).lean();
  const users = await usersByIds(rows.map((c) => c.userId));
  const items = rows.map((c) => ({ id: String(c._id), author: users.get(c.userId) || { name: "Account" }, text: c.text, createdAt: c.createdAt }));
  return { items, nextCursor: rows.length === limit ? String(rows.at(-1)._id) : null };
}));
router.post("/feed/posts/:id/comments", wrap(async (req) => {
  const post = await authorizedPost(req);
  const { text } = body(req, z.object({ text: z.string().trim().min(1).max(1000) }));
  const item = await SocialPostComment.create({ postId: post._id, userId: req.user.id, text: cleanText(text, 1000) });
  await SocialPost.updateOne({ _id: post._id }, { $inc: { commentsCount: 1 } });
  if (post.ownerId !== req.user.id) await notify({ to: post.ownerId, from: req.user.id, type: "comment", entityId: post.id, title: `${req.user.username} commented on your post`, dedupeKey: `post-comment:${item.id}` });
  return { id: item.id, text: item.text, createdAt: item.createdAt };
}));

export default router;
