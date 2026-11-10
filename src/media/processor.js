import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../config/env.js';
import { Media, Message, Profile, Video, SocialPost, SocialStory, GifFavorite, Conversation } from '../social/models.js';
import { Community, ChannelMessage } from '../communities/models.js';
import { storageMode, putPrivateObject, deletePrivateObject, objectPrefix } from '../storage/imagekit.js';
import { maxImageWidth, percentageSaved, preferOriginal, storageMime, videoMaxHeight } from './policy.js';
import { needsStoredThumbnail } from './thumbnailPolicy.js';

export const mediaRoot = path.resolve(process.env.MEDIA_ROOT || path.join(process.cwd(), 'storage'));
export const mediaDirs = Object.fromEntries(['temp', 'originals', 'processed', 'thumbs'].map((name) => [name, path.join(mediaRoot, name)]));
export const mediaPath = (dir, key) => path.join(mediaDirs[dir], path.basename(key || ''));
export const maxImageBytes = Math.min(50, Math.max(1, Number(process.env.MAX_IMAGE_MB || 12))) * 1024 * 1024;
export const maxVideoBytes = Math.min(1024, Math.max(10, Number(process.env.MAX_VIDEO_MB || 150))) * 1024 * 1024;
export async function ensureMediaFolders() { await Promise.all(Object.values(mediaDirs).map((x) => mkdir(x, { recursive: true }))); }

