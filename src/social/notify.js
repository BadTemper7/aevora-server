import { Block, Notification, NotificationPrefs } from './models.js';
import { emitUser } from './events.js';
import { dailyGroupKey, shouldCreateNotification, shouldGroupNotification } from './notificationPolicy.js';

function isDuplicateKey(error) { return error?.code === 11000; }

/**
 * Atomic update prevents double-counting retries. The partial unique index
 * on (userId, groupKey) handles competing concurrent first events.
 */
async function appendGroup(values, actorName) {
  const { userId, actorId, type, dedupeKey } = values;
  if (!dedupeKey) throw new Error('Grouped notification requires an event idempotency key.');
  const groupKey = dailyGroupKey({ userId, type });
  const filter = { userId, groupKey, dedupeKeys: { $ne: dedupeKey } };
  const append = {
    $inc: { groupCount: 1 },
    $addToSet: { dedupeKeys: dedupeKey, actorIds: actorId },
    $set: { readAt: null, lastEventAt: new Date() },
  };
  let notification = await Notification.findOneAndUpdate(filter, append, { new: true });
  if (notification) return notification;
  const existing = await Notification.findOne({ userId, groupKey }).select('dedupeKeys');
  if (existing) {
    if (existing.dedupeKeys?.includes(dedupeKey)) return null;
    return Notification.findOneAndUpdate(filter, append, { new: true });
  }
  try {
    return await Notification.create({ ...values, groupKey, lastEventAt: new Date(), groupCount: 1,
      groupLeadName: actorName || '', actorIds: [actorId], dedupeKeys: [dedupeKey] });
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Another event won the insert race. Add our event unless already present.
    notification = await Notification.findOneAndUpdate(filter, append, { new: true });
    return notification || null;
  }
}

/**
 * This is the only notification writer. Nonessential events are opt-in;
 * regular DM, group, community messages, replies and reactions never write
 * bell records, even if a future caller accidentally invokes notify().
 */
export async function notify({ to, from, type, entityId, title, detail = '', dedupeKey, actorName, url }) {
  if (!to || String(to) === String(from)) return null;
  if (from && !['moderation_action', 'community_access_changed', 'community_moderation_action', 'account_security', 'account_alert'].includes(type) && await Block.exists({ $or: [
    { blocker: to, blocked: from }, { blocker: from, blocked: to },
  ] })) return null;
  // No database work for types that can never enter the bell.
  if (!shouldCreateNotification(type, { enabledCategories: ['social', 'content', 'mentions', 'announcements'] })) return null;
  const prefs = await NotificationPrefs.findOne({ userId: to }).lean();
  if (!shouldCreateNotification(type, prefs || {})) return null;
  const values = {
    userId: String(to), actorId: from ? String(from) : 'system', type,
    entityId: String(entityId || ''), title, detail,
    ...(typeof url === 'string' && /^\/(?!\/)[a-z0-9/#?=&_-]*$/i.test(url) ? { url } : {}),
    ...(dedupeKey ? { dedupeKey } : {}),
  };
  let notification;
  try {
    notification = shouldGroupNotification(type)
      ? await appendGroup(values, actorName)
      : dedupeKey
        ? await Notification.findOneAndUpdate({ userId: String(to), dedupeKey },
          { $setOnInsert: values }, { upsert: true, new: true, setDefaultsOnInsert: true, includeResultMetadata: true })
        : await Notification.create(values);
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
  // On deduped upsert no notification was created and subscribers need no event.
  if (notification?.value !== undefined) {
    const inserted = !notification.lastErrorObject?.updatedExisting;
    notification = inserted ? notification.value : null;
  }
  if (!notification) return null;
  emitUser(String(to), 'notification:new', notification.toObject?.() || notification);
  return notification;
}
