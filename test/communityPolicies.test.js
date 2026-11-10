import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePermissions, HIERARCHY, need, PERMISSIONS, ROLE_PERMISSIONS, hierarchyCheck } from '../src/communities/permissions.js';
import { Community, CommunityMember, CommunityInvitation, CommunityChannel, ChannelMessage, ChannelReaction, ChannelPollVote, CommunityRSVP, QuickVoiceRoom } from '../src/communities/models.js';

test('owner has all supported permissions', () => {
  assert.deepEqual([...derivePermissions('owner')].sort(), [...PERMISSIONS].sort());
  assert.equal(derivePermissions('member').has('ban_members'), false);
  assert.equal(derivePermissions('guest').has('send_messages'), false);
});
test('channel overrides have deny precedence and no owner suppression', () => {
  const member=derivePermissions('member',['manage_events'], [{allow:['manage_channels'],deny:['send_messages','manage_events']}]);
  assert.equal(member.has('manage_channels'), true);
  assert.equal(member.has('send_messages'), false);
  assert.equal(member.has('manage_events'), false);
  const owner=derivePermissions('owner', [], [{deny:PERMISSIONS}]);
  assert.equal(owner.has('send_messages'), true);
});
test('role escalation cannot be granted through unsupported keys', () => {
  const user=derivePermissions('member',['delete_all_users','manage_messages']);
  assert.equal(user.has('manage_messages'), true);
  assert.equal(user.has('delete_all_users'), false);
  assert(HIERARCHY.owner>HIERARCHY.admin && HIERARCHY.admin>HIERARCHY.moderator);
  assert.throws(()=>hierarchyCheck({role:'moderator'},{role:'admin'}));
  assert.doesNotThrow(()=>hierarchyCheck({role:'admin'},{role:'member'}));
});
test('authorization prevents changes in archived communities', () => {
  const allowed={permissions:new Set(['manage_channels']),community:{archivedAt:null}};
  assert.doesNotThrow(()=>need(allowed,'manage_channels'));
  assert.throws(()=>need({...allowed,community:{archivedAt:new Date()}},'manage_channels'));
  assert.throws(()=>need(allowed,'ban_members'));
});
test('memberships and client message IDs have unique database indexes', () => {
  const unique=(model,predicate)=>model.schema.indexes().some(([keys,opts])=>opts.unique===true && predicate(keys));
  assert(unique(CommunityMember,keys=>keys.communityId===1&&keys.userId===1));
  assert(unique(ChannelMessage,keys=>keys.channelId===1&&keys.senderId===1&&keys.clientId===1));
  assert(unique(ChannelReaction,keys=>keys.messageId===1&&keys.userId===1));
  assert(unique(ChannelPollVote,keys=>keys.pollId===1&&keys.userId===1));
  assert(unique(CommunityRSVP,keys=>keys.eventId===1&&keys.userId===1));
  assert(unique(CommunityInvitation,keys=>keys.tokenHash===1));
});
test('community channels include all six communication types', () => {
  const types=CommunityChannel.schema.path('type').enumValues;
  assert.deepEqual(types.slice().sort(),['text','voice','video','announcement','forum','stage'].sort());
  assert.equal(Community.schema.path('memberCount').defaultValue,1);
});
test('temporary voice room records expire automatically', () => {
  assert(QuickVoiceRoom.schema.indexes().some(([keys,opts])=>keys.expiresAt===1&&opts.expireAfterSeconds===0));
});
