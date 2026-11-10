import { randomBytes, createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { objectId, requireId, usersByIds, cleanText, privacyFor, isFriend, blocked } from '../social/helpers.js';
import { Friendship, Presence, Media } from '../social/models.js';
import { userOnline } from '../social/events.js';
import { notify } from '../social/notify.js';
import { derivePermissions } from './permissions.js';
import { wrap, body, assert } from '../social/routeUtils.js';
import { emitCommunity, removeCommunityUser } from './events.js';
import { communityContext, need, hierarchyCheck, PERMISSIONS, HIERARCHY, channelContext, canInviteUser } from './permissions.js';
import { Community, CommunityMember, CommunityRole, CommunityInvitation, CommunityBan, ChannelCategory, CommunityChannel, CommunityAuditLog, CommunityNotificationSettings, CommunityReport, ChannelMessage } from './models.js';
import { removeCommunityUserFromVoice, removeAllCommunityVoice } from './mediaService.js';

const router = Router();
// Navigation badge for unread channel messages. Uses the same lastRead cursors
// as the channel sidebar and filters channels by the member's real permissions.
router.get('/communities/unread-summary', wrap(async req => {
  const members = await CommunityMember.find({ userId: req.user.id, status: 'active' })
    .select('communityId role roleIds').limit(200).lean();
  if (!members.length) return { total: 0, communities: {} };
  const ids = members.map(m => m.communityId);
  const [spaces, channels, settings, roles] = await Promise.all([
    Community.find({ _id: { $in: ids }, deletedAt: null }).select('_id').lean(),
    CommunityChannel.find({ communityId: { $in: ids }, archivedAt: null,
      type: { $in: ['text','announcement','forum'] } }).select('_id communityId overrides').limit(4000).lean(),
    CommunityNotificationSettings.find({ communityId: { $in: ids }, userId: req.user.id }).lean(),
    CommunityRole.find({ _id: { $in: members.flatMap(m => m.roleIds || []) } }).select('_id communityId permissions').lean(),
  ]);
  const allowedSpaces = new Set(spaces.map(s => String(s._id)));
  const membership = new Map(members.map(m => [String(m.communityId), m]));
  const pref = new Map(settings.map(s => [String(s.communityId), s]));
  const minimum = new Date(Date.now() - 90 * 86400_000);
  const terms = [];
  for (const channel of channels) {
    const cid = String(channel.communityId);
    if (!allowedSpaces.has(cid)) continue;
    const member = membership.get(cid);
    if (!member) continue;
    const custom = roles.filter(r => String(r.communityId) === cid &&
      (member.roleIds || []).some(id => String(id) === String(r._id)));
    const overrides = (channel.overrides || []).filter(o =>
      o.role === member.role || custom.some(r => String(r._id) === o.role));
    if (!derivePermissions(member.role, custom.flatMap(r => r.permissions), overrides).has('view_channels')) continue;
    const last = pref.get(cid)?.lastRead?.find(r => r.channelId === String(channel._id));
    terms.push({ channelId: channel._id,
      createdAt: { $gt: last?.timestamp ? new Date(last.timestamp) : minimum } });
  }
  if (!terms.length) return { total: 0, communities: {} };
  const rows = await ChannelMessage.aggregate([
    { $match: { deletedAt: null, senderId: { $ne: req.user.id }, $or: terms } },
    { $group: { _id: '$communityId', count: { $sum: 1 } } },
  ]);
  const communities = Object.fromEntries(rows.map(r => [String(r._id), Math.min(999, r.count)]));
  return { total: rows.reduce((sum, r) => sum + r.count, 0), communities };
}));

const slugSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/);
const categoryEnum = z.enum(['Gaming','Technology','Entertainment','Education','General']);
const visibilityEnum = z.enum(['public','private','invite']);
const createSchema = z.object({
  name: z.string().trim().min(3).max(80), slug: slugSchema.optional(), description: z.string().max(2000).default(''),
  category: categoryEnum.default('General'), visibility: visibilityEnum.default('public'), rules: z.string().max(6000).default(''),
  requireApproval: z.boolean().default(false), iconId: z.string().optional(), bannerId: z.string().optional(),
});
const communityUpdate = createSchema.partial().omit({ slug: true });
const log = (communityId, actorId, action, targetId, detail) => CommunityAuditLog.create({ communityId, actorId, action, targetId: String(targetId || ''), detail: detail || {} });
const hash = (token) => createHash('sha256').update(token).digest('hex');
const invitationLink = (token) => `/communities/invite/${encodeURIComponent(token)}`;
const sanitize = (community) => ({ id: String(community._id), slug: community.slug, name: community.name, description: community.description, category: community.category, visibility: community.visibility, memberCount: community.memberCount, iconId: community.iconId, bannerId: community.bannerId, rules: community.rules, requireApproval: community.requireApproval, ownerId: community.ownerId, archivedAt: community.archivedAt, createdAt: community.createdAt });
const activeMember = (c, userId) => CommunityMember.findOne({ communityId: c._id, userId, status: 'active' });
async function validateCommunityImages(values,userId){
  for(const field of ['iconId','bannerId']){
    if(!values[field])continue;
    const media=await Media.findOne({_id:objectId(values[field]),ownerId:userId,purpose:'community',kind:'image',status:'ready'}).select('_id').lean();
    if(!media)throw new AppError(`${field} must be a ready community image you uploaded.`,400);
  }
}


