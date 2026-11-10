import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import { objectId, limitValue, usersByIds } from '../social/helpers.js';
import { Media, Block } from '../social/models.js';
import { isSupportedReactionEmoji } from '../social/reactionOptions.js';
import { notify } from '../social/notify.js';
import { emitUser } from '../social/events.js';
import { messageSendLimiter } from '../social/rateLimit.js';
import { wrap, body, assert } from '../social/routeUtils.js';
import { communityContext, channelContext, need, PERMISSIONS, derivePermissions } from './permissions.js';
import { Community, CommunityMember, ChannelCategory, CommunityChannel, ChannelMessage, ChannelReaction, ForumThread, ChannelPoll, ChannelPollVote, CommunityNotificationSettings, CommunityAuditLog } from './models.js';
import { emitChannel, emitCommunity } from './events.js';
const router = Router();
const types = z.enum(['text','voice','video','announcement','forum','stage']);
const compatibleMessage = (t) => ['text','announcement','forum'].includes(t);
const dateCursor = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null;
const serialize = async (items, userId) => {
  const senders = await usersByIds([...new Set(items.map(m => m.senderId))]);
  const ids = items.map(m => m._id);
  const reactions = ids.length ? await ChannelReaction.find({ messageId: { $in: ids } }).lean() : [];
  return items.map(m => ({ ...m, id:String(m._id), sender:senders.get(m.senderId) || { id:m.senderId },
    reactions:reactions.filter(r=>String(r.messageId)===String(m._id)).map(r=>({ emoji:r.emoji, userId:r.userId })),
    myMessage: m.senderId === userId,
  }));
};
const audit=(communityId,actorId,action,targetId,detail)=> CommunityAuditLog.create({communityId,actorId,action,targetId:String(targetId||''),detail:detail||{}});

router.post('/communities/:id/categories',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const {name}=body(req,z.object({name:z.string().trim().min(1).max(50)}));
  const position=await ChannelCategory.countDocuments({communityId:ctx.community._id});
  const doc=await ChannelCategory.create({communityId:ctx.community._id,name,position});
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});
  return {id:String(doc._id),name,position};
}));
router.patch('/communities/:id/categories/:categoryId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const values=body(req,z.object({name:z.string().trim().min(1).max(50).optional(),position:z.number().int().min(0).max(1000).optional()}));
  const doc=await ChannelCategory.findOneAndUpdate({_id:objectId(req.params.categoryId),communityId:ctx.community._id},{$set:values},{new:true,runValidators:true});
  if(!doc)throw new AppError('Category not found.',404);
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});return {id:String(doc._id),name:doc.name,position:doc.position};
}));
router.delete('/communities/:id/categories/:categoryId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const categoryId=objectId(req.params.categoryId);
  const doc=await ChannelCategory.deleteOne({_id:categoryId,communityId:ctx.community._id});
  if(!doc.deletedCount)throw new AppError('Category not found.',404);
  await CommunityChannel.updateMany({communityId:ctx.community._id,categoryId},{$unset:{categoryId:1}});
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});return {deleted:true};
}));
const overrideSchema=z.object({ role:z.string().min(1).max(64),allow:z.array(z.enum(PERMISSIONS)).max(25).default([]),deny:z.array(z.enum(PERMISSIONS)).max(25).default([]) });
const channelFields=z.object({name:z.string().trim().min(1).max(80),type:types,topic:z.string().max(400).default(''),categoryId:z.string().nullable().optional(),position:z.number().int().min(0).max(10000).optional(),slowModeSeconds:z.number().int().min(0).max(3600).default(0),overrides:z.array(overrideSchema).max(50).default([])});
router.post('/communities/:id/channels',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const values=body(req,channelFields);
  if(values.overrides.some(o=>o.role==='owner'||o.allow.some(p=>!ctx.permissions.has(p))))throw new AppError('Invalid permission override.',403);
  if(values.categoryId && !await ChannelCategory.exists({_id:objectId(values.categoryId),communityId:ctx.community._id}))throw new AppError('Category not found.',404);
  const n=await CommunityChannel.countDocuments({communityId:ctx.community._id});
  const doc=await CommunityChannel.create({...values,categoryId:values.categoryId ? objectId(values.categoryId) : null,communityId:ctx.community._id,position:values.position??n});
  await audit(ctx.community._id,req.user.id,'channel_created',doc._id,{type:doc.type});
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});
  return {id:String(doc._id),name:doc.name,type:doc.type};
}));
router.patch('/communities/:id/channels/:channelId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const values=body(req,channelFields.partial());
  if(values.overrides?.some(o=>o.role==='owner'||o.allow.some(p=>!ctx.permissions.has(p))))throw new AppError('Invalid permission override.',403);
  if(values.categoryId && !await ChannelCategory.exists({_id:objectId(values.categoryId),communityId:ctx.community._id}))throw new AppError('Category not found.',404);
  const c=await CommunityChannel.findOneAndUpdate({_id:objectId(req.params.channelId),communityId:ctx.community._id},{$set:values},{new:true,runValidators:true});
  if(!c)throw new AppError('Channel not found.',404);
  await audit(ctx.community._id,req.user.id,'channel_updated',c._id,Object.keys(values));
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});
  return {id:String(c._id),name:c.name,type:c.type};
}));
router.delete('/communities/:id/channels/:channelId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_channels');
  const c=await CommunityChannel.findOneAndUpdate({_id:objectId(req.params.channelId),communityId:ctx.community._id,archivedAt:null},{$set:{archivedAt:new Date()}},{new:true});
  if(!c)throw new AppError('Channel not found.',404);
  await audit(ctx.community._id,req.user.id,'channel_deleted',c._id);
  emitCommunity(req.params.id,'community:channels',{communityId:req.params.id});
  return {deleted:true};
}));

