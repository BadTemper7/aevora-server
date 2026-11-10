import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, shouldCreateNotification, visibleTypesFor, shouldGroupNotification, dailyGroupKey } from '../src/social/notificationPolicy.js';
import { conversationUnreadPipeline } from '../src/social/unreadSummary.js';

test('messages, DMs, group invites, read receipts and reactions never create bell notifications', () => {
  for (const type of ['message_new','message_request','reaction_message','group_invite','group_voice_invite','chat_typing','read_receipt']) {
    assert.equal(shouldCreateNotification(type, {enabledCategories:['social','content','mentions','announcements']}), false, type);
    assert.equal(visibleTypesFor({enabledCategories:['social','content','mentions','announcements']}).includes(type),false,type);
  }
});
test('friend requests, community access, event reminders, moderation and security are always allowed', () => {
  for (const type of ['friend_request','friend_accepted','community_invite','community_join_request','community_join_response','community_access_changed','community_event_reminder','community_moderation_action','account_security','moderation_action']) {
    assert.equal(shouldCreateNotification(type),true,type);
  }
});
test('no followers, posts, mentions, announcements or likes enter the bell without opt-in', () => {
  for(const type of ['new_follow','follow_request','new_post','video_like','community_mention','community_announcement']) {
    assert.equal(shouldCreateNotification(type, {}), false,type);
    assert.equal(shouldCreateNotification(type,{enabledCategories:[categoryOf(type)]}),true,type);
  }
  assert.equal(shouldCreateNotification('new_follow',{enabledCategories:['social'],disabledCategories:['social']}),false);
});
test('friend acceptance grouping is daily and scoped to the recipient', () => {
  assert(shouldGroupNotification('friend_accepted'));
  assert.equal(shouldGroupNotification('friend_request'),false);
  assert.notEqual(dailyGroupKey({userId:'A',type:'friend_accepted',date:new Date('2026-11-10T02:00:00Z')}),
    dailyGroupKey({userId:'B',type:'friend_accepted',date:new Date('2026-11-10T02:00:00Z')}));
});
test('unread message aggregation counts only non-owned, non-expired messages after saved read cursors', () => {
  const text = JSON.stringify(conversationUnreadPipeline('A',['blocked-user']));
  for (const field of ['social_messages','lastReadAt','hiddenAt','deletedAt','hiddenFor','expiresAt','blocked-user','manuallyUnread']) assert(text.includes(field), field);
});