const execute = (bin, args, onProgress) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '', progressBuffer = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), Number(process.env.VIDEO_PROCESS_TIMEOUT_SEC || 900) * 1000);
  child.stdout.on('data', (data) => { stdout = (stdout + String(data)).slice(-8000); });
  child.stderr.on('data', (data) => {
    const chunk = String(data); stderr = (stderr + chunk).slice(-2000);
    if (onProgress) {
      progressBuffer = (progressBuffer + chunk).slice(-2000);
      for (const match of progressBuffer.matchAll(/out_time_(?:ms|us)=(\d+)/g)) onProgress(Number(match[1])/1e6);
    }
  });
  child.on('error', (error) => { clearTimeout(timeout); reject(error); });
  child.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(`${bin} failed (${code}): ${stderr.slice(-400)}`)); });
});
const ffmpeg = (args, callback) => execute(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin','-hide_banner','-loglevel','error', ...(callback ? ['-progress','pipe:2'] : []),'-y',...args], callback);
async function probe(input) {
  const raw = await execute(process.env.FFPROBE_PATH || 'ffprobe', ['-v','error','-show_entries','format=duration:stream=codec_name,codec_type,width,height','-of','json',input]);
  return JSON.parse(raw);
}
async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function processOne(item) {
  const input = mediaPath('originals', item.originalKey);
  const processed = mediaPath('processed', `${item._id}.${item.kind === 'video' ? 'mp4' : item.kind === 'file' ? 'bin' : 'webp'}`);
  const thumbnail = mediaPath('thumbs', `${item._id}.webp`);
  let effective = processed, mime = item.originalMime, details = {}, duration = 0;
  let producedMain = false, producedThumb = false;
  let uploadedFileId = null, uploadedThumbFileId = null;
  try {
    const inputSize = (await stat(input)).size;
    // Repair uploads journaled before a worker crash. Never delete an object shared
    // by an already-ready record (same-owner deduplication).
    if (storageMode === 'imagekit' && (item.storageFileId || item.thumbStorageFileId)) {
      for (const oldId of [item.storageFileId, item.thumbStorageFileId].filter(Boolean)) {
        const referenced = await Media.exists({ _id: { $ne: item._id }, status: 'ready', $or: [{ storageFileId: oldId }, { thumbStorageFileId: oldId }] });
        if (!referenced) await deletePrivateObject(oldId);
      }
      await Media.updateOne({ _id: item._id }, { $unset: { storageFileId: '', thumbStorageFileId: '', objectKey: '', thumbObjectKey: '' } });
    }
    const sourceChecksum = await sha256File(input);
    await Media.updateOne({ _id: item._id }, { $set: { progress: 10 } });
    if (item.kind === 'file') {
      // PDFs, signed PDFs and UTF-8 text remain byte-for-byte intact. Recompress only with a signature-safe opt-in tool.
      effective = input;
    } else if (item.kind === 'video') {
      const info = await probe(input);
      duration = Number(info.format?.duration || 0);
      if (!duration || duration > env.MAX_MEDIA_DURATION_SEC) throw new Error('Video duration is invalid or exceeds the allowed limit.');
      const maxHeight = videoMaxHeight();
      const outputHeight = maxHeight;
      let lastProgress = 10;
      await ffmpeg(['-i',input,'-map','0:v:0','-map','0:a?','-vf',`scale=-2:'min(${outputHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, '-c:v','libx264','-preset',process.env.VIDEO_PRESET || 'medium','-crf',String(Number(process.env.VIDEO_CRF || 27)),'-pix_fmt','yuv420p','-c:a','aac','-b:a','112k','-movflags','+faststart',processed], seconds => {
        const next = Math.min(82, Math.floor(10 + seconds / duration * 72));
        if (next > lastProgress + 5) { lastProgress = next; Media.updateOne({ _id: item._id }, { $set: { progress: next } }).catch(console.error); }
      });
      producedMain = true;
      const streams = info.streams || [];
      const video = streams.find(x => x.codec_type === 'video');
      const audio = streams.find(x => x.codec_type === 'audio');
      // Keep an already-small compatible MP4 when transcoding would increase storage.
      if (item.originalMime === 'video/mp4' && video?.codec_name === 'h264' && (!audio || audio.codec_name === 'aac') && Number(video.height) <= maxHeight && inputSize <= (await stat(processed)).size) {
        // Remux efficiently encoded originals without losing quality; still move the MP4 moov atom up front.
        const remux = `${processed}.remux.mp4`;
        try {
          await ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', remux]);
          if ((await stat(remux)).size < (await stat(processed)).size) await rename(remux, processed);
        } catch (error) { console.warn('Faststart remux unavailable, retaining compatible transcode:', error.message); }
        finally { await rm(remux, { force: true }); }
      }
      const png = `${thumbnail}.png`;
      try {
        await ffmpeg(['-ss','0.3','-i',input,'-frames:v','1','-vf','scale=480:-2','-c:v','png',png]);
        await sharp(png).webp({ quality: 70 }).toFile(thumbnail);
      } finally { await rm(png, { force: true }); }
      producedThumb = true;
      details = { width: video?.width || null, height: video?.height || null };
    } else {
      const maxWidth = maxImageWidth(item.purpose, item.variant);
      const source = sharp(input, { animated: item.kind === 'gif', limitInputPixels: 60_000_000 });
      const info = await source.metadata();
      const result = await source.rotate().resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true }).webp({ quality: Number(process.env.IMAGE_WEBP_QUALITY || 78), effort: 5, loop: info.loop || 0 }).toFile(processed);
      producedMain = true;
      details = { width: result.width || info.width, height: result.height || info.height };
      if (preferOriginal({ originalBytes: inputSize, optimizedBytes: result.size, mime: item.originalMime, width: info.width || 0, height: info.height || 0, orientation: info.orientation || 1, maxWidth })) {
        effective = input;
        details = { width: info.width, height: info.height };
      }
      // ImageKit can resize the signed, optimized image at delivery time.
      // Do not upload a second permanent image merely for its thumbnail.
      if (needsStoredThumbnail(item.kind, storageMode)) {
        await sharp(input, { animated: false, limitInputPixels: 60_000_000 }).rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 68 }).toFile(thumbnail);
        producedThumb = true;
      }
    }
    const keepOriginal = effective === input;
    mime = storageMime(item.kind, item.originalMime, keepOriginal);
    const finalSize = (await stat(effective)).size;
    const thumbSize = producedThumb ? (await stat(thumbnail)).size : 0;
    const checksum = await sha256File(effective);
    await Media.updateOne({ _id: item._id }, { $set: { progress: 88 } });
    let objectKey = null, thumbObjectKey = null, fileId = null, thumbFileId = null, etag = null;
    if (storageMode === 'imagekit') {
      // Same owner and purpose only: never reveal or reuse someone else's private object.
      const duplicate = await Media.findOne({ _id: { $ne: item._id }, ownerId: item.ownerId, purpose: item.purpose, checksum, status: 'ready', storageProvider: 'imagekit', storageFileId: { $exists: true } }).lean();
      if (duplicate && duplicate.mime === mime && (!producedThumb || Boolean(duplicate.thumbObjectKey))) {
        // Reuse an existing main image even when older uploads have separate thumbnails.
        // A new image record needs no reference to that old physical thumbnail.
        objectKey = duplicate.objectKey;
        thumbObjectKey = producedThumb ? duplicate.thumbObjectKey : null;
        fileId = duplicate.storageFileId;
        thumbFileId = producedThumb ? duplicate.thumbStorageFileId : null;
      } else {
        const prefix = objectPrefix({ kind: item.kind, purpose: item.purpose, ownerId: item.ownerId, entityId: String(item._id) });
        const ext = mime === 'video/mp4' ? 'mp4' : mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/gif' ? 'gif' : mime === 'application/pdf' ? 'pdf' : mime === 'text/plain' ? 'txt' : 'bin';
        const uploaded = await putPrivateObject({ objectKey: `${prefix}/${checksum}-${randomUUID()}.${ext}`, filename: effective, mime });
        objectKey = uploaded.objectKey;
        fileId = uploaded.fileId;
        etag = uploaded.etag || null;
        uploadedFileId = fileId;
        // Journal cloud IDs before the next upload so failed/stale workers can clean them.
        await Media.updateOne({ _id: item._id }, { $set: { storageProvider: 'imagekit', objectKey, storageFileId: fileId } });
        if (producedThumb) {
          const thumb = await putPrivateObject({ objectKey: `${prefix}/${checksum}-${randomUUID()}.thumb.webp`, filename: thumbnail, mime: 'image/webp' });
          thumbObjectKey = thumb.objectKey;
          thumbFileId = thumb.fileId;
          uploadedThumbFileId = thumbFileId;
          await Media.updateOne({ _id: item._id }, { $set: { thumbObjectKey, thumbStorageFileId: thumbFileId } });
        }
      }
    } else if (effective === input) {
      // Local development fallback. Copy kept originals into the processed directory.
      await copyFile(input, processed); producedMain = true;
    }
    // Only publish as ready after the cloud object(s) are durably uploaded.
    await Media.updateOne({ _id: item._id }, { $set: {
      status: 'ready', storageProvider: storageMode === 'imagekit' ? 'imagekit' : 'local', bucket: null,
      objectKey, thumbObjectKey, storageFileId: fileId, thumbStorageFileId: thumbFileId, optimizedKey: path.basename(processed), thumbKey: producedThumb ? path.basename(thumbnail) : null,
      originalSize: item.originalSize || inputSize, receivedSize: inputSize, optimizedSize: finalSize, thumbSize,
      compressionRatio: percentageSaved(item.originalSize || inputSize, finalSize), checksum, sourceChecksum, contentEtag: etag,
      size: finalSize, mime, ...details, duration, progress: 100, completedAt: new Date(), error: null,
    } });
    // Cleanup cannot reverse an already committed cloud upload.
    await rm(input, { force: true }).catch(error => console.warn('Media input cleanup:', error.message));
    if (storageMode === 'imagekit') {
      if (producedMain) await rm(processed, { force: true }).catch(console.warn);
      if (producedThumb) await rm(thumbnail, { force: true }).catch(console.warn);
    }
  } catch (error) {
    // Do not mark ready or expose partially uploaded objects.
    for (const [field, key, id] of [
      ['thumbStorageFileId', 'thumbObjectKey', uploadedThumbFileId],
      ['storageFileId', 'objectKey', uploadedFileId],
    ]) if (id) {
      try {
        await deletePrivateObject(id);
        await Media.updateOne({ _id: item._id, [field]: id }, { $unset: { [field]: '', [key]: '' } });
      } catch (cleanupError) { console.warn('ImageKit upload requires cleanup', id, cleanupError.message); }
    }
    if (producedMain) await rm(processed, { force: true });
    if (producedThumb) await rm(thumbnail, { force: true });
    await Media.updateOne({ _id: item._id }, { $set: { status: 'failed', progress: 0, error: String(error.message || 'Processing failed').slice(0, 250), completedAt: new Date() } });
  }
}
let workerTimer, running = 0;
export function startMediaWorkers() {
  if (workerTimer) return;
  const maximum = Math.min(4, Math.max(1, Number(process.env.VIDEO_WORKER_CONCURRENCY || 2)));
  const poll = async () => {
    while (running < maximum) {
      const work = await Media.findOneAndUpdate({ status: 'pending', attempts: { $lt: 3 } }, { $set: { status: 'processing', progress: 0, startedAt: new Date() }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
      if (!work) break;
      running += 1;
      processOne(work).catch(error => console.error('Media processing error:', error)).finally(() => { running -= 1; });
    }
  };
  const safePoll = () => poll().catch(error => console.error('Media queue error:', error));
  Media.updateMany({ status: 'processing', startedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } }, { $set: { status: 'pending' } }).then(safePoll).catch(console.error);
  workerTimer = setInterval(safePoll, 1500); workerTimer.unref(); safePoll();
}
export async function removeMediaStorage(media) {
  if (media.storageProvider === 'imagekit') {
    for (const fileId of [media.storageFileId, media.thumbStorageFileId].filter(Boolean)) {
      // Duplicates reuse a provider file only within the same owner + purpose.
      const stillReferenced = await Media.exists({ _id: { $ne: media._id }, status: 'ready', $or: [{ storageFileId: fileId }, { thumbStorageFileId: fileId }] });
      if (!stillReferenced) await deletePrivateObject(fileId);
    }
  } else if (media.storageProvider === 'cloudflare-r2') {
    const { deletePrivateObject: legacyDelete } = await import('../storage/r2.js');
    for (const key of [media.objectKey, media.thumbObjectKey].filter(Boolean)) {
      const stillReferenced = await Media.exists({ _id: { $ne: media._id }, status: 'ready', $or: [{ objectKey: key }, { thumbObjectKey: key }] });
      if (!stillReferenced) await legacyDelete(key);
    }
  }
  for (const [folder, key] of [['originals', media.originalKey], ['processed', media.optimizedKey], ['thumbs', media.thumbKey]]) {
    if (key) await rm(mediaPath(folder, key), { force: true });
  }
}
export async function cleanupMedia() {
  await ensureMediaFolders();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const folder of ['temp', 'originals']) {
    for (const filename of await readdir(mediaDirs[folder])) {
      const p = mediaPath(folder, filename);
      if ((await stat(p)).mtimeMs >= cutoff) continue;
      if (folder === 'originals' && await Media.exists({ originalKey: filename, status: { $in: ['pending','processing'] } })) continue;
      await rm(p, { force: true });
    }
  }
  // Clear interrupted transcoding outputs without deleting active local-media originals.
  for (const folder of ['processed', 'thumbs']) {
    for (const filename of await readdir(mediaDirs[folder])) {
      const p = mediaPath(folder, filename);
      if ((await stat(p)).mtimeMs >= cutoff) continue;
      const field = folder === 'processed' ? 'optimizedKey' : 'thumbKey';
      const active = await Media.exists({ [field]: filename, status: 'ready', $or: [{ storageProvider: 'local' }, { storageProvider: { $exists: false } }] });
      const jobId = filename.match(/^([a-f0-9]{24})\./i)?.[1];
      const processing = jobId && await Media.exists({ _id: jobId, status: { $in: ['pending','processing'] } });
      if (!active && !processing) await rm(p, { force: true });
    }
  }
  const abandoned = await Media.find({ createdAt: { $lt: new Date(cutoff) }, status: { $in: ['ready','failed'] } }).limit(100).lean();
  for (const media of abandoned) {
    const [message, video, profile, post, story, community, channelMessage, conversation, favorite] = await Promise.all([
      Message.exists({ mediaIds: media._id }), Video.exists({ mediaId: media._id }), Profile.exists({ $or: [{ avatarId: String(media._id) }, { coverId: String(media._id) }] }),
      SocialPost.exists({ mediaIds: media._id }), SocialStory.exists({ mediaId: media._id, expiresAt: { $gt: new Date() } }),
      Community.exists({ $or: [{ iconId: String(media._id) }, { bannerId: String(media._id) }] }), ChannelMessage.exists({ mediaIds: media._id }),
      Conversation.exists({ avatarId: String(media._id) }), GifFavorite.exists({ mediaId: media._id }),
    ]);
    if ([message, video, profile, post, story, community, channelMessage, conversation, favorite].some(Boolean)) continue;
    // Preserve records if any deletion or API call is still using the media reference.
    // If ImageKit deletion fails, retain the metadata so a later cleanup can retry.
    await removeMediaStorage(media);
    await Media.deleteOne({ _id: media._id });
  }
}