// Unread counts use persisted per-user last-read cursors, not browser memory.
router.get('/communities/:id/unread',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const [settings,channels]=await Promise.all([
    CommunityNotificationSettings.findOne({communityId:ctx.community._id,userId:req.user.id}).lean(),
    CommunityChannel.find({communityId:ctx.community._id,archivedAt:null,type:{$in:['text','announcement','forum']}}).select('_id overrides').limit(150).lean(),
  ]);
  const minDate=new Date(Date.now()-90*86400_000);
  const rolePermissions=ctx.roleDocs.flatMap(r=>r.permissions);
  const seen=new Map((settings?.lastRead||[]).map(r=>[r.channelId,new Date(r.timestamp)]));
  const terms=channels.filter(ch=>derivePermissions(ctx.member.role,rolePermissions,(ch.overrides||[]).filter(o=>o.role===ctx.member.role||ctx.roleDocs.some(r=>String(r._id)===o.role))).has('view_channels')).map(ch=>({channelId:ch._id,createdAt:{$gt:seen.get(String(ch._id))||minDate}}));
  if(!terms.length)return {};
  const rows=await ChannelMessage.aggregate([{$match:{communityId:ctx.community._id,deletedAt:null,senderId:{$ne:req.user.id},$or:terms}},{$group:{_id:'$channelId',count:{$sum:1},mentions:{$sum:{$cond:[{$in:[req.user.username?.toLowerCase()||'', {$ifNull:['$mentions',[]]}]},1,0]}}}}]);
  return Object.fromEntries(rows.map(row=>[String(row._id),{count:Math.min(99,row.count),mentions:Math.min(99,row.mentions)}]));
}));
router.post('/channels/:channelId/read',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const channelId=String(ctx.channel._id),now=new Date();
  const settings=await CommunityNotificationSettings.findOneAndUpdate({communityId:ctx.community._id,userId:req.user.id},{$setOnInsert:{communityId:ctx.community._id,userId:req.user.id}},{upsert:true,new:true});
  const prior=(settings.lastRead||[]).find(v=>v.channelId===channelId);
  if(prior)prior.timestamp=now;
  else settings.lastRead.push({channelId,timestamp:now});
  settings.markModified('lastRead');await settings.save();
  emitUser(req.user.id, "community:unread:updated", { communityId: String(ctx.community._id) });
  return {channelId,readAt:now};
}));

