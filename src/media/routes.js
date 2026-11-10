import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { fileTypeFromFile } from "file-type";
import { AppError } from "../utils/AppError.js";
import { canSeeVideo, objectId, privacyFor, audienceAllows, blocked } from "../social/helpers.js";
import { Conversation, Media, Message, Profile, Video, SocialPost, SocialStory } from "../social/models.js";
import { canSeePost, canSeeStory } from "../social/feedRules.js";
import { Community, CommunityMember, ChannelMessage } from "../communities/models.js";
import { channelContext } from "../communities/permissions.js";
import { wrap } from "../social/routeUtils.js";
import { uploadRateLimiter } from "../social/rateLimit.js";
import { ensureMediaFolders, maxImageBytes, maxVideoBytes, mediaDirs, mediaPath, removeMediaStorage, mediaRoot } from './processor.js';
import { streamPrivateObject, signedPrivateDownload, storageMode } from '../storage/imagekit.js';
import { env } from '../config/env.js';
import { scanUploadedFile } from './scan.js';
import { isDynamicImageThumbnail } from './thumbnailPolicy.js';

const router = Router();
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "application/pdf": "pdf", "text/plain": "txt" };
const maxDocumentBytes = Math.min(25, Math.max(1, Number(process.env.MAX_DOCUMENT_MB || 12))) * 1024 * 1024;
const uploader = multer({ storage: multer.diskStorage({ destination: (_req, _file, done) => done(null, mediaDirs.temp), filename: (_req, _file, done) => done(null, randomUUID()) }), limits: { files: 1, fileSize: maxVideoBytes }, fileFilter: (_req, file, done) => {
  if (file.originalname.length > 255) return done(new AppError("File name is too long.", 400));
  done(null, true);
} });
function uploadFile(req, res, next) { uploader.single("file")(req, res, (error) => error ? next(new AppError(error.message || "Upload rejected.", 400)) : next()); }