async function activeBan(communityId, userId) {
  return CommunityBan.exists({ communityId, userId, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
}
async function enroll(community, userId, { rulesAccepted = false, requested = false } = {}) {
  if (await activeBan(community._id, userId)) throw new AppError('You are banned from this community.', 403);
  if (community.rules?.trim() && !rulesAccepted && !requested) throw new AppError('Accept the community rules to join.', 400);
  const status = requested ? 'pending' : 'active';
  let updated;
  try {
    updated = await CommunityMember.findOneAndUpdate(
      { communityId: community._id, userId, status: { $nin: ['active'] } },
      { $set: { status, role: 'member', ...(rulesAccepted ? { rulesAcceptedAt: new Date() } : {}) }, $setOnInsert: { communityId: community._id, userId, joinedAt: new Date() } },
      { upsert: true, new: true },
    );
  } catch (error) {
    if (error.code === 11000) throw new AppError('You already joined or requested access.', 409);
    throw error;
  }
  if (status === 'active') await Community.updateOne({ _id: community._id }, { $inc: { memberCount: 1 } });
  return { status, membership: updated };
}
function canManageTarget(ctx, target) { hierarchyCheck(ctx.member, target); }
async function invitePreview(invite, userId) {
  const c = await Community.findById(invite.communityId).lean();
  if (!c || c.deletedAt || invite.revokedAt || invite.expiresAt && invite.expiresAt <= new Date() || invite.maxUses > 0 && invite.uses >= invite.maxUses || invite.invitedId && invite.invitedId !== userId) throw new AppError('Invitation is expired or unavailable.', 404);
  if (await activeBan(c._id, userId)) throw new AppError('You cannot join this community.', 403);
  return { invite, community: c };
}

router.get('/communities', wrap(async req => {
  const memberships = await CommunityMember.find({ userId: req.user.id, status: 'active' }).sort({ updatedAt: -1 }).limit(100).lean();
  const communities = await Community.find({ _id: { $in: memberships.map(m => m.communityId) }, deletedAt: null }).lean();
  const map = new Map(memberships.map(m => [String(m.communityId), m]));
  return communities.map(c => ({ ...sanitize(c), myRole: map.get(String(c._id))?.role }));
}));
router.get('/communities/discover', wrap(async req => {
  const q = String(req.query.q || '').trim().slice(0,80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const category = String(req.query.category || 'All');
  const filter = { visibility: 'public', deletedAt: null, archivedAt: null };
  if (q) filter.$or = [{ name: { $regex: q, $options: 'i' } }, { description: { $regex: q, $options: 'i' } }];
  if (categoryEnum.safeParse(category).success) filter.category = category;
  const page = Math.min(100, Math.max(1, Number(req.query.page) || 1));
  const results = await Community.find(filter).sort({ memberCount: -1, _id: -1 }).skip((page-1)*20).limit(20).lean();
  return { items: results.map(sanitize), page, hasMore: results.length === 20 };
}));
router.get('/communities/invitations', wrap(async req => {
  const invites = await CommunityInvitation.find({ invitedId: req.user.id, status: 'pending', revokedAt: null }).sort({ createdAt: -1 }).limit(100).lean();
  const ids = invites.map(i => i.communityId);
  const communities = await Community.find({ _id: { $in: ids }, deletedAt: null }).lean();
  const map = new Map(communities.map(c => [String(c._id), sanitize(c)]));
  return invites.filter(i => map.has(String(i.communityId)) && (!i.expiresAt || i.expiresAt > new Date())).map(i => ({ id: String(i._id), community: map.get(String(i.communityId)), inviterId: i.inviterId, createdAt: i.createdAt }));
}));
router.get('/communities/invite/:token', wrap(async req => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError('Invalid invitation.', 404);
  const invite = await CommunityInvitation.findOne({ tokenHash: hash(token) }).select('+tokenHash').lean();
  if (!invite) throw new AppError('Invitation not found.', 404);
  const { community } = await invitePreview(invite, req.user.id);
  return { community: sanitize(community), expiresAt: invite.expiresAt, remainingUses: invite.maxUses ? Math.max(0, invite.maxUses - invite.uses) : null };
}));
router.post('/communities/invite/:token/accept', wrap(async req => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new AppError('Invalid invitation.', 404);
  const invite = await CommunityInvitation.findOne({ tokenHash: hash(token) }).select('+tokenHash');
  if (!invite) throw new AppError('Invitation not found.', 404);
  const { community } = await invitePreview(invite, req.user.id);
  if (await activeMember(community, req.user.id)) return { status: 'active', community: sanitize(community) };
  const { rulesAccepted } = body(req, z.object({ rulesAccepted: z.boolean().default(false) }));
  if (community.rules?.trim() && !rulesAccepted) throw new AppError('Accept the community rules.', 400);
  const advanced = await CommunityInvitation.findOneAndUpdate({ _id: invite._id, revokedAt: null, $and: [{ $or: [{ maxUses: 0 }, { $expr: { $lt: ['$uses', '$maxUses'] } }] }, { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }] }, { $inc: { uses: 1 } }, { new: true });
  if (!advanced) throw new AppError('This invitation is no longer available.', 409);
  try {
    const result = await enroll(community, req.user.id, { rulesAccepted, requested: community.requireApproval });
    if (invite.invitedId) await CommunityInvitation.updateOne({ _id: invite._id }, { $set: { status: 'accepted' } });
    emitCommunity(String(community._id), 'community:member', { communityId: String(community._id), userId: req.user.id, status: result.status });
    await log(community._id, req.user.id, 'invitation_accepted', req.user.id);
    return { status: result.status, community: sanitize(community) };
  } catch(error) { await CommunityInvitation.updateOne({ _id: invite._id, uses: { $gt: 0 } }, { $inc: { uses: -1 } }); throw error; }
}));
router.post('/communities/invitations/:id/respond', wrap(async req => {
  const { action, rulesAccepted } = body(req, z.object({ action: z.enum(['accept','decline']), rulesAccepted: z.boolean().default(false) }));
  const invite = await CommunityInvitation.findOne({ _id: objectId(req.params.id), invitedId: req.user.id, status: 'pending', revokedAt: null });
  if (!invite) throw new AppError('Invitation not found.', 404);
  if (action === 'decline') { await CommunityInvitation.updateOne({ _id: invite._id }, { $set: { status: 'declined' } }); return { status: 'declined' }; }
  const { community } = await invitePreview(invite, req.user.id);
  if (community.rules?.trim() && !rulesAccepted) throw new AppError('Accept the community rules.', 400);
  if (await activeMember(community, req.user.id)) return { status: 'active' };
  const result = await enroll(community, req.user.id, { rulesAccepted, requested: community.requireApproval });
  await CommunityInvitation.updateOne({ _id: invite._id }, { $set: { status: 'accepted' } });
  emitCommunity(String(community._id), 'community:member', { communityId: String(community._id), userId: req.user.id, status: result.status });
  return { status: result.status };
}));

router.post('/communities', wrap(async req => {
  const values = body(req, createSchema);
  await validateCommunityImages(values,req.user.id);
  const slug = values.slug || values.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48);
  if (!slugSchema.safeParse(slug).success) throw new AppError('Choose a valid community identifier.', 400);
  let community;
  try { community = await Community.create({ ...values, slug, ownerId: req.user.id }); }
  catch(error) { if (error.code === 11000) throw new AppError('Community identifier is already used.', 409); throw error; }
  try {
    await CommunityMember.create({ communityId: community._id, userId: req.user.id, role: 'owner', rulesAcceptedAt: new Date() });
    const categories = await ChannelCategory.insertMany(['INFORMATION','GENERAL','VOICE CHANNELS'].map((name, position)=>({ communityId: community._id, name, position })));
    const seed = [
      ['welcome','text',0], ['announcements','announcement',0], ['rules','text',0],
      ['general','text',1], ['media','text',1], ['off-topic','text',1],
      ['General Voice','voice',2], ['Gaming Room','voice',2], ['Lounge','voice',2],
    ];
    await CommunityChannel.insertMany(seed.map(([name,type,c],position)=>({ communityId: community._id, categoryId: categories[c]._id, name, type, position })));
    await log(community._id, req.user.id, 'community_created', community._id);
  } catch(error) {
    await Promise.all([Community.deleteOne({ _id: community._id }), CommunityMember.deleteMany({ communityId: community._id }), ChannelCategory.deleteMany({ communityId: community._id }), CommunityChannel.deleteMany({ communityId: community._id })]);
    throw error;
  }
  return sanitize(community);
}));
// Batch presence is privacy-aware. Members whose status is hidden are never
// returned as offline: that would reveal information they chose to conceal.
router.get('/communities/:id/presence',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const requested=String(req.query.ids||'').split(',').filter(v=>/^[A-Za-z0-9_-]{6,128}$/.test(v)).slice(0,100);
  const rows=await CommunityMember.find({communityId:ctx.community._id,status:'active',userId:{$in:requested}}).select('userId').lean();
  const result={};
  await Promise.all(rows.map(async ({userId})=>{
    if(userId===req.user.id)return;
    if(await blocked(req.user.id,userId))return;
    const privacy=await privacyFor(userId);
    const friends=privacy.onlineVisibility==='friends'||privacy.lastActiveVisibility==='friends' ? await isFriend(req.user.id,userId) : false;
    const onlineAllowed=privacy.onlineVisibility==='everyone'||privacy.onlineVisibility==='friends'&&friends;
    const lastAllowed=privacy.lastActiveVisibility==='everyone'||privacy.lastActiveVisibility==='friends'&&friends;
    if(!onlineAllowed&&!lastAllowed){result[userId]={visible:false};return;}
    const [online,last]=await Promise.all([onlineAllowed?userOnline(userId):false,lastAllowed?Presence.findOne({userId}).select('lastActiveAt').lean():null]);
    result[userId]={visible:onlineAllowed,online:Boolean(online),lastActiveAt:lastAllowed?last?.lastActiveAt||null:null};
  }));
  return result;
}));