router.get('/channels/:channelId/messages',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  assert(compatibleMessage(ctx.channel.type),'This channel does not support text messages.',400);
  const cursor=dateCursor(req.query.before);
  const filter={channelId:ctx.channel._id,threadId:req.query.threadId ? objectId(String(req.query.threadId)) : null};
  if(cursor)filter.createdAt={$lt:cursor};
  const rows=await ChannelMessage.find(filter).sort({createdAt:-1,_id:-1}).limit(limitValue(req.query.limit,50)).lean();
  return {items:await serialize(rows.reverse(),req.user.id),hasMore:rows.length===limitValue(req.query.limit,50),nextCursor:rows.length?rows[0].createdAt:null};
}));
router.get('/channels/:channelId/search',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const q=String(req.query.q||'').trim().slice(0,80);
  if(q.length<2)return {items:[]};
  const escaped=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const items=await ChannelMessage.find({channelId:ctx.channel._id,deletedAt:null,content:{$regex:escaped,$options:'i'}}).sort({createdAt:-1}).limit(40).lean();
  return {items:await serialize(items,req.user.id)};
}));
router.get('/channels/:channelId/pins',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const items=await ChannelMessage.find({channelId:ctx.channel._id,pinnedAt:{$ne:null},deletedAt:null}).sort({pinnedAt:-1}).limit(40).lean();
  return serialize(items,req.user.id);
}));
const messageBody=z.object({clientId:z.string().uuid().default(randomUUID),content:z.string().max(5000).default(''),mediaIds:z.array(z.string()).max(5).default([]),gifUrl:z.string().url().max(500).optional(),replyTo:z.string().optional(),threadId:z.string().optional()});
router.post('/channels/:channelId/messages',messageSendLimiter,wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'send_messages');
  if(!compatibleMessage(ctx.channel.type))throw new AppError('This channel does not accept messages.',400);
  if(ctx.channel.type==='announcement'&&!ctx.permissions.has('manage_messages'))throw new AppError('Only announcements staff can post here.',403);
  const values=body(req,messageBody);
  const content=values.content.trim();
  if(!content && !values.mediaIds.length && !values.gifUrl)throw new AppError('Add text or an attachment.',400);
  if(values.mediaIds.length && !ctx.permissions.has('upload_attachments'))throw new AppError('Attachments are disabled here.',403);
  if(values.gifUrl && !/^https:\/\/(?:media\d*\.giphy\.com|i\.giphy\.com)\//i.test(values.gifUrl))throw new AppError('Use an approved GIF source.',400);
  const mediaIds=values.mediaIds.map(objectId);
  if(mediaIds.length){const n=await Media.countDocuments({_id:{$in:mediaIds},ownerId:req.user.id,status:'ready',$or:[{purpose:'community'},{purpose:'message',kind:'gif'}]});if(n!==mediaIds.length)throw new AppError('Attachment is not ready or not yours.',400);}
  if(values.replyTo && !await ChannelMessage.exists({_id:objectId(values.replyTo),channelId:ctx.channel._id,deletedAt:null}))throw new AppError('Reply target not found.',404);
  if(values.threadId){if(!await ForumThread.exists({_id:objectId(values.threadId),channelId:ctx.channel._id,closedAt:null}))throw new AppError('Thread not found or closed.',404);}
  // Idempotent retries must not be rejected by slow mode or create duplicate notifications.
  const previouslySaved=await ChannelMessage.findOne({channelId:ctx.channel._id,senderId:req.user.id,clientId:values.clientId});
  if(previouslySaved){const [saved]=await serialize([previouslySaved.toObject()],req.user.id);return saved;}
  const last=ctx.channel.slowModeSeconds && await ChannelMessage.findOne({channelId:ctx.channel._id,senderId:req.user.id}).sort({createdAt:-1}).select('createdAt').lean();
  if(last && Date.now()-new Date(last.createdAt).getTime()<ctx.channel.slowModeSeconds*1000&&!ctx.permissions.has('manage_messages'))throw new AppError('Slow mode is active. Try again shortly.',429);
  // Do not trust arbitrary @mentions: notify only valid, active members.
  const mentions=[...new Set([...content.matchAll(/@([a-zA-Z0-9_]{3,30})\b/g)].map(m=>m[1].toLowerCase()))].slice(0,20);
  const result=await ChannelMessage.findOneAndUpdate({channelId:ctx.channel._id,senderId:req.user.id,clientId:values.clientId},
    {$setOnInsert:{communityId:ctx.community._id,channelId:ctx.channel._id,senderId:req.user.id,clientId:values.clientId,content,mediaIds,gifUrl:values.gifUrl,replyTo:values.replyTo?objectId(values.replyTo):null,threadId:values.threadId?objectId(values.threadId):null,mentions}},
    {upsert:true,new:true,setDefaultsOnInsert:true,includeResultMetadata:true});
  const item=result.value;
  // An upsert that finds an existing clientId is a retry; it must not count
  // another forum reply, emit a second live message or notify twice.
  if(result.lastErrorObject?.updatedExisting){const [saved]=await serialize([item.toObject()],req.user.id);return saved;}
  await CommunityChannel.updateOne({_id:ctx.channel._id},{$max:{lastMessageAt:item.createdAt}});
  if(values.threadId)await ForumThread.updateOne({_id:objectId(values.threadId)},{$max:{lastReplyAt:item.createdAt},$inc:{replyCount:1}});
  const [serialized]=await serialize([item.toObject()],req.user.id);
  emitChannel(String(ctx.channel._id),'community:message:new',{channelId:String(ctx.channel._id),message:serialized});
  emitCommunity(String(ctx.community._id),'community:message:activity',{communityId:String(ctx.community._id)});
  // Notification fan-out happens after the real-time broadcast, never before it.
  void (async()=>{
    if(!mentions.length&&ctx.channel.type!=='announcement')return;
    const members=await CommunityMember.find({communityId:ctx.community._id,status:'active'}).select('userId').lean();
    const users=await usersByIds(members.map(m=>m.userId));
    for(const member of members){const user=users.get(member.userId);if(!user?.username)continue;
      const setting=await CommunityNotificationSettings.findOne({communityId:ctx.community._id,userId:member.userId}).lean();
      if(setting?.mode==='off'||setting?.mutedChannelIds?.includes(String(ctx.channel._id)))continue;
      if(mentions.includes(user.username.toLowerCase())){
        await notify({to:member.userId,from:req.user.id,type:'community_mention',entityId:String(item._id),title:`${req.user.username} mentioned you in #${ctx.channel.name}`,dedupeKey:`comm-mention:${item.id}:${member.userId}`});
      }else if(ctx.channel.type==='announcement'){
        await notify({to:member.userId,from:req.user.id,type:'community_announcement',entityId:String(item._id),title:`New announcement in ${ctx.community.name}`,dedupeKey:`comm-announcement:${item.id}:${member.userId}`});
      }
    }
  })().catch(e=>console.warn('Mention notifications:',e.message));
  return serialized;
}));
router.patch('/channels/:channelId/messages/:messageId',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'view_channels');
  const msg=await ChannelMessage.findOne({_id:objectId(req.params.messageId),channelId:ctx.channel._id,deletedAt:null});
  if(!msg)throw new AppError('Message not found.',404);
  assert(msg.senderId===req.user.id,'You can only edit your messages.');
  const {content}=body(req,z.object({content:z.string().trim().min(1).max(5000)}));
  msg.content=content;msg.editedAt=new Date();await msg.save();
  const [item]=await serialize([msg.toObject()],req.user.id);
  emitChannel(String(ctx.channel._id),'community:message:updated',{channelId:String(ctx.channel._id),message:item});
  return item;
}));
router.delete('/channels/:channelId/messages/:messageId',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const msg=await ChannelMessage.findOne({_id:objectId(req.params.messageId),channelId:ctx.channel._id,deletedAt:null});
  if(!msg)throw new AppError('Message not found.',404);
  if(msg.senderId!==req.user.id)need(ctx,'manage_messages');
  msg.deletedAt=new Date();msg.content='';msg.mediaIds=[];msg.gifUrl=null;msg.pinnedAt=null;await msg.save();
  emitChannel(String(ctx.channel._id),'community:message:updated',{channelId:String(ctx.channel._id),message:{...msg.toObject(),id:String(msg._id)}});
  return {deleted:true};
}));
router.put('/channels/:channelId/messages/:messageId/reaction',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'add_reactions');
  const msg=await ChannelMessage.findOne({_id:objectId(req.params.messageId),channelId:ctx.channel._id,deletedAt:null});
  if(!msg)throw new AppError('Message not found.',404);
  const {emoji}=body(req,z.object({emoji:z.string()}));
  if(!isSupportedReactionEmoji(emoji))throw new AppError('Select one valid emoji.',400);
  const query={messageId:msg._id,userId:req.user.id};
  const prior=await ChannelReaction.findOne(query).lean();
  if(prior?.emoji===emoji)await ChannelReaction.deleteOne(query);
  else await ChannelReaction.findOneAndUpdate(query,{$set:{emoji}},{upsert:true,new:true});
  const reactions=await ChannelReaction.find({messageId:msg._id}).select('emoji userId').lean();
  emitChannel(String(ctx.channel._id),'community:message:reactions',{channelId:String(ctx.channel._id),messageId:String(msg._id),reactions});
  return {reactions};
}));
router.post('/channels/:channelId/messages/:messageId/pin',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'manage_messages');
  const {pinned}=body(req,z.object({pinned:z.boolean()}));
  if(pinned&&await ChannelMessage.countDocuments({channelId:ctx.channel._id,pinnedAt:{$ne:null},deletedAt:null})>=50)throw new AppError('Maximum pinned messages reached.',409);
  const msg=await ChannelMessage.findOneAndUpdate({_id:objectId(req.params.messageId),channelId:ctx.channel._id,deletedAt:null},{$set:{pinnedAt:pinned?new Date():null,pinnedBy:pinned?req.user.id:null}},{new:true});
  if(!msg)throw new AppError('Message not found.',404);
  emitChannel(String(ctx.channel._id),'community:message:pinned',{channelId:String(ctx.channel._id),messageId:String(msg._id),pinned});
  return {pinned};
}));

