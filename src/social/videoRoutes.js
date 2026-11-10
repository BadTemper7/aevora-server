import mongoose from "mongoose";
import { Router } from "express";
import { z } from "zod";
import { AppError } from "../utils/AppError.js";
import { Block, Follow, Friendship, Media, Subscription, EventJob, Video, VideoComment, VideoInteraction } from "./models.js";
import { audienceAllows, blocked, canSeeVideo, cleanText, limitValue, objectId, privacyFor, usersByIds } from "./helpers.js";
import { notify } from "./notify.js";
import { body, wrap } from "./routeUtils.js";
const router = Router();
async function getVideo(viewer, id) {
  const video = await Video.findById(objectId(id)).lean();
  if (!video || !await canSeeVideo(viewer, video)) throw new AppError("Video not found or unavailable.", 404);
  return video;
}
async function enrich(videos, viewer) {
  if (!videos.length) return [];
  const owners = await usersByIds(videos.map((v) => v.ownerId));
  const ids = videos.map((v) => v._id);
  const [likedRows, ownInteractions, commentTotals] = await Promise.all([
    VideoInteraction.aggregate([{ $match: { videoId: { $in: ids }, liked: true } }, { $group: { _id: "$videoId", count: { $sum: 1 } } }]),
    VideoInteraction.find({ videoId: { $in: ids }, userId: viewer }).lean(),
    VideoComment.aggregate([{ $match: { videoId: { $in: ids } } }, { $group: { _id: "$videoId", count: { $sum: 1 } } }]),
  ]);
  const likes = new Map(likedRows.map((r) => [String(r._id), r.count]));
  const comments = new Map(commentTotals.map((r) => [String(r._id), r.count]));
  const mine = new Map(ownInteractions.map((r) => [String(r.videoId), r]));
  return videos.map((v) => ({ ...v, id: String(v._id), author: owners.get(v.ownerId) || null, liked: Boolean(mine.get(String(v._id))?.liked), saved: Boolean(mine.get(String(v._id))?.saved), likes: likes.get(String(v._id)) || 0, comments: comments.get(String(v._id)) || 0 }));
}
router.post("/videos", wrap(async (req) => {
  const input = body(req, z.object({ mediaId: z.string(), title: z.string().trim().min(2).max(140), description: z.string().max(2000).optional(), visibility: z.enum(["public", "friends", "subscribers", "private"]).optional() }).strict());
  const media = await Media.findOne({ _id: objectId(input.mediaId), ownerId: req.user.id, kind: "video", purpose: "video", status: "ready" });
  if (!media) throw new AppError("Wait until your video has finished processing.", 409);
  const p = await privacyFor(req.user.id);
  const video = await Video.create({ ...input, mediaId: media._id, ownerId: req.user.id, visibility: input.visibility || p.videoDefaultVisibility || "public" });
  await EventJob.updateOne({ type: "video_published", entityId: video.id }, { $setOnInsert: { type: "video_published", entityId: video.id, ownerId: req.user.id } }, { upsert: true });
  return (await enrich([video.toObject()], req.user.id))[0];
}));
router.get("/videos", wrap(async (req) => {
  const tab = ["latest", "subscriptions", "following", "mine", "history", "saved"].includes(req.query.tab) ? req.query.tab : "latest";
  const query = {};
  if (req.query.before) query._id = { $lt: objectId(req.query.before) };
  if (tab === "mine") query.ownerId = req.user.id;
  if (req.query.ownerId) query.ownerId = String(req.query.ownerId).slice(0,128);
  if (tab === "subscriptions") {
    const subs = await Subscription.find({ subscriber: req.user.id }).select("creator").lean();
    query.ownerId = { $in: subs.map((s) => s.creator) };
  }
  if (tab === "following") {
    const follows = await Follow.find({ follower: req.user.id, status: "accepted" }).select("target").lean();
    query.ownerId = { $in: follows.map((s) => s.target) };
  }
  if (["history", "saved"].includes(tab)) {
    const rows = await VideoInteraction.find({ userId: req.user.id, ...(tab === "saved" ? { saved: true } : { viewedAt: { $exists: true } }) }).sort({ updatedAt: -1 }).limit(500).select("videoId").lean();
    query._id = { $in: rows.map((r) => r.videoId), ...(req.query.before ? { $lt: objectId(req.query.before) } : {}) };
  }
  const candidates = await Video.find(query).sort({ _id: -1 }).limit(100).lean();
  const allowed = [];
  for (const video of candidates) if (await canSeeVideo(req.user.id, video)) allowed.push(video);
  const count = limitValue(req.query.limit, 20);
  const results = allowed.slice(0, count);
  // A full scan window may contain private videos. Resume after the last scanned
  // document when all visible results in that window have been returned.
  const nextCursor = allowed.length > count && results.length
    ? String(results.at(-1)._id)
    : candidates.length === 100 ? String(candidates.at(-1)._id) : null;
  return { items: await enrich(results, req.user.id), nextCursor };
}));
router.get("/videos/:id", wrap(async (req) => (await enrich([await getVideo(req.user.id, req.params.id)], req.user.id))[0]));
router.patch("/videos/:id", wrap(async (req) => {
  const video = await Video.findById(objectId(req.params.id)); if (!video || video.ownerId !== req.user.id) throw new AppError("Video not found.", 404);
  const update = body(req, z.object({ title: z.string().trim().min(2).max(140).optional(), description: z.string().max(2000).optional(), visibility: z.enum(["public", "friends", "subscribers", "private"]).optional() }).strict());
  Object.assign(video, update); await video.save(); return (await enrich([video.toObject()], req.user.id))[0];
}));
router.delete("/videos/:id", wrap(async (req) => {
  const v = await Video.findOneAndDelete({ _id: objectId(req.params.id), ownerId: req.user.id }); if (!v) throw new AppError("Video not found.", 404);
  await Promise.all([VideoInteraction.deleteMany({ videoId: v.id }), VideoComment.deleteMany({ videoId: v.id })]); return { deleted: true };
}));
router.put("/videos/:id/interaction", wrap(async (req) => {
  const video = await getVideo(req.user.id, req.params.id);
  const { action, enabled } = body(req, z.object({ action: z.enum(["liked", "saved"]), enabled: z.boolean() }));
  const doc = await VideoInteraction.findOneAndUpdate({ userId: req.user.id, videoId: video._id }, { $set: { [action]: enabled } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  if (action === "liked" && enabled) await notify({ to: video.ownerId, from: req.user.id, type: "video_like", entityId: video._id, title: `${req.user.username} liked your video`, dedupeKey: `like:${video._id}:${req.user.id}` });
  return { liked: doc.liked, saved: doc.saved };
}));
router.post("/videos/:id/watch", wrap(async (req) => {
  const video = await getVideo(req.user.id, req.params.id);
  const { seconds } = body(req, z.object({ seconds: z.number().min(0).max(86400).default(0) }));
  const previous = await VideoInteraction.findOne({ userId: req.user.id, videoId: video._id }).lean();
  const shouldCount = !previous?.viewedAt || Date.now() - new Date(previous.viewedAt).getTime() > 24 * 60 * 60 * 1000;
  await VideoInteraction.updateOne({ userId: req.user.id, videoId: video._id }, { $set: { viewedAt: new Date() }, $max: { watchSeconds: seconds } }, { upsert: true });
  if (shouldCount) await Video.updateOne({ _id: video._id }, { $inc: { viewCount: 1 } });
  return { recorded: true };
}));
router.get("/videos/:id/comments", wrap(async (req) => {
  const video = await getVideo(req.user.id, req.params.id);
  const query = { videoId: video._id };
  if (req.query.before) query._id = { $lt: objectId(req.query.before) };
  const rows = await VideoComment.find(query).sort({ _id: -1 }).limit(limitValue(req.query.limit, 50)).lean();
  const authors = await usersByIds(rows.map((r) => r.userId));
  return rows.map((r) => ({ ...r, author: authors.get(r.userId) }));
}));
router.post("/videos/:id/comments", wrap(async (req) => {
  const video = await getVideo(req.user.id, req.params.id);
  const p = await privacyFor(video.ownerId);
  if (!await audienceAllows(req.user.id, video.ownerId, p.commentAudience)) throw new AppError("Comments are restricted for this video.", 403);
  const { text, parentId } = body(req, z.object({ text: z.string().trim().min(1).max(1500), parentId: z.string().optional() }));
  if (parentId && !await VideoComment.exists({ _id: objectId(parentId), videoId: video._id })) throw new AppError("Comment not found.", 404);
  const mentionNames = [...new Set([...text.matchAll(/(?:^|\s)@([a-z0-9_]{3,20})(?![a-z0-9_])/gi)].map((m) => m[1].toLowerCase()))].slice(0, 10);
  const mentions = [];
  for (const username of mentionNames) {
    const target = await mongoose.connection.db.collection("user").findOne({ username: { $regex: `^${username}$`, $options: "i" } }, { projection: { _id: 1, id: 1 } });
    if (!target) continue;
    const targetId = String(target._id ?? target.id);
    if (targetId === req.user.id) continue;
    if (!await audienceAllows(req.user.id, targetId, (await privacyFor(targetId)).mentionAudience || "everyone")) throw new AppError(`@${username} does not allow mentions from your account.`, 403);
    mentions.push(targetId);
  }
  const comment = await VideoComment.create({ videoId: video._id, userId: req.user.id, text: cleanText(text, 1500), ...(parentId ? { parentId: objectId(parentId) } : {}) });
  await notify({ to: video.ownerId, from: req.user.id, type: "video_comment", entityId: video.id, title: `${req.user.username} commented on your video`, dedupeKey: `comment:${comment.id}` });
  for (const targetId of mentions) await notify({ to: targetId, from: req.user.id, type: "video_mention", entityId: video.id, title: `${req.user.username} mentioned you in a video comment`, dedupeKey: `mention:${comment.id}:${targetId}` });
  return { ...comment.toObject(), author: { id: req.user.id, name: req.user.name, username: req.user.username, image: req.user.image } };
}));
router.delete("/videos/:id/comments/:commentId", wrap(async (req) => {
  const video = await getVideo(req.user.id, req.params.id);
  const comment = await VideoComment.findOne({ _id: objectId(req.params.commentId), videoId: video._id });
  if (!comment || (comment.userId !== req.user.id && video.ownerId !== req.user.id)) throw new AppError("Comment not found or cannot delete.", 404);
  await comment.deleteOne(); return { deleted: true };
}));
export default router;