router.get('/communities/:id', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id, { allowNonMember: true });
  const base = sanitize(ctx.community);
  if (!ctx.member) return { ...base, isMember: false };
  const [categories, channels, members, roles] = await Promise.all([
    ChannelCategory.find({ communityId: ctx.community._id }).sort({ position: 1 }).lean(),
    CommunityChannel.find({ communityId: ctx.community._id, archivedAt: null }).sort({ position: 1 }).lean(),
    CommunityMember.find({ communityId: ctx.community._id, status: 'active' }).sort({ role: 1 }).limit(200).lean(),
    CommunityRole.find({ communityId: ctx.community._id }).sort({ position: -1 }).lean(),
  ]);
  const users = await usersByIds(members.map(m => m.userId));
  return { ...base, isMember: true, role: ctx.member.role, permissions: [...ctx.permissions],
    categories: categories.map(x=>({ ...x, id:String(x._id) })),
    channels: channels.filter(c=>{
      const matching = c.overrides?.filter(o=>o.role===ctx.member.role||ctx.member.roleIds?.some(r=>String(r)===o.role)) || [];
      const denied = matching.some(o=>o.deny.includes('view_channels'));
      return !denied || ctx.member.role==='owner';
    }).map(c=>({ ...c, id:String(c._id) })),
    members: members.map(m=>({ userId:m.userId, role:m.role, roleIds:(m.roleIds||[]).map(String), nickname:m.nickname, user: users.get(m.userId) || null, joinedAt:m.joinedAt })),
    roles: roles.map(r=>({ id:String(r._id), name:r.name, color:r.color, permissions:r.permissions, position:r.position })),
  };
}));
router.patch('/communities/:id', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); need(ctx, 'manage_community');
  const values = body(req, communityUpdate);
  await validateCommunityImages(values,req.user.id);
  const updated = await Community.findByIdAndUpdate(ctx.community._id, { $set: values }, { new: true, runValidators: true });
  await log(ctx.community._id, req.user.id, 'community_updated', ctx.community._id, Object.keys(values));
  emitCommunity(req.params.id, 'community:updated', { communityId: req.params.id });
  return sanitize(updated);
}));
router.delete('/communities/:id', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); assert(ctx.member.role==='owner','Only owner can delete a community.');
  body(req, z.object({ confirm: z.literal(ctx.community.slug) }));
  await Community.updateOne({ _id: ctx.community._id }, { $set: { deletedAt: new Date() } });
  await CommunityInvitation.updateMany({ communityId: ctx.community._id }, { $set: { revokedAt: new Date() } });
  await removeAllCommunityVoice(ctx.community._id);
  emitCommunity(req.params.id, 'community:deleted', { communityId: req.params.id });
  await log(ctx.community._id, req.user.id, 'community_deleted', ctx.community._id);
  return { deleted: true };
}));
router.post('/communities/:id/archive', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); need(ctx, 'manage_community');
  const { archived } = body(req, z.object({ archived: z.boolean() }));
  await Community.updateOne({ _id: ctx.community._id }, { $set: { archivedAt: archived ? new Date() : null } });
  if (archived) await removeAllCommunityVoice(ctx.community._id);
  await log(ctx.community._id, req.user.id, archived ? 'community_archived' : 'community_restored');
  emitCommunity(req.params.id, 'community:updated', { communityId: req.params.id });
  return { archived };
}));
router.post('/communities/:id/join', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id, { allowNonMember: true });
  if (ctx.member) return { status: 'active' };
  if (ctx.community.visibility === 'invite') throw new AppError('This community requires an invitation.', 403);
  const { rulesAccepted } = body(req, z.object({ rulesAccepted: z.boolean().default(false) }));
  const requested = ctx.community.visibility === 'private' || ctx.community.requireApproval;
  const result = await enroll(ctx.community, req.user.id, { rulesAccepted, requested });
  if (result.status === 'pending') await notify({ to: ctx.community.ownerId, from: req.user.id, type:'community_join_request', entityId: String(ctx.community._id), title: `${req.user.username} requested to join ${ctx.community.name}`, dedupeKey:`community-join:${ctx.community.id}:${req.user.id}` });
  else emitCommunity(req.params.id, 'community:member', { communityId: req.params.id, userId: req.user.id, status: 'active' });
  return { status: result.status };
}));
router.post('/communities/:id/leave', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id);
  if (ctx.member.role === 'owner') throw new AppError('Transfer ownership before leaving.', 409);
  const changed=await CommunityMember.updateOne({ _id: ctx.member._id, status: 'active' }, { $set: { status: 'left' } });
  if (!changed.modifiedCount) throw new AppError('Your membership has already changed.', 409);
  await Community.updateOne({ _id: ctx.community._id }, { $inc: { memberCount: -1 } });
  await removeCommunityUser(req.params.id, req.user.id);
  await removeCommunityUserFromVoice(ctx.community._id, req.user.id);
  await log(ctx.community._id, req.user.id, 'member_left', req.user.id);
  emitCommunity(req.params.id, 'community:member', { communityId:req.params.id,userId:req.user.id,status:'left' });
  return { left: true };
}));
router.patch('/communities/:id/me/nickname', wrap(async req => {
  const ctx=await communityContext(req.params.id,req.user.id);
  const {nickname}=body(req,z.object({nickname:z.string().trim().max(48)}));
  await CommunityMember.updateOne({_id:ctx.member._id},{$set:{nickname}});
  emitCommunity(req.params.id,'community:member',{communityId:req.params.id,userId:req.user.id});
  return {nickname};
}));
router.post('/communities/:id/transfer', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id);
  assert(ctx.member.role === 'owner', 'Only owners can transfer ownership.');
  const { userId } = body(req, z.object({ userId: z.string() })); requireId(userId);
  const target = await CommunityMember.findOne({ communityId: ctx.community._id, userId, status: 'active' });
  if (!target) throw new AppError('New owner must be an active member.', 404);
  await CommunityMember.updateOne({ _id: target._id }, { $set: { role: 'owner' } });
  await Community.updateOne({ _id: ctx.community._id }, { $set: { ownerId: userId } });
  await CommunityMember.updateOne({ _id: ctx.member._id }, { $set: { role: 'admin' } });
  await log(ctx.community._id, req.user.id, 'ownership_transferred', userId);
  void notify({ to: userId, from: req.user.id, type: 'community_access_changed', entityId: req.params.id, title: `You are now the owner of ${ctx.community.name}`, dedupeKey: `owner-transfer:${ctx.community.id}:${userId}` }).catch(console.error);
  emitCommunity(req.params.id, 'community:updated', { communityId: req.params.id });
  return { ownerId:userId };
}));