let inFlight = 0;
router.post("/media", uploadRateLimiter, async (req, res, next) => {
  let released = false;
  const release = () => { if (!released) { released = true; inFlight = Math.max(0, inFlight - 1); } };
  if (inFlight >= Math.min(16, Math.max(1, Number(process.env.MAX_CONCURRENT_UPLOADS || 4)))) return next(new AppError('Too many uploads are processing. Try again shortly.', 429));
  inFlight++;
  res.once('close', release);
  res.once('finish', release);
  try {
    await ensureMediaFolders();
    const disk = await statfs(mediaRoot);
    if (disk.bavail * disk.bsize < (Number(process.env.MIN_TEMP_FREE_MB || 512) * 1024 * 1024) + maxVideoBytes) throw new AppError('Insufficient temporary disk capacity. Try again later.', 503);
    uploadFile(req, res, next);
  } catch (error) { release(); next(error); }
}, wrap(async (req) => {
  const file = req.file;
  if (!file) throw new AppError("Select a file to upload.", 400);
  const purpose = req.body?.purpose;
  try {
    if (!["message", "video", "avatar", "cover", "post", "story", "community"].includes(purpose)) throw new AppError("Invalid upload purpose.", 400);
    const type = await fileTypeFromFile(file.path);
    let actual = type?.mime;
    if (!actual && /\.txt$/i.test(file.originalname) && file.size <= maxDocumentBytes) {
      // Plain text has no magic bytes. Decode strictly, reject binary content and NUL bytes.
      const bytes = await readFile(file.path);
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (bytes.includes(0)) throw new Error("Binary content"); actual = "text/plain"; }
      catch { throw new AppError("This text file is not valid UTF-8 plain text.", 415); }
    }
    if (!actual || !extensions[actual]) throw new AppError("Unsupported file content. Use images, video, GIF, PDF, or UTF-8 TXT.", 415);
    const kind = ["application/pdf", "text/plain"].includes(actual) ? "file" : actual === "image/gif" ? "gif" : actual.startsWith("video/") ? "video" : "image";
    if (kind === "file" && (!["message", "community"].includes(purpose) || file.size > maxDocumentBytes)) throw new AppError("Documents are limited to chat uploads up to 12 MB.", 413);
    if (purpose === "video" && kind !== "video" || ["avatar", "cover", "post"].includes(purpose) && kind === "video") throw new AppError("File type does not match its intended use.", 400);
    if (file.size > (kind === "video" ? maxVideoBytes : kind === "file" ? maxDocumentBytes : maxImageBytes)) throw new AppError("File exceeds the configured size limit.", 413);
    // ImageKit permanent files are never uploaded before validation and optimization.
    const activeBytes = await Media.aggregate([
      { $match: { ownerId: req.user.id, status: { $in: ['ready','pending','processing'] } } },
      { $project: { key: { $ifNull: ['$objectKey', '$_id'] }, bytes: { $cond: [{ $eq: ['$status', 'ready'] }, { $add: [{ $ifNull: ['$optimizedSize', '$size'] }, { $ifNull: ['$thumbSize', 0] }] }, { $ifNull: ['$receivedSize', '$size'] }] } } },
      { $group: { _id: '$key', bytes: { $max: '$bytes' } } },
      { $group: { _id: null, bytes: { $sum: '$bytes' } } },
    ]);
    if ((activeBytes[0]?.bytes || 0) + file.size > env.MAX_USER_STORAGE_MB * 1024 * 1024) throw new AppError('Storage quota reached. Remove old uploads before adding more.', 413);
    await scanUploadedFile(file.path);
    const key = `${randomUUID()}.${extensions[actual]}`;
    await rename(file.path, mediaPath('originals', key));
    try {
      const variant = purpose === 'community' && ['icon','banner'].includes(req.body?.variant) ? req.body.variant : null;
      const reportedSize = Math.max(file.size, Math.min(maxVideoBytes, Number(req.body?.sourceOriginalSize) || file.size));
      const item = await Media.create({ ownerId: req.user.id, originalName: path.basename(String(req.body?.originalName || file.originalname)).slice(0, 255), originalMime: actual, kind,
        originalKey: key, status: 'pending', progress: 0, purpose, size: file.size, receivedSize: file.size, originalSize: reportedSize,
        storageProvider: storageMode === 'imagekit' ? 'imagekit' : 'local', variant });
      return { id: item.id, status: item.status, kind: item.kind, originalName: item.originalName };
    } catch (error) { await rm(mediaPath('originals', key), { force: true }); throw error; }
  } finally { await rm(file.path, { force: true }); }
}));

router.get("/media/:id/status", wrap(async (req) => {
  const item = await Media.findOne({ _id: objectId(req.params.id), ownerId: req.user.id }).lean();
  if (!item) throw new AppError("Media upload not found.", 404);
  return { id: String(item._id), status: item.status, kind: item.kind, progress: item.progress || 0, error: item.status === 'failed' ? item.error : null,
    size: item.status === 'ready' ? item.size : null, originalSize: item.originalSize || null,
    optimizedSize: item.status === 'ready' ? item.optimizedSize || item.size : null,
    savingsPercent: item.status === 'ready' ? item.compressionRatio || 0 : null };
}));
router.post("/media/:id/retry", wrap(async (req) => {
  const item = await Media.findOneAndUpdate({ _id: objectId(req.params.id), ownerId: req.user.id, status: "failed", attempts: { $lt: 3 } }, { $set: { status: "pending", error: null } }, { new: true });
  if (!item) throw new AppError("Upload is not eligible for retry.", 409);
  return { id: item.id, status: item.status };
}));

