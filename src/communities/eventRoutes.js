import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { objectId } from '../social/helpers.js';
import { notify } from '../social/notify.js';
import { wrap, body } from '../social/routeUtils.js';
import { communityContext, need } from './permissions.js';
import { CommunityEvent, CommunityRSVP, CommunityMember, CommunityChannel, CommunityNotificationSettings, CommunityAuditLog } from './models.js';
import { emitCommunity } from './events.js';
const router=Router();
const eventSchema=z.object({title:z.string().trim().min(3).max(140),description:z.string().max(2000).default(''),startsAt:z.coerce.date(),endsAt:z.coerce.date().optional(),channelId:z.string().nullable().optional()});
router.get('/communities/:id/events',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const page=Math.min(20,Math.max(1,Number(req.query.page)||1));
  const events=await CommunityEvent.find({communityId:ctx.community._id,startsAt:{$gte:new Date(Date.now()-24*3600000)}}).sort({startsAt:1}).skip((page-1)*30).limit(30).lean();
  const mine=await CommunityRSVP.find({eventId:{$in:events.map(e=>e._id)},userId:req.user.id}).lean();
  return {items:events.map(e=>({...e,id:String(e._id),myRsvp:mine.find(x=>String(x.eventId)===String(e._id))?.response||null})),hasMore:events.length===30};
}));
router.post('/communities/:id/events',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_events');
  const values=body(req,eventSchema);
  if(values.startsAt<new Date())throw new AppError('Event must start in the future.',400);
  if(values.endsAt&&values.endsAt<=values.startsAt)throw new AppError('Event end must be after start.',400);
  if(values.channelId){const c=await CommunityChannel.findOne({_id:objectId(values.channelId),communityId:ctx.community._id,archivedAt:null});if(!c)throw new AppError('Channel not found.',404);}
  const event=await CommunityEvent.create({...values,communityId:ctx.community._id,creatorId:req.user.id});
  await CommunityAuditLog.create({communityId:ctx.community._id,actorId:req.user.id,action:'event_created',targetId:String(event._id)});
  emitCommunity(req.params.id,'community:event',{communityId:req.params.id,eventId:String(event._id)});
  return {id:String(event._id),title:event.title,startsAt:event.startsAt};
}));
router.patch('/communities/:id/events/:eventId',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);need(ctx,'manage_events');
  const values=body(req,eventSchema.partial().extend({cancelled:z.boolean().optional()}));
  if(values.startsAt&&values.startsAt<new Date())throw new AppError('Choose a future start time.',400);
  const {cancelled,...fields}=values;
  if(cancelled!==undefined)fields.cancelledAt=cancelled?new Date():null;
  const event=await CommunityEvent.findOneAndUpdate({_id:objectId(req.params.eventId),communityId:ctx.community._id},{$set:fields},{new:true,runValidators:true});
  if(!event)throw new AppError('Event not found.',404);
  await CommunityAuditLog.create({communityId:ctx.community._id,actorId:req.user.id,action:'event_updated',targetId:String(event._id)});
  emitCommunity(req.params.id,'community:event',{communityId:req.params.id,eventId:String(event._id)});
  return {id:String(event._id),updated:true};
}));
router.put('/communities/:id/events/:eventId/rsvp',wrap(async req=>{
  const ctx=await communityContext(req.params.id,req.user.id);
  const event=await CommunityEvent.findOne({_id:objectId(req.params.eventId),communityId:ctx.community._id,cancelledAt:null});if(!event)throw new AppError('Event not found.',404);
  const {response}=body(req,z.object({response:z.enum(['going','interested','none'])}));
  if(response==='none')await CommunityRSVP.deleteOne({eventId:event._id,userId:req.user.id});
  else await CommunityRSVP.updateOne({eventId:event._id,userId:req.user.id},{$set:{response}},{upsert:true});
  emitCommunity(req.params.id,'community:event',{communityId:req.params.id,eventId:String(event._id)});
  return {response};
}));
// The recurring worker only sends to event RSVPs, deduped by event ID and lead time.
let reminderTimer=null;
export function startCommunityEventReminders(){
  if(reminderTimer)return;
  const run=async()=>{
    const now=Date.now();
    const upcoming=await CommunityEvent.find({cancelledAt:null,startsAt:{$gt:new Date(now),$lte:new Date(now+16*60*1000)}}).limit(50).lean();
    for(const event of upcoming){
      if(event.startsAt.getTime()-now>15*60*1000)continue;
      const rsvps=await CommunityRSVP.find({eventId:event._id}).limit(500).lean();
      for(const r of rsvps)await notify({to:r.userId,from:event.creatorId,type:'community_event_reminder',entityId:String(event._id),url:`/communities/${event.communityId}`,title:`${event.title} starts soon`,dedupeKey:`community-reminder:${event._id}:${r.userId}`});
    }
  };
  reminderTimer=setInterval(()=>run().catch(e=>console.warn('Event reminders:',e.message)),60_000);reminderTimer.unref();
}
export default router;
