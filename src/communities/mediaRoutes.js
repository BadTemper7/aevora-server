import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { objectId, requireId } from '../social/helpers.js';
import { isFriend, blocked } from '../social/helpers.js';
import { wrap, body } from '../social/routeUtils.js';
import { channelContext, communityContext, need } from './permissions.js';
import { QuickVoiceRoom, CommunityChannel, CommunityMember, CommunityStage } from './models.js';
import { issueMediaToken, roomNameForChannel, roomNameForQuick, roomParticipants, disconnectQuickRoom, mediaConfigured } from './mediaService.js';
import { emitChannel, emitCommunity } from './events.js';

const router=Router();
const mediaTypes=['voice','video','stage'];
router.get('/channels/:channelId/voice/participants',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'view_channels');
  if(!mediaTypes.includes(ctx.channel.type))throw new AppError('Not a voice/video channel.',400);
  if(!mediaConfigured())return {configured:false,items:[]};
  try{return {configured:true,items:await roomParticipants(roomNameForChannel(String(ctx.channel._id)))};}
  catch(error){if(/not found|not exist/i.test(error.message))return {configured:true,items:[]};throw error;}
}));
router.post('/channels/:channelId/voice/token',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'connect_voice');
  if(!mediaTypes.includes(ctx.channel.type))throw new AppError('This is not a live channel.',400);
  let canSpeak=ctx.permissions.has('speak'),canCamera=ctx.permissions.has('camera'),canShare=ctx.permissions.has('share_screen');
  if(ctx.channel.type==='stage'){
    const stage=await CommunityStage.findOne({channelId:ctx.channel._id}).lean();
    const allowed=ctx.permissions.has('mute_members')||stage?.speakers?.includes(req.user.id);
    canSpeak=canSpeak && allowed;canCamera=false;canShare=false;
  }
  const token=await issueMediaToken({room:roomNameForChannel(String(ctx.channel._id)),user:req.user,canSpeak,canCamera,canShare});
  return {...token,permissions:{canSpeak,canCamera,canShare},channelId:String(ctx.channel._id),communityId:String(ctx.community._id)};
}));
router.post('/channels/:channelId/voice/mute/:userId',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'mute_members');
  const userId=requireId(req.params.userId);
  const {minutes}=body(req,z.object({minutes:z.number().int().min(0).max(1440).default(10)}));
  if(userId===ctx.community.ownerId)throw new AppError('Cannot mute the community owner.',403);
  const member=await CommunityMember.findOneAndUpdate({communityId:ctx.community._id,userId,status:'active'},{$set:{voiceMutedUntil:minutes?new Date(Date.now()+minutes*60_000):null}},{new:true});
  if(!member)throw new AppError('Member not found.',404);
  // Actual microphone-track muting requires LiveKit admin API and the track SID.
  // Disconnect this client to force a freshly permissioned token.
  const {removeCommunityUserFromVoice}=await import('./mediaService.js');
  if(minutes)await removeCommunityUserFromVoice(ctx.community._id,userId);
  emitChannel(String(ctx.channel._id),'community:voice:moderated',{userId,minutes});
  return {mutedUntil:member.voiceMutedUntil};
}));
router.get('/channels/:channelId/stage',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  if(ctx.channel.type!=='stage')throw new AppError('Not a stage channel.',400);
  const stage=await CommunityStage.findOne({channelId:ctx.channel._id}).lean();
  return {topic:stage?.topic||'',speakers:stage?.speakers||[],raisedHands:stage?.raisedHands||[],active:stage?.active||false};
}));
router.post('/channels/:channelId/stage/hand',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  if(ctx.channel.type!=='stage')throw new AppError('Not a stage channel.',400);
  const {raised}=body(req,z.object({raised:z.boolean()}));
  const operation=raised?{$addToSet:{raisedHands:req.user.id}}:{$pull:{raisedHands:req.user.id}};
  await CommunityStage.updateOne({channelId:ctx.channel._id},{$setOnInsert:{channelId:ctx.channel._id},...operation},{upsert:true});
  emitChannel(String(ctx.channel._id),'community:stage:updated',{channelId:String(ctx.channel._id)});
  return {raised};
}));
router.post('/channels/:channelId/stage/speaker',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'mute_members');
  if(ctx.channel.type!=='stage')throw new AppError('Not a stage channel.',400);
  const {userId,allowed}=body(req,z.object({userId:z.string(),allowed:z.boolean()}));requireId(userId);
  if(!await CommunityMember.exists({communityId:ctx.community._id,userId,status:'active'}))throw new AppError('Not an active member.',404);
  await CommunityStage.updateOne({channelId:ctx.channel._id},{$setOnInsert:{channelId:ctx.channel._id},...(allowed?{$addToSet:{speakers:userId}}:{$pull:{speakers:userId}})},{upsert:true});
  if(!allowed){const {removeCommunityUserFromVoice}=await import('./mediaService.js');await removeCommunityUserFromVoice(ctx.community._id,userId);}
  emitChannel(String(ctx.channel._id),'community:stage:updated',{channelId:String(ctx.channel._id)});
  return {userId,allowed};
}));
router.patch('/channels/:channelId/stage',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'manage_events');
  if(ctx.channel.type!=='stage')throw new AppError('Not a stage channel.',400);
  const values=body(req,z.object({topic:z.string().max(140).optional(),active:z.boolean().optional()}));
  await CommunityStage.updateOne({channelId:ctx.channel._id},{$set:values,$setOnInsert:{channelId:ctx.channel._id}},{upsert:true});
  emitChannel(String(ctx.channel._id),'community:stage:updated',{channelId:String(ctx.channel._id)});
  return values;
}));