router.get('/communities/:id/members/pending', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); need(ctx,'manage_invitations');
  const rows = await CommunityMember.find({ communityId: ctx.community._id, status: 'pending' }).limit(100).lean();
  const users = await usersByIds(rows.map(m=>m.userId));
  return rows.map(m=>({ userId:m.userId, user: users.get(m.userId) || null }));
}));
router.post('/communities/:id/members/:userId/approve', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); need(ctx,'manage_invitations');
  const userId = requireId(req.params.userId);
  const { approve } = body(req, z.object({ approve:z.boolean() }));
  const updated = await CommunityMember.findOneAndUpdate({ communityId: ctx.community._id, userId, status:'pending' }, { $set: { status: approve ? 'active' : 'removed' } }, { new: true });
  if (!updated) throw new AppError('Request not found.',404);
  if (approve) await Community.updateOne({ _id:ctx.community._id }, { $inc:{memberCount:1} });
  await notify({ to:userId, from:req.user.id, type:'community_join_response', entityId:req.params.id, title:`Your request to join ${ctx.community.name} was ${approve ? 'approved' : 'declined'}` });
  emitCommunity(req.params.id,'community:member',{communityId:req.params.id,userId,status:updated.status});
  await log(ctx.community._id, req.user.id, approve ? 'join_approved' : 'join_declined',userId);
  return { status:updated.status };
}));
router.post('/communities/:id/members/:userId/role', wrap(async req => {
  const ctx = await communityContext(req.params.id, req.user.id); need(ctx,'manage_roles');
  const target = await CommunityMember.findOne({ communityId:ctx.community._id,userId:requireId(req.params.userId),status:'active' });
  if(!target) throw new AppError('Member not found.',404); canManageTarget(ctx,target);
  const { role } = body(req,z.object({ role:z.enum(['admin','moderator','member','guest']) }));
  if(HIERARCHY[role] >= HIERARCHY[ctx.member.role]) throw new AppError('Cannot assign an equal or higher role.',403);
  await CommunityMember.updateOne({ _id:target._id },{ $set:{role} });
  await log(ctx.community._id,req.user.id,'member_role_changed',target.userId,{role});
  void notify({ to: target.userId, from: req.user.id, type: 'community_access_changed', entityId: req.params.id, title: `Your role in ${ctx.community.name} changed to ${role}` }).catch(console.error);
  emitCommunity(req.params.id,'community:member',{communityId:req.params.id,userId:target.userId,role});
  return { userId:target.userId,role };
}));
router.post('/communities/:id/members/:userId/timeout', wrap(async req => {
  const ctx = await communityContext(req.params.id,req.user.id); need(ctx,'mute_members');
  const target = await CommunityMember.findOne({ communityId:ctx.community._id,userId:requireId(req.params.userId),status:'active' });
  if(!target) throw new AppError('Member not found.',404); canManageTarget(ctx,target);
  const { minutes }=body(req,z.object({minutes:z.number().int().min(0).max(10080)}));
  const until=minutes?new Date(Date.now()+minutes*60000):null;
  await CommunityMember.updateOne({_id:target._id},{ $set:{timeoutUntil:until} });
  await log(ctx.community._id,req.user.id,'member_timeout',target.userId,{minutes});
  return { userId:target.userId,timeoutUntil:until };
}));
router.post('/communities/:id/members/:userId/remove', wrap(async req => {
  const ctx=await communityContext(req.params.id,req.user.id); need(ctx,'kick_members');
  const target=await CommunityMember.findOne({communityId:ctx.community._id,userId:requireId(req.params.userId),status:'active'});
  if(!target) throw new AppError('Member not found.',404); canManageTarget(ctx,target);
  const {ban,reason}=body(req,z.object({ban:z.boolean().default(false),reason:z.string().max(500).default('')}));
  if(ban) need(ctx,'ban_members');
  await CommunityMember.updateOne({_id:target._id},{$set:{status:'removed'}});
  await Community.updateOne({_id:ctx.community._id},{$inc:{memberCount:-1}});
  if(ban) await CommunityBan.updateOne({communityId:ctx.community._id,userId:target.userId},{$set:{byId:req.user.id,reason,expiresAt:null}},{upsert:true});
  await removeCommunityUser(req.params.id,target.userId);
  await removeCommunityUserFromVoice(ctx.community._id,target.userId);
  await log(ctx.community._id,req.user.id,ban?'member_banned':'member_kicked',target.userId,{reason});
  void notify({ to: target.userId, from: req.user.id, type: 'community_access_changed', entityId: req.params.id, title: `You were ${ban ? 'banned from' : 'removed from'} ${ctx.community.name}`, detail: reason.slice(0, 200) }).catch(console.error);
  emitCommunity(req.params.id,'community:member',{communityId:req.params.id,userId:target.userId,status:'removed'});
  return {removed:true,banned:ban};
}));
router.post('/communities/:id/bans/:userId/unban',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'ban_members');
  const userId=requireId(req.params.userId);
  await CommunityBan.deleteOne({communityId:ctx.community._id,userId});
  await log(ctx.community._id,req.user.id,'member_unbanned',userId);
  return {unbanned:true};
}));
router.get('/communities/:id/bans',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'ban_members');
  return CommunityBan.find({communityId:ctx.community._id}).sort({createdAt:-1}).limit(100).lean();
}));

