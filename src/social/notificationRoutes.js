import { Router } from 'express';
import { z } from 'zod';
import { Notification, NotificationPrefs } from './models.js';
import { body, wrap } from './routeUtils.js';
import { limitValue, objectId, usersByIds } from './helpers.js';
import { OPTIONAL_NOTIFICATION_CATEGORIES, visibleTypesFor } from './notificationPolicy.js';
import { emitUser } from './events.js';

const router = Router();
const countFilter = (userId, prefs) => ({ userId, type: { $in: visibleTypesFor(prefs) } });
const prefFor = async userId => await NotificationPrefs.findOne({ userId }).lean() || {};
const serialize = item => ({ ...item,
  title: item.type === 'friend_accepted' && item.groupCount > 1
    ? `${item.groupLeadName || 'A friend'} and ${item.groupCount - 1} ${item.groupCount === 2 ? 'other' : 'others'} accepted your friend requests`
    : item.title,
});

// This lightweight endpoint can be used by the bell without fetching the list.
router.get('/notifications/unread-count', wrap(async req => {
  const filter = countFilter(req.user.id, await prefFor(req.user.id));
  return { unread: await Notification.countDocuments({ ...filter, readAt: null }) };
}));

router.get('/notifications', wrap(async req => {
  const count = limitValue(req.query.limit, 20);
  const prefs = await prefFor(req.user.id);
  const filter = countFilter(req.user.id, prefs);
  if (req.query.before) filter._id = { $lt: objectId(String(req.query.before)) };
  // One extra row indicates a next page without requesting an entire history.
  const entries = await Notification.find(filter).sort({ _id: -1 }).limit(count + 1).lean();
  const hasNext = entries.length > count;
  const items = entries.slice(0, count);
  const actors = await usersByIds(items.map(item => item.actorId).filter(Boolean));
  const unread = await Notification.countDocuments({ ...countFilter(req.user.id, prefs), readAt: null });
  return { items: items.map(item => ({ ...serialize(item), actor: actors.get(item.actorId) || null })), unread,
    nextCursor: hasNext ? String(items.at(-1)._id) : null };
}));

router.post('/notifications/read-all', wrap(async req => {
  const filter = countFilter(req.user.id, await prefFor(req.user.id));
  const result = await Notification.updateMany({ ...filter, readAt: null }, { $set: { readAt: new Date() } });
  emitUser(req.user.id, 'notification:updated', { unread: 0, all: true });
  return { ok: true, changed: result.modifiedCount };
}));
router.patch('/notifications/:id/read', wrap(async req => {
  const filter = countFilter(req.user.id, await prefFor(req.user.id));
  const result = await Notification.updateOne({ ...filter, _id: objectId(req.params.id), readAt: null }, { $set: { readAt: new Date() } });
  if (result.modifiedCount) emitUser(req.user.id, 'notification:updated', { readId: req.params.id });
  return { ok: true, changed: result.modifiedCount };
}));
router.delete('/notifications/:id', wrap(async req => {
  const result = await Notification.deleteOne({ _id: objectId(req.params.id), userId: req.user.id });
  if (result.deletedCount) emitUser(req.user.id, 'notification:updated', {});
  return { ok: true };
}));
router.get('/notification-preferences', wrap(async req => {
  const prefs = await prefFor(req.user.id);
  return { enabledCategories: prefs.enabledCategories || [],
    disabledCategories: prefs.disabledCategories || [], browserPush: prefs.browserPush || false };
}));
router.patch('/notification-preferences', wrap(async req => {
  const keys = Object.keys(OPTIONAL_NOTIFICATION_CATEGORIES);
  const input = body(req, z.object({
    enabledCategories: z.array(z.enum(keys)).max(keys.length).optional(),
    disabledCategories: z.array(z.string().max(64)).max(15).optional(),
    browserPush: z.boolean().optional(),
  }).strict());
  const saved = await NotificationPrefs.findOneAndUpdate({ userId: req.user.id },
    { $set: input }, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }).lean();
  emitUser(req.user.id, 'notification:updated', {});
  return saved;
}));
export default router;
