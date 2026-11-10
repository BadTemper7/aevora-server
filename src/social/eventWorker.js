import { EventJob, Follow, SocialPost, Subscription, Video } from "./models.js";
import { canSeeVideo } from "./helpers.js";
import { canSeePost } from "./feedRules.js";
import { emitUser } from "./events.js";
import { notify } from "./notify.js";

let timer, working = false;
export function startEventWorker() {
  if (timer) return;
  const tick = async () => {
    if (working) return;
    working = true;
    try {
      const job = await EventJob.findOneAndUpdate({ status: "pending", attempts: { $lt: 5 } }, { $set: { status: "processing", startedAt: new Date() }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
      if (!job) return;
      try {
        if (job.type === "post_published") {
          const post = await SocialPost.findById(job.entityId).lean();
          if (post && post.visibility !== "private") {
            const followers = await Follow.find({ target: job.ownerId, status: "accepted", notificationsEnabled: true }).select("follower").lean();
            for (const follower of followers) if (await canSeePost(follower.follower, post)) {
              await notify({ to: follower.follower, from: job.ownerId, type: "new_post", entityId: job.entityId, title: "Someone you follow shared a new post", dedupeKey: `post:${job.entityId}:${follower.follower}` });
              emitUser(follower.follower, "feed:new", { postId: job.entityId });
            }
          }
        } else if (job.type === "video_published") {
          const video = await Video.findById(job.entityId).lean();
          if (video && video.visibility !== "private") {
            const subs = await Subscription.find({ creator: job.ownerId, notificationsEnabled: true }).select("subscriber").lean();
            const followers = await Follow.find({ target: job.ownerId, status: "accepted", notificationsEnabled: true }).select("follower").lean();
            const targets = new Set([...subs.map((x) => x.subscriber), ...followers.map((x) => x.follower)]);
            for (const target of targets) if (await canSeeVideo(target, video)) {
              await notify({ to: target, from: job.ownerId, type: "video_new", entityId: job.entityId, title: "A creator you follow uploaded a new video", detail: video.title, dedupeKey: `video:${job.entityId}:${target}` });
            }
          }
        }
        job.status = "done"; job.finishedAt = new Date(); await job.save();
      } catch (error) {
        console.warn("Social notification job failed:", error.message);
        job.status = job.attempts >= 5 ? "failed" : "pending";
        job.lastError = error.message.slice(0, 200); await job.save();
      }
    } finally { working = false; }
  };
  EventJob.updateMany({ status: "processing", startedAt: { $lt: new Date(Date.now()-15*60*1000) } }, { $set: { status: "pending" } }).catch(console.error);
  timer = setInterval(()=>tick().catch(console.error), 2000); timer.unref();
  tick().catch(console.error);
}
