/**
 * node scripts/migrate-media-to-imagekit.js                    # dry run
 * node scripts/migrate-media-to-imagekit.js --apply --limit=50 # migrate verified existing media
 * node scripts/migrate-media-to-imagekit.js --rollback=manifest.json
 * Original local/R2 objects are RETAINED after successful migration for rollback.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { connectDatabase } from '../src/config/database.js';
import { Media } from '../src/social/models.js';
import { headPrivateObject, putPrivateObject, objectPrefix } from '../src/storage/imagekit.js';
import { mediaPath } from '../src/media/processor.js';
import { env } from '../src/config/env.js';
import mongoose from 'mongoose';

if (env.STORAGE_PROVIDER !== 'imagekit') throw new Error('Set STORAGE_PROVIDER=imagekit and your ImageKit credentials.');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rollback = args.find(x => x.startsWith('--rollback='))?.slice('--rollback='.length);
const limit = Math.max(1, Math.min(10000, Number(args.find(x => x.startsWith('--limit='))?.slice(8) || 100)));
await connectDatabase();
try {
  if (rollback) {
    const manifest = JSON.parse(await readFile(rollback, 'utf8'));
    let count = 0;
    for (const row of [...manifest.completed].reverse()) {
      const media = await Media.findById(row.id);
      if (!media || media.storageProvider !== 'imagekit' || media.storageFileId !== row.fileId) continue;
      if (row.previous.storageProvider === 'local') {
        await stat(mediaPath('processed', media.optimizedKey));
        if (media.thumbKey) await stat(mediaPath('thumbs', media.thumbKey));
      }
      // For old R2 records, retain old objects and credentials until rollback window closes.
      const { storageProvider, objectKey, thumbObjectKey, storageFileId, thumbStorageFileId, bucket } = row.previous;
      await Media.updateOne({ _id: media._id, storageFileId: row.fileId }, {
        $set: { storageProvider, objectKey: objectKey || null, thumbObjectKey: thumbObjectKey || null, bucket: bucket || null },
        $unset: { storageFileId: '', thumbStorageFileId: '' },
      });
      count++;
    }
    console.log(`Rolled back ${count} database references. ImageKit copies remain for later audit.`);
  } else {
    const rows = await Media.find({ status: 'ready', $or: [{ storageProvider: 'local' }, { storageProvider: 'cloudflare-r2' }, { storageProvider: { $exists: false } }] })
      .sort({ _id: 1 }).limit(limit).lean();
    const manifest = { createdAt: new Date().toISOString(), completed: [], failed: [], planned: [] };
    for (const row of rows) {
      let temp, tempThumb;
      try {
        const fromR2 = row.storageProvider === 'cloudflare-r2';
        const prior = { storageProvider: row.storageProvider || 'local', objectKey: row.objectKey || null, thumbObjectKey: row.thumbObjectKey || null,
          storageFileId: row.storageFileId || null, thumbStorageFileId: row.thumbStorageFileId || null, bucket: row.bucket || null };
        const originalPath = fromR2 ? null : mediaPath('processed', row.optimizedKey);
        const thumbnailPath = !fromR2 && row.thumbKey ? mediaPath('thumbs', row.thumbKey) : null;
        // Old R2 objects already contain the finalized optimized variants.
        if (fromR2 && apply) {
          const legacy = await import('../src/storage/r2.js');
          const temporary = path.resolve(process.env.MEDIA_ROOT || './storage', 'temp');
          await mkdir(temporary, { recursive: true });
          temp = path.join(temporary, `${randomUUID()}.migration`);
          await pipeline((await legacy.streamPrivateObject(row.objectKey)).Body, createWriteStream(temp));
          if (row.thumbObjectKey) {
            tempThumb = path.join(temporary, `${randomUUID()}.migration.webp`);
            await pipeline((await legacy.streamPrivateObject(row.thumbObjectKey)).Body, createWriteStream(tempThumb));
          }
        }
        const mainPath = temp || originalPath;
        const thumbPath = tempThumb || thumbnailPath;
        if (!mainPath && !apply) { manifest.planned.push({ id: String(row._id), legacyR2: true }); continue; }
        const { size } = mainPath ? await stat(mainPath) : { size: row.optimizedSize || row.size };
        const prefix = objectPrefix({ kind: row.kind, purpose: row.purpose, ownerId: row.ownerId, entityId: String(row._id) });
        const ext = (row.optimizedKey || row.objectKey || 'file.bin').split('.').at(-1);
        const mainKey = `${prefix}/${String(row._id)}-${randomUUID()}.${ext}`;
        if (!apply) { manifest.planned.push({ id: String(row._id), size, path: mainKey }); continue; }
        // Verify local optimized bytes before uploading; originals are never uploaded here.
        const hash = createHash('sha256'); for await (const chunk of createReadStream(mainPath)) hash.update(chunk);
        const checksum = hash.digest('hex');
        let uploaded;
        let thumb;
        try {
          uploaded = await putPrivateObject({ objectKey: mainKey, filename: mainPath, mime: row.mime || row.originalMime });
          const head = await headPrivateObject(uploaded.fileId);
          if (head.ContentLength !== size || head.objectKey !== uploaded.objectKey) throw new Error('ImageKit file verification mismatch.');
          if (thumbPath) {
            thumb = await putPrivateObject({ objectKey: `${prefix}/${String(row._id)}-${randomUUID()}.thumb.webp`, filename: thumbPath, mime: 'image/webp' });
            const check = await headPrivateObject(thumb.fileId);
            if (check.ContentLength !== (await stat(thumbPath)).size || check.objectKey !== thumb.objectKey) throw new Error('ImageKit thumbnail verification mismatch.');
          }
          const saved = await Media.updateOne({ _id: row._id, status: 'ready', $or: [{ storageProvider: prior.storageProvider }, { storageProvider: { $exists: false } }] }, { $set: {
            storageProvider: 'imagekit', bucket: null, objectKey: uploaded.objectKey, thumbObjectKey: thumb?.objectKey || null,
            storageFileId: uploaded.fileId, thumbStorageFileId: thumb?.fileId || null, checksum, optimizedSize: size, migratedAt: new Date(),
          } });
          if (!saved.modifiedCount) throw new Error('Record changed during migration.');
        } catch (error) {
          // Prefer a retained orphan over deleting old objects before DB commit.
          if (uploaded) { try { await (await import('../src/storage/imagekit.js')).deletePrivateObject(uploaded.fileId); } catch {} }
          if (thumb) { try { await (await import('../src/storage/imagekit.js')).deletePrivateObject(thumb.fileId); } catch {} }
          throw error;
        }
        manifest.completed.push({ id: String(row._id), fileId: uploaded.fileId, thumbFileId: thumb?.fileId || null, previous: prior });
        console.log(`Migrated media ${row._id}: ${size} optimized bytes`);
      } catch (error) {
        manifest.failed.push({ id: String(row._id), reason: error.message });
        console.error(`Skipping ${row._id}: ${error.message}`);
      } finally {
        if (temp) await rm(temp, { force: true });
        if (tempThumb) await rm(tempThumb, { force: true });
      }
    }
    const manifestFile = `media-imagekit-migration-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.json`;
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(`Manifest: ${manifestFile}; migrated=${manifest.completed.length}; failed=${manifest.failed.length}; planned=${manifest.planned.length}; apply=${apply}`);
  }
} finally { await mongoose.disconnect(); }
