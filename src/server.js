import { createServer } from "node:http";
import { createApp } from "./app.js";
import { connectDatabase } from "./config/database.js";
import { env } from "./config/env.js";
import { createAuth } from "./lib/auth.js";
import { attachSockets } from "./realtime/socketServer.js";
import { cleanupMedia, ensureMediaFolders, startMediaWorkers } from "./media/processor.js";
import { startStoryReminderWorker } from "./social/storyReminders.js";
import { startEventWorker } from "./social/eventWorker.js";
import { sweepIncompleteImageKitUploads } from './media/orphanCleanup.js';
import { startCommunityEventReminders } from "./communities/eventRoutes.js";

await connectDatabase();
await ensureMediaFolders();
const auth = createAuth();
const server = createServer(createApp(auth));
attachSockets(server, auth);
startMediaWorkers();
startEventWorker();
startStoryReminderWorker();
startCommunityEventReminders();
cleanupMedia().catch((error) => console.warn("Media cleanup:", error.message));
const cleanupTimer = setInterval(() => cleanupMedia().catch(console.error), 24 * 60 * 60 * 1000);
cleanupTimer.unref();
// Opt in after inspecting a dry-run report. Only stale failed-upload objects are eligible.
if (process.env.IMAGEKIT_CLEANUP_ENABLED === 'true' && env.STORAGE_PROVIDER === 'imagekit') {
  const sweepTimer = setInterval(() => sweepIncompleteImageKitUploads({ apply: true, maxObjects: Number(process.env.IMAGEKIT_CLEANUP_BATCH || 100), minAgeHours: Number(process.env.IMAGEKIT_CLEANUP_MIN_AGE_HOURS || 72) }).catch(error => console.warn('ImageKit cleanup:', error.message)), 24 * 60 * 60 * 1000);
  sweepTimer.unref();
}
server.listen(env.PORT, () => console.log(`Aevora API + sockets ready on http://localhost:${env.PORT}`));