router.post('/channels/:channelId/threads',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'create_threads');
  if(ctx.channel.type!=='forum')throw new AppError('Use a forum channel.',400);
  const {title,body:description,tags}=body(req,z.object({title:z.string().trim().min(3).max(150),body:z.string().trim().min(1).max(5000),tags:z.array(z.string().trim().max(24)).max(8).default([])}));
  const thread=await ForumThread.create({communityId:ctx.community._id,channelId:ctx.channel._id,authorId:req.user.id,title,body:description,tags,lastReplyAt:new Date()});
  emitChannel(String(ctx.channel._id),'community:thread',{channelId:String(ctx.channel._id),threadId:String(thread._id)});
  return {id:String(thread._id),title,body:description,tags};
}));
router.get('/channels/:channelId/threads',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  if(ctx.channel.type!=='forum')throw new AppError('Use a forum channel.',400);
  const rows=await ForumThread.find({channelId:ctx.channel._id}).sort({pinnedAt:-1,lastReplyAt:-1}).limit(50).lean();
  return rows.map(r=>({...r,id:String(r._id)}));
}));
router.post('/channels/:channelId/threads/:threadId/close',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const t=await ForumThread.findOne({_id:objectId(req.params.threadId),channelId:ctx.channel._id});if(!t)throw new AppError('Thread not found.',404);
  if(t.authorId!==req.user.id)need(ctx,'manage_messages');
  const {closed}=body(req,z.object({closed:z.boolean()}));t.closedAt=closed?new Date():null;await t.save();
  emitChannel(String(ctx.channel._id),'community:thread',{channelId:String(ctx.channel._id),threadId:String(t._id)});
  return {closed};
}));
router.post('/channels/:channelId/polls',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id,'send_messages');
  const {question,options}=body(req,z.object({question:z.string().trim().min(3).max(240),options:z.array(z.string().trim().min(1).max(120)).min(2).max(10)}));
  const poll=await ChannelPoll.create({communityId:ctx.community._id,channelId:ctx.channel._id,authorId:req.user.id,question,options:options.map(text=>({id:randomUUID(),text}))});
  emitChannel(String(ctx.channel._id),'community:poll',{channelId:String(ctx.channel._id),pollId:String(poll._id)});
  return {id:String(poll._id),question,options:poll.options};
}));
router.get('/channels/:channelId/polls',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const polls=await ChannelPoll.find({channelId:ctx.channel._id}).sort({createdAt:-1}).limit(30).lean();
  const votes=await ChannelPollVote.find({pollId:{$in:polls.map(p=>p._id)}}).lean();
  return polls.map(p=>({...p,id:String(p._id),options:p.options.map(o=>({id:o.id,text:o.text,votes:votes.filter(v=>String(v.pollId)===String(p._id)&&v.optionId===o.id).length})),myVote:votes.find(v=>String(v.pollId)===String(p._id)&&v.userId===req.user.id)?.optionId||null}));
}));
router.put('/channels/:channelId/polls/:pollId/vote',wrap(async req=>{
  const ctx=await channelContext(req.params.channelId,req.user.id);
  const poll=await ChannelPoll.findOne({_id:objectId(req.params.pollId),channelId:ctx.channel._id});if(!poll)throw new AppError('Poll not found.',404);
  if(poll.closesAt&&poll.closesAt<=new Date())throw new AppError('Poll has closed.',409);
  const {optionId}=body(req,z.object({optionId:z.string()}));
  if(!poll.options.some(o=>o.id===optionId))throw new AppError('Invalid answer.',400);
  await ChannelPollVote.findOneAndUpdate({pollId:poll._id,userId:req.user.id},{$set:{optionId}},{upsert:true});
  emitChannel(String(ctx.channel._id),'community:poll',{channelId:String(ctx.channel._id),pollId:String(poll._id)});
  return {optionId};
}));

export default router;