router.post('/voice/quick',wrap(async req=>{
  const {friendIds}=body(req,z.object({friendIds:z.array(z.string()).min(1).max(12)}));
  const ids=[...new Set(friendIds.map(requireId))].filter(id=>id!==req.user.id);
  if(!ids.length)throw new AppError('Invite at least one friend.',400);
  for(const id of ids)if(!await isFriend(req.user.id,id)||await blocked(req.user.id,id))throw new AppError('Quick rooms can only invite accepted friends.',403);
  const roomId=randomUUID();
  const doc=await QuickVoiceRoom.create({roomId,ownerId:req.user.id,invitedIds:ids,expiresAt:new Date(Date.now()+4*3600000)});
  for(const id of ids){const {notify}=await import('../social/notify.js');void notify({to:id,from:req.user.id,type:'group_voice_invite',entityId:roomId,title:`${req.user.username} invited you to a private voice room`,dedupeKey:`quick-voice:${roomId}:${id}`}).catch(console.error);}
  return {roomId:doc.roomId};
}));
router.get('/voice/quick',wrap(async req=>{
  const rows=await QuickVoiceRoom.find({$or:[{ownerId:req.user.id},{invitedIds:req.user.id}],closedAt:null,expiresAt:{$gt:new Date()}}).sort({createdAt:-1}).limit(30).lean();
  return rows.map(r=>({roomId:r.roomId,ownerId:r.ownerId,invitedIds:r.invitedIds,createdAt:r.createdAt}));
}));
router.post('/voice/quick/:roomId/token',wrap(async req=>{
  const room=await QuickVoiceRoom.findOne({roomId:req.params.roomId,closedAt:null,expiresAt:{$gt:new Date()}}).lean();
  if(!room||(room.ownerId!==req.user.id&&!room.invitedIds.includes(req.user.id)))throw new AppError('Quick room invitation not found.',404);
  if(room.ownerId!==req.user.id&&await blocked(room.ownerId,req.user.id))throw new AppError('This room is not available.',403);
  return issueMediaToken({room:roomNameForQuick(room.roomId),user:req.user});
}));
router.post('/voice/quick/:roomId/close',wrap(async req=>{
  const room=await QuickVoiceRoom.findOneAndUpdate({roomId:req.params.roomId,ownerId:req.user.id,closedAt:null},{$set:{closedAt:new Date()}},{new:true});
  if(!room)throw new AppError('Room not found or not yours.',404);
  if(mediaConfigured()){const {removeAllQuickVoice}=await import('./quickCleanup.js');await removeAllQuickVoice(room.roomId);}
  return {closed:true};
}));
export default router;
