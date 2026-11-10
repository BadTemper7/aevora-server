import { AppError } from '../utils/AppError.js';
import { objectId, blocked, privacyFor, isFriend } from '../social/helpers.js';
import { Community, CommunityBan, CommunityChannel, CommunityMember, CommunityRole } from './models.js';
export const PERMISSIONS = Object.freeze([
  'view_channels','send_messages','manage_messages','create_threads','upload_attachments',
  'add_reactions','mention_roles','create_invitations','manage_invitations','manage_channels',
  'manage_roles','connect_voice','speak','camera','share_screen','mute_members',
  'manage_events','kick_members','ban_members','manage_community','moderate_reports',
]);
export const ROLE_PERMISSIONS = Object.freeze({
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter(p=>p !== 'manage_community'),
  moderator: ['view_channels','send_messages','manage_messages','create_threads','upload_attachments','add_reactions','create_invitations','manage_invitations','connect_voice','speak','camera','share_screen','mute_members','manage_events','kick_members','moderate_reports'],
  member: ['view_channels','send_messages','create_threads','upload_attachments','add_reactions','create_invitations','connect_voice','speak','camera','share_screen'],
  guest: ['view_channels','add_reactions','connect_voice'],
});
export const HIERARCHY = Object.freeze({ owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 });
export function derivePermissions(role, custom = [], overrides = []) {
  if (role === 'owner') return new Set(PERMISSIONS);
  const allowed = new Set([...(ROLE_PERMISSIONS[role] || []), ...custom.filter(v=>PERMISSIONS.includes(v))]);
  // Deny takes precedence over allow, with explicit channel overrides.
  for (const o of overrides) {
    for (const p of o.allow || []) if (PERMISSIONS.includes(p)) allowed.add(p);
    for (const p of o.deny || []) allowed.delete(p);
  }
  return allowed;
}
export async function communityContext(communityId, userId, { allowNonMember = false } = {}) {
  const community = await Community.findById(objectId(communityId)).lean();
  if (!community || community.deletedAt) throw new AppError('Community not found.', 404);
  const member = await CommunityMember.findOne({ communityId: community._id, userId, status: 'active' }).lean();
  const activeBan = await CommunityBan.exists({ communityId: community._id, userId, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
  if (activeBan) throw new AppError('You are banned from this community.', 403);
  if (!member && !(allowNonMember && ['public','private'].includes(community.visibility))) throw new AppError('Join this community to continue.', 403);
  const roleDocs = member?.roleIds?.length ? await CommunityRole.find({ _id: { $in: member.roleIds }, communityId: community._id }).lean() : [];
  const custom = roleDocs.flatMap(r=>r.permissions);
  if (member?.role === 'owner') custom.push(...PERMISSIONS);
  const permissions = derivePermissions(member?.role, custom);
  return { community, member, permissions, roleDocs };
}
export async function channelContext(channelId, userId, permission = 'view_channels') {
  const channel = await CommunityChannel.findById(objectId(channelId)).lean();
  if (!channel || channel.archivedAt) throw new AppError('Channel not found.', 404);
  const context = await communityContext(String(channel.communityId), userId);
  const matchingOverrides = (channel.overrides || []).filter(o => o.role === context.member?.role || context.roleDocs.some(r => String(r._id) === o.role));
  const permissions = derivePermissions(context.member.role, context.roleDocs.flatMap(r=>r.permissions), matchingOverrides);
  if (!permissions.has('view_channels') || !permissions.has(permission)) throw new AppError('Channel access denied.', 403);
  if (context.member?.timeoutUntil && new Date(context.member.timeoutUntil) > new Date() && ['send_messages','speak','share_screen','camera'].includes(permission)) throw new AppError('You are temporarily timed out.', 403);
  if (context.member?.voiceMutedUntil && new Date(context.member.voiceMutedUntil) > new Date() && permission === 'speak') throw new AppError('You are muted by a moderator.', 403);
  return { ...context, channel, permissions };
}
export function need(context, permission) {
  if (!context.permissions.has(permission)) throw new AppError('You do not have permission for this action.', 403);
  if (context.community.archivedAt) throw new AppError('This community is archived.', 423);
}
export function hierarchyCheck(actor, target) {
  if ((HIERARCHY[actor?.role] || 0) <= (HIERARCHY[target?.role] || 0)) throw new AppError('Cannot moderate a member with equal or higher role.', 403);
}
export async function canInviteUser(a, b) {
  if(a===b||await blocked(a,b))return false;
  const privacy=await privacyFor(b);
  const audience=privacy.communityInviteAudience||'friends';
  return audience==='everyone'||audience==='friends'&&await isFriend(a,b);
}
