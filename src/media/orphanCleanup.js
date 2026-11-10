import { Media } from '../social/models.js';
import { deletePrivateObject } from '../storage/imagekit.js';
/**
 * Only process known failed ImageKit uploads; never enumerate or delete provider
 * assets that may belong to another app. Keep dry run as the default.
 */
export async function sweepIncompleteImageKitUploads({ apply = false, maxObjects = 100, minAgeHours = 72 } = {}) {
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);
  const rows = await Media.find({ storageProvider: 'imagekit', status: 'failed', updatedAt: { $lt: cutoff },
    $or: [{ storageFileId: { $exists: true } }, { thumbStorageFileId: { $exists: true } }],
  }).sort({ updatedAt: 1 }).limit(Math.min(500, Math.max(1, maxObjects))).lean();
  const report = { scanned: rows.length, candidates: [], removed: 0, failures: [] };
  for (const row of rows) {
    for (const [field, idField] of [['storageFileId','objectKey'],['thumbStorageFileId','thumbObjectKey']]) {
      const fileId = row[field];
      if (!fileId) continue;
      const referenced = await Media.exists({ _id: { $ne: row._id }, status: 'ready', $or: [{ storageFileId: fileId }, { thumbStorageFileId: fileId }] });
      if (referenced) continue;
      report.candidates.push({ mediaId: String(row._id), fileId });
      if (apply) {
        try {
          await deletePrivateObject(fileId);
          await Media.updateOne({ _id: row._id, status: 'failed', [field]: fileId }, { $unset: { [field]: '', [idField]: '' } });
          report.removed++;
        } catch (error) { report.failures.push({ mediaId: String(row._id), error: error.message }); }
      }
    }
  }
  return report;
}