router.post('/communities/:id/invitations',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'create_invitations');
  const { username, userId: userProvided, maxUses, expiresHours, temporary }=body(req,z.object({username:z.string().trim().max(50).optional(),userId:z.string().optional(),maxUses:z.number().int().min(0).max(10000).default(0),expiresHours:z.number().int().min(1).max(720).default(168),temporary:z.boolean().default(false)}));
  let invitedId=userProvided;
  if(username){const escaped=username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const user=await mongoose.connection.db.collection('user').findOne({username:{$regex:`^${escaped}$`,$options:'i'}},{projection:{_id:1}});if(!user)throw new AppError('Username not found.',404);invitedId=String(user._id);}
  if(invitedId){requireId(invitedId);if(!await canInviteUser(req.user.id,invitedId))throw new AppError('Cannot invite this account.',403);
    const existing=await CommunityMember.exists({communityId:ctx.community._id,userId:invitedId,status:'active'});
    if(existing)throw new AppError('User is already a member.',409);
  }
  const token=randomBytes(32).toString('hex');
  const invite=await CommunityInvitation.create({communityId:ctx.community._id,inviterId:req.user.id,invitedId,tokenHash:hash(token),maxUses:invitedId?1:maxUses,expiresAt:new Date(Date.now()+expiresHours*3600000),temporary});
  if(invitedId)await notify({to:invitedId,from:req.user.id,type:'community_invite',entityId:String(ctx.community._id),title:`${req.user.username} invited you to ${ctx.community.name}`,detail:'Open Communities → Invitations to respond.',dedupeKey:`community-invite:${invite.id}`});
  await log(ctx.community._id,req.user.id,'invite_created',invite._id);
  return {id:String(invite._id),token,link:invitationLink(token),expiresAt:invite.expiresAt,invitedId,maxUses:invite.maxUses};
}));
router.get('/communities/:id/invitations',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_invitations');
  const rows=await CommunityInvitation.find({communityId:ctx.community._id,revokedAt:null}).sort({createdAt:-1}).limit(100).lean();
  return rows.map(r=>({id:String(r._id),inviterId:r.inviterId,invitedId:r.invitedId,uses:r.uses,maxUses:r.maxUses,expiresAt:r.expiresAt,createdAt:r.createdAt,status:r.status}));
}));
router.delete('/communities/:id/invitations/:invId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_invitations');
  const result=await CommunityInvitation.updateOne({_id:objectId(req.params.invId),communityId:ctx.community._id},{$set:{revokedAt:new Date()}});
  if(!result.matchedCount)throw new AppError('Invitation not found.',404);
  await log(ctx.community._id,req.user.id,'invite_revoked',req.params.invId);
  return {revoked:true};
}));

