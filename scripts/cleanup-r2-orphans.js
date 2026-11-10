import { connectDatabase } from '../src/config/database.js';
import { sweepOrphanedR2 } from '../src/media/orphanCleanup.js';
import mongoose from 'mongoose';
await connectDatabase();
try {
  const stats = await sweepOrphanedR2({ apply: process.argv.includes('--apply'), maxObjects: Number(process.env.R2_CLEANUP_BATCH || 500), minAgeHours: Number(process.env.R2_CLEANUP_MIN_AGE_HOURS || 72) });
  console.log(JSON.stringify({ ...stats, candidateKeys: stats.candidateKeys.slice(0, 20) }, null, 2));
} finally { await mongoose.disconnect(); }
