/**
 * Usage:
 * node scripts/migrate-media-to-r2.js                     # read-only inventory
 * node scripts/migrate-media-to-r2.js --apply --limit=50  # upload, verify, update Mongo; retain local files
 * node scripts/migrate-media-to-r2.js --rollback=./media-migration-xxxx.json
 * Never removes original local files. Every R2 object is verified before flipping metadata.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { connectDatabase } from '../src/config/database.js';
import { Media } from '../src/social/models.js';
import { headPrivateObject, putPrivateObject, r2ObjectPrefix } from '../src/storage/r2.js';
import { mediaPath } from '../src/media/processor.js';
import { env } from '../src/config/env.js';

if (env.STORAGE_PROVIDER !== 'r2') throw new Error('Set STORAGE_PROVIDER=r2 and your R2 credentials before running migration.');
const args = process.argv.slice(2), apply = args.includes('--apply');
const rollback = args.find(x => x.startsWith('--rollback='))?.split('=').slice(1).join('=');
const limit = Math.min(10000, Math.max(1, Number(args.find(x => x.startsWith('--limit='))?.split('=')[1]) || 100));
await connectDatabase();
try {
  if (rollback) {
    const manifest = JSON.parse(await readFile(rollback, 'utf8'));
    let count = 0;
    for (const row of [...manifest.completed].reverse()) {
      const media = await Media.findById(row.id);
      if (!media || media.storageProvider !== 'cloudflare-r2' || media.objectKey !== row.objectKey) continue;
      // Original file must still be accessible before rolling back the metadata pointer.
      await stat(mediaPath('processed', media.optimizedKey));
      if (media.thumbKey) await stat(mediaPath('thumbs', media.thumbKey));
      media.storageProvider = 'local'; media.objectKey = undefined; media.thumbObjectKey = undefined; media.bucket = undefined;
      await media.save(); count++;
    }
    console.log(`Rolled back ${count} records. R2 copies remain for manual audit, not automatically deleted.`);
  } else {
    const filter = { status: 'ready', $or: [{ storageProvider: 'local' }, { storageProvider: { $exists: false } }] };
    const rows = await Media.find(filter).sort({ _id: 1 }).limit(limit).lean();
    const manifest = { startedAt: new Date().toISOString(), completed: [], skipped: [], failed: [] };
    for (const item of rows) {
      try {
        const filename = mediaPath('processed', item.optimizedKey);
        const { size } = await stat(filename);
        const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk);
        const checksum = hash.digest('hex');
        const prefix = r2ObjectPrefix({ kind: item.kind, purpose: item.purpose, ownerId: item.ownerId, entityId: String(item._id) });
        const ext = item.optimizedKey?.split('.').at(-1) || 'bin';
        const objectKey = `${prefix}/${checksum}.${ext}`;
        const thumbFilename = item.thumbKey ? mediaPath('thumbs', item.thumbKey) : null;
        const thumbObjectKey = thumbFilename ? `${prefix}/${checksum}.thumb.webp` : null;
        const thumbSize = thumbFilename ? (await stat(thumbFilename)).size : 0;
        if (apply) {
          await putPrivateObject({ objectKey, filename, mime: item.mime || item.originalMime });
          const head = await headPrivateObject(objectKey);
          if (head.ContentLength !== size) throw new Error('R2 size verification mismatch');
          if (thumbObjectKey) {
            const thumbSize = (await stat(thumbFilename)).size;
            await putPrivateObject({ objectKey: thumbObjectKey, filename: thumbFilename, mime: 'image/webp' });
            if ((await headPrivateObject(thumbObjectKey)).ContentLength !== thumbSize) throw new Error('Thumbnail verification mismatch');
          }
          const updated = await Media.updateOne({ _id: item._id, status: 'ready', storageProvider: { $in: ['local', null] } }, { $set: {
            storageProvider: 'cloudflare-r2', bucket: env.R2_BUCKET_NAME, objectKey, thumbObjectKey,
            checksum, optimizedSize: size, thumbSize, originalSize: item.originalSize || size,
            compressionRatio: item.originalSize > 0 ? Math.round(Math.max(0,1-size/item.originalSize)*1000)/10 : 0,
            migratedAt: new Date(),
          } });
          if (!updated.modifiedCount) throw new Error('Concurrent metadata change; migration did not switch media record.');
        }
        manifest.completed.push({ id: String(item._id), objectKey, bytes: size, thumbObjectKey });
        console.log(`${apply ? 'Migrated' : 'Plan'} ${item._id} ${size} bytes → ${objectKey}`);
      } catch (error) {
        manifest.failed.push({ id: String(item._id), reason: error.message });
        console.error(`Skipped ${item._id}: ${error.message}`);
      }
    }
    const file = `media-migration-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.json`;
    await writeFile(file, JSON.stringify(manifest, null, 2));
    console.log(`Manifest: ${file}; completed=${manifest.completed.length} failed=${manifest.failed.length}; apply=${apply}`);
  }
} finally {
  await (await import('mongoose')).default.disconnect();
}