router.post('/communities/:id/roles',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_roles');
  const values=body(req,z.object({name:z.string().trim().min(1).max(40),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),permissions:z.array(z.enum(PERMISSIONS)).max(25).default([])}));
  if(values.permissions.some(p=>!ctx.permissions.has(p)))throw new AppError('Cannot grant permissions you do not have.',403);
  const role=await CommunityRole.create({communityId:ctx.community._id,...values,position:1});
  await log(ctx.community._id,req.user.id,'role_created',role._id);
  emitCommunity(req.params.id,'community:updated',{communityId:req.params.id});
  return {id:String(role._id),name:role.name,permissions:role.permissions,color:role.color};
}));
router.patch('/communities/:id/roles/:roleId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_roles');
  const values=body(req,z.object({name:z.string().trim().min(1).max(40).optional(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),permissions:z.array(z.enum(PERMISSIONS)).max(25).optional()}));
  if(values.permissions?.some(p=>!ctx.permissions.has(p)))throw new AppError('Cannot grant permissions you do not have.',403);
  const role=await CommunityRole.findOneAndUpdate({_id:objectId(req.params.roleId),communityId:ctx.community._id},{$set:values},{new:true,runValidators:true});
  if(!role)throw new AppError('Role not found.',404);
  await log(ctx.community._id,req.user.id,'role_updated',role._id);
  return {id:String(role._id),name:role.name,permissions:role.permissions,color:role.color};
}));
router.delete('/communities/:id/roles/:roleId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_roles');
  const roleId=objectId(req.params.roleId);
  await CommunityMember.updateMany({communityId:ctx.community._id},{$pull:{roleIds:roleId}});
  await CommunityRole.deleteOne({_id:roleId,communityId:ctx.community._id});
  await log(ctx.community._id,req.user.id,'role_deleted',roleId);
  return {deleted:true};
}));
router.post('/communities/:id/members/:userId/custom-roles',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_roles');
  const target=await CommunityMember.findOne({communityId:ctx.community._id,userId:requireId(req.params.userId),status:'active'});
  if(!target)throw new AppError('Member not found.',404);canManageTarget(ctx,target);
  const { roleIds }=body(req,z.object({roleIds:z.array(z.string()).max(20)}));
  const ids=roleIds.map(objectId);
  const count=await CommunityRole.countDocuments({_id:{$in:ids},communityId:ctx.community._id});
  if(count!==ids.length)throw new AppError('Invalid roles.',400);
  await CommunityMember.updateOne({_id:target._id},{$set:{roleIds:ids}});
  await log(ctx.community._id,req.user.id,'custom_roles_assigned',target.userId,{roleIds});
  emitCommunity(req.params.id,'community:member',{communityId:req.params.id,userId:target.userId});
  return {roleIds};
}));

