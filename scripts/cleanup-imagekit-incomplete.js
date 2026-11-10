/**
 * node scripts/cleanup-imagekit-incomplete.js                # dry run
 * node scripts/cleanup-imagekit-incomplete.js --apply        # delete only stale failed upload objects
 */
import { connectDatabase } from '../src/config/database.js';
import { sweepIncompleteImageKitUploads } from '../src/media/orphanCleanup.js';
import mongoose from 'mongoose';
await connectDatabase();
try {
  const report = await sweepIncompleteImageKitUploads({
    apply: process.argv.includes('--apply'),
    maxObjects: Number(process.env.IMAGEKIT_CLEANUP_BATCH || 100),
    minAgeHours: Number(process.env.IMAGEKIT_CLEANUP_MIN_AGE_HOURS || 72),
  });
  console.log(JSON.stringify(report, null, 2));
} finally { await mongoose.disconnect(); }
