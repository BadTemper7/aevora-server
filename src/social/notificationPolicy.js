/**
 * The bell is reserved for actionable events. Ordinary messaging relies on
 * independent, persisted unread cursors, not social_notification records.
 * Keep this policy shared between writes and list/count queries so historical
 * message notifications cannot reappear after this upgrade.
 */
export const IMPORTANT_NOTIFICATION_TYPES = Object.freeze([
  'friend_request',
  'friend_accepted',
  'community_invite',
  'community_join_request',
  'community_join_response',
  'community_access_changed',
  'community_moderation_action',
  'community_event_reminder',
  'story_countdown_reminder',
  'account_security',
  'account_alert',
  'moderation_action',
]);

export const OPTIONAL_NOTIFICATION_CATEGORIES = Object.freeze({
  social: ['follow_request', 'follow_accepted', 'new_follow', 'new_subscriber'],
  content: ['new_post', 'video_new', 'video_like', 'video_comment', 'post_comment'],
  mentions: ['video_mention', 'community_mention'],
  announcements: ['community_announcement'],
});

const important = new Set(IMPORTANT_NOTIFICATION_TYPES);
const optionalByType = new Map(Object.entries(OPTIONAL_NOTIFICATION_CATEGORIES).flatMap(
  ([category, types]) => types.map(type => [type, category]),
));

export function categoryOf(type) {
  if (important.has(type)) return 'important';
  return optionalByType.get(type) || null;
}

/** Unknown types, DM/group/chat/reaction notifications, etc. are not allowed. */
export function shouldCreateNotification(type, prefs = {}) {
  const category = categoryOf(type);
  if (!category) return false;
  if (category === 'important') return true;
  return Array.isArray(prefs.enabledCategories) && prefs.enabledCategories.includes(category) &&
    !prefs.disabledCategories?.includes(type) && !prefs.disabledCategories?.includes(category);
}

export function visibleTypesFor(prefs = {}) {
  const enabled = new Set(prefs.enabledCategories || []);
  const disabled = new Set(prefs.disabledCategories || []);
  return [
    ...IMPORTANT_NOTIFICATION_TYPES,
    ...Object.entries(OPTIONAL_NOTIFICATION_CATEGORIES)
      .filter(([category]) => enabled.has(category) && !disabled.has(category))
      .flatMap(([, types]) => types.filter(type => !disabled.has(type))),
  ];
}

/** Group only non-actionable low-priority events. Requests must stay separate. */
export const shouldGroupNotification = type => type === 'friend_accepted';
export function dailyGroupKey({ userId, type, date = new Date() }) {
  return `${userId}:${type}:${date.toISOString().slice(0, 10)}`;
}