router.get('/communities/:id/notifications',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const item=await CommunityNotificationSettings.findOne({communityId:ctx.community._id,userId:req.user.id}).lean();
  return {mode:item?.mode||ctx.community.defaultNotifications,mutedChannelIds:item?.mutedChannelIds||[]};
}));
router.put('/communities/:id/notifications',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const values=body(req,z.object({mode:z.enum(['all','mentions','off']),mutedChannelIds:z.array(z.string()).max(100).default([])}));
  const known=await CommunityChannel.find({communityId:ctx.community._id,_id:{$in:values.mutedChannelIds.map(objectId)}}).select('_id').lean();
  if(known.length!==new Set(values.mutedChannelIds).size)throw new AppError('Invalid channel in notification settings.',400);
  await CommunityNotificationSettings.updateOne({communityId:ctx.community._id,userId:req.user.id},{$set:values},{upsert:true});
  return values;
}));
router.get('/communities/:id/audit',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'moderate_reports');
  return CommunityAuditLog.find({communityId:ctx.community._id}).sort({createdAt:-1}).limit(100).lean();
}));
router.post('/communities/:id/reports',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const values=body(req,z.object({targetType:z.enum(['member','message','channel']),targetId:z.string(),reason:z.string().trim().min(3).max(120),details:z.string().max(1000).default('')}));
  requireId(values.targetId);
  await CommunityReport.create({communityId:ctx.community._id,reporterId:req.user.id,...values});
  return {submitted:true};
}));
router.get('/communities/:id/reports',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'moderate_reports');
  return CommunityReport.find({communityId:ctx.community._id}).sort({createdAt:-1}).limit(100).lean();
}));
router.patch('/communities/:id/reports/:reportId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'moderate_reports');
  const {status}=body(req,z.object({status:z.enum(['reviewing','resolved','dismissed'])}));
  const report=await CommunityReport.findOneAndUpdate({_id:objectId(req.params.reportId),communityId:ctx.community._id},{$set:{status,resolvedBy:req.user.id}},{new:true});
  if(!report)throw new AppError('Report not found.',404);
  await log(ctx.community._id,req.user.id,'report_updated',report._id,{status});
  return {status};
}));

export default router;