async function authorizeMedia(req, media) {
  // Owners can preview their own uploads; other viewers require a live message
  // or an appropriately visible post, story or video referencing the asset.
  if (req.user.id === media.ownerId) return true;
  if (media.purpose === "community") {
    const spaces = await Community.find({ $or: [{ iconId: String(media._id) }, { bannerId: String(media._id) }], deletedAt: null }).lean();
    for (const space of spaces) {
      if (space.visibility === "public" || await CommunityMember.exists({ communityId: space._id, userId: req.user.id, status: "active" })) return true;
    }
    const messages = await ChannelMessage.find({ mediaIds: media._id, deletedAt: null }).limit(20).lean();
    for (const message of messages) {
      try { await channelContext(String(message.channelId), req.user.id, "view_channels"); return true; }
      catch { /* another channel may be accessible */ }
    }
    return false;
  }
  // The existing My GIFs picker stores uploads with purpose=message. A GIF
  // reused inside a community must still be viewable by channel members.
  if (media.purpose === "message" && media.kind === "gif") {
    const communityMessages = await ChannelMessage.find({ mediaIds: media._id, deletedAt: null }).limit(20).lean();
    for (const communityMessage of communityMessages) {
      try { await channelContext(String(communityMessage.channelId), req.user.id, "view_channels"); return true; }
      catch { /* This viewer may not have access to every channel. */ }
    }
  }
  if (media.purpose === "message") {
    const message = await Message.findOne({ mediaIds: media._id }).lean();
    if (!message || message.deletedAt || message.hiddenFor?.includes(req.user.id) || (message.expiresAt && message.expiresAt <= new Date())) return false;
    const conversation = await Conversation.findById(message.conversationId).lean();
    const viewer = conversation?.members.find((m) => m.userId === req.user.id);
    if (!viewer || viewer.requestState === "rejected" || (conversation.type === "group" && !viewer.accepted)) return false;
    if (await blocked(req.user.id, message.senderId)) return false;
    return true;
  }
  if (media.purpose === "video") {
    const videos = await Video.find({ mediaId: media._id }).lean();
    for (const video of videos) if (await canSeeVideo(req.user.id, video)) return true;
    return false;
  }
  if (media.purpose === "post") {
    const posts = await SocialPost.find({ mediaIds: media._id }).lean();
    for (const post of posts) if (await canSeePost(req.user.id, post)) return true;
    return false;
  }
  if (media.purpose === "story") {
    const stories = await SocialStory.find({ mediaId: media._id, expiresAt: { $gt: new Date() } }).lean();
    for (const story of stories) if (await canSeeStory(req.user.id, story)) return true;
    return false;
  }
  if (["avatar", "cover"].includes(media.purpose)) {
    const p = await Profile.findOne({ [media.purpose === "avatar" ? "avatarId" : "coverId"]: String(media._id) }).lean();
    if (p && await audienceAllows(req.user.id, p.userId, (await privacyFor(p.userId)).profileVisibility)) return true;
    const c = await Conversation.findOne({ avatarId: String(media._id), "members.userId": req.user.id });
    return Boolean(c);
  }
  return false;
}

