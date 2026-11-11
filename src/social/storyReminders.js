import { SocialStory, StoryStickerResponse } from './models.js';
import { notify } from './notify.js';

/** Time-bounded, idempotent countdown reminders. Runs on the existing API worker. */
export async function sendDueStoryReminders(now = new Date()) {
  const pending = await StoryStickerResponse.find({ type: 'countdown', remind: true, reminderSentAt: null, expiresAt: { $gt: now } }).limit(100).lean();
  let sent = 0;
  for (const reminder of pending) {
    const story = await SocialStory.findById(reminder.storyId).lean();
    if (!story || story.expiresAt <= now) continue;
    const layer = story.layers?.find(x => x.type === 'countdown' && x.id === reminder.stickerId);
    if (!layer || new Date(layer.endsAt) > now) continue;
    // Atomic claim across multiple API instances. Revert only if notification fails.
    const claimed = await StoryStickerResponse.findOneAndUpdate({ _id: reminder._id, remind: true, reminderSentAt: null }, { $set: { reminderSentAt: now } }, { new: true });
    if (!claimed) continue;
    try {
      await notify({ to: reminder.userId, from: story.ownerId, type: 'story_countdown_reminder', entityId: String(story._id), title: `${layer.label} is starting`, detail: 'Your AEVORA Story countdown has ended.', url: '/', dedupeKey: `story-countdown:${reminder._id}` });
      sent += 1;
    } catch (error) {
      await StoryStickerResponse.updateOne({ _id: reminder._id, reminderSentAt: now }, { $set: { reminderSentAt: null } });
      console.warn('Story countdown reminder failed:', error.message);
    }
  }
  return sent;
}
export function startStoryReminderWorker() {
  const run = () => sendDueStoryReminders().catch(error => console.warn('Story reminder worker:', error.message));
  const timer = setInterval(run, 60_000);
  timer.unref();
  run();
  return () => clearInterval(timer);
}
