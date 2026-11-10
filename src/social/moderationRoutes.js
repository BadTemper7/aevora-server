import { Router } from "express";
import { z } from "zod";
import { authorize } from "../middleware/authorize.js";
import { Report, Message, Video, Conversation } from "./models.js";
import { canSeeVideo, requireUser } from "./helpers.js";
import { AppError } from "../utils/AppError.js";
import { objectId } from "./helpers.js";
import { body, wrap } from "./routeUtils.js";
const router = Router();
router.post("/reports", wrap(async (req) => {
  const data = body(req, z.object({ targetType: z.enum(["user", "message", "video", "conversation"]), targetId: z.string().min(1).max(130), reason: z.string().trim().min(8).max(300), description: z.string().trim().max(1000).optional(), messageIds: z.array(z.string()).max(5).optional() }).strict());
  if (data.targetType === "user") {
    if (data.targetId === req.user.id) throw new AppError("You cannot report yourself.", 400);
    await requireUser(data.targetId);
  }
  if (data.targetType === "video") {
    const video = await Video.findById(objectId(data.targetId)).lean();
    if (!video || !await canSeeVideo(req.user.id, video)) throw new AppError("Video unavailable.", 404);
  }
  let evidence;
  if (data.targetType === "message" || data.targetType === "conversation") {
    const message = data.targetType === "message" ? await Message.findById(objectId(data.targetId)).lean() : null;
    if (data.targetType === "message" && !message) throw new AppError("Message unavailable.", 404);
    const c = await Conversation.findById(data.targetType === "message" ? message.conversationId : objectId(data.targetId));
    if (!c?.members.some(m => m.userId === req.user.id && m.requestState !== "rejected" && (c.type === "direct" || m.accepted))) throw new AppError("Conversation unavailable.", 404);
    const evidenceIds = [...new Set([...(message ? [String(message._id)] : []), ...(data.messageIds || [])])].slice(0, 5).map(objectId);
    const evidenceRows = evidenceIds.length ? await Message.find({ _id: { $in: evidenceIds }, conversationId: c._id, hiddenFor: { $ne: req.user.id } }).select("_id text senderId createdAt").lean() : [];
    evidence = { text: (message?.text || "").slice(0, 1000), senderId: message?.senderId, capturedAt: new Date(), messages: evidenceRows.map((row) => ({ messageId: String(row._id), text: String(row.text || "").slice(0, 1000), senderId: row.senderId, createdAt: row.createdAt })) };
  }
  const { messageIds: _ignored, ...saved } = data;
  const doc = await Report.create({ ...saved, ...(evidence ? { evidence } : {}), reporterId: req.user.id }); return { id: doc.id, status: doc.status };
}));
router.get("/moderation/reports", authorize("admin", "moderator"), wrap(async (req) => {
  const status = ["open", "reviewing", "resolved", "dismissed"].includes(req.query.status) ? req.query.status : "open";
  return Report.find({ status }).sort({ createdAt: -1 }).limit(100).lean();
}));
router.patch("/moderation/reports/:id", authorize("admin", "moderator"), wrap(async (req) => {
  const data = body(req, z.object({ status: z.enum(["reviewing", "resolved", "dismissed"]), moderatorNote: z.string().max(1000).optional() }));
  return Report.findByIdAndUpdate(objectId(req.params.id), { ...data, moderatorId: req.user.id, ...(data.status !== "reviewing" ? { resolvedAt: new Date() } : {}) }, { new: true }).lean();
}));
export default router;