router.get("/media/:id/file", async (req, res, next) => {
  try {
    const media = await Media.findById(objectId(req.params.id)).lean();
    if (!media || media.status !== "ready") throw new AppError("Media is not ready.", 404);
    if (!await authorizeMedia(req, media)) throw new AppError("You are not allowed to view this media.", 403);
    const thumbnail = req.query.thumb === "1";
    const dynamicThumbnail = thumbnail && isDynamicImageThumbnail(media);
    if (thumbnail && !media.thumbKey && !media.thumbObjectKey && !dynamicThumbnail) throw new AppError('Thumbnail is not available.', 404);
    const key = thumbnail && !dynamicThumbnail ? media.thumbKey : media.optimizedKey;
    if (!key && !media.objectKey) throw new AppError("Media file is not available.", 404);
    const mime = thumbnail ? 'image/webp' : media.mime;
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (media.kind === 'file') {
      const safeName = String(media.originalName || 'attachment').replace(/[\\\r\n";\/]/g, '_').slice(0, 120);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Security-Policy', 'sandbox');
    }
    res.setHeader('Accept-Ranges', 'bytes');
    if (['imagekit', 'cloudflare-r2'].includes(media.storageProvider) && media.objectKey) {
      const objectKey = thumbnail ? (media.thumbObjectKey || (dynamicThumbnail ? media.objectKey : null)) : media.objectKey;
      if (!objectKey) throw new AppError('Media thumbnail not found.', 404);
      const range = !thumbnail && mime.startsWith('video/') ? req.headers.range : null;
      if (range && !/^bytes=\d*-\d*$/.test(range)) { res.status(416).end(); return; }
      const stream = media.storageProvider === 'imagekit'
        ? await streamPrivateObject(objectKey, range, dynamicThumbnail)
        : await (await import('../storage/r2.js')).streamPrivateObject(objectKey, range);
      // Upstream may ignore Range; never falsely report 206 without an upstream Content-Range.
      if (stream.ContentRange) { res.status(206); res.setHeader('Content-Range', stream.ContentRange); }
      if (stream.ContentLength !== undefined) res.setHeader('Content-Length', stream.ContentLength);
      const body = stream.Body;
      if (!body?.pipe) throw new AppError('Cloud media stream is unavailable.', 502);
      body.on('error', next);
      req.on('close', () => { if (!res.writableFinished) body.destroy(); });
      body.pipe(res);
    } else {
      // Transparent fallback for existing local media and development mode.
      const filename = mediaPath(thumbnail ? 'thumbs' : 'processed', key);
      const { size } = await stat(filename);
      if (req.headers.range && !thumbnail && mime.startsWith('video/')) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match) { res.status(416).end(); return; }
        const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
        const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.status(416).end(); return; }
        res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        createReadStream(filename, { start, end }).pipe(res);
      } else { res.setHeader('Content-Length', size); createReadStream(filename).pipe(res); }
    }
  } catch (error) { next(error); }
});
router.get('/media/:id/signed-url', wrap(async (req) => {
  const media = await Media.findById(objectId(req.params.id)).lean();
  if (!media || media.status !== 'ready') throw new AppError('Media not found.', 404);
  if (!await authorizeMedia(req, media)) throw new AppError('Not authorized.', 403);
  if (!['imagekit', 'cloudflare-r2'].includes(media.storageProvider)) throw new AppError('Only cloud media supports signed URLs.', 409);
  const thumb = req.query.thumb === '1';
  const dynamicThumbnail = thumb && isDynamicImageThumbnail(media);
  const key = thumb ? (media.thumbObjectKey || (dynamicThumbnail ? media.objectKey : null)) : media.objectKey;
  if (!key) throw new AppError('Media variant is missing.', 404);
  return { url: media.storageProvider === 'imagekit' ? await signedPrivateDownload(key, 60, dynamicThumbnail) : await (await import('../storage/r2.js')).signedPrivateDownload(key, 60), expiresIn: 60 };
}));
router.get('/media/storage/me', wrap(async (req) => {
  const rows = await Media.aggregate([
    { $match: { ownerId: req.user.id, status: 'ready' } },
    { $group: { _id: '$kind', count: { $sum: 1 }, bytes: { $sum: { $add: [{ $ifNull: ['$optimizedSize', '$size'] }, { $ifNull: ['$thumbSize', 0] }] } }, originalBytes: { $sum: '$originalSize' } } },
  ]);
  return { quotaBytes: env.MAX_USER_STORAGE_MB * 1024 * 1024, categories: rows, usedBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    totalSavedBytes: rows.reduce((sum, row) => sum + Math.max(0, row.originalBytes - row.bytes), 0) };
}));
router.delete("/media/:id", wrap(async (req) => {
  const id = objectId(req.params.id);
  const item = await Media.findOne({ _id: id, ownerId: req.user.id });
  if (!item) throw new AppError("Media not found.", 404);
  const attached = await Promise.all([Message.exists({ mediaIds: id }), Video.exists({ mediaId: id }), SocialPost.exists({ mediaIds: id }), SocialStory.exists({ mediaId: id }), Profile.exists({ $or: [{ avatarId: String(id) }, { coverId: String(id) }] }), ChannelMessage.exists({ mediaIds: id }), Community.exists({ $or: [{ iconId: String(id) }, { bannerId: String(id) }] })]);
  if (attached.some(Boolean)) throw new AppError("This media is in use.", 409);
  if (item.status === 'processing' || item.status === 'pending') throw new AppError('Please wait until processing finishes before deleting this upload.', 409);
  await removeMediaStorage(item);
  await Media.deleteOne({ _id: id });
  return { deleted: true };
}));
export default router;
