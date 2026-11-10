import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { AppError } from '../utils/AppError.js';
import { CommunityChannel, QuickVoiceRoom } from './models.js';
import { emitChannel, emitCommunity } from './events.js';
import { buildMediaGrant } from './trackSources.js';

export const mediaConfigured=()=>Boolean(process.env.LIVEKIT_URL&&process.env.LIVEKIT_API_KEY&&process.env.LIVEKIT_API_SECRET);
export const roomNameForChannel=(channelId)=>`aevora-community-${channelId}`;
export const roomNameForQuick=(roomId)=>`aevora-quick-${roomId}`;
const roomClient=()=>{
  if(!mediaConfigured())throw new AppError('Voice service is not configured. Ask an administrator to add LiveKit credentials.',503);
  const uri=process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:');
  return new RoomServiceClient(uri,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
};
export async function issueMediaToken({room,user,canSpeak=true,canCamera=true,canShare=true}){
  if(!mediaConfigured())throw new AppError('Voice/video is unavailable until LiveKit is configured.',503);
  const token=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:user.id,name:String(user.name||user.username||'Member').slice(0,80),ttl:'2m'});
  // LiveKit Server SDK grants use numeric protobuf TrackSource values.
  token.addGrant(buildMediaGrant({ room, canSpeak, canCamera, canShare }));
  return {serverUrl:process.env.LIVEKIT_URL,token:await token.toJwt(),room,expiresIn:120};
}
export async function roomParticipants(room){
  const participants=await roomClient().listParticipants(room);
  return participants.map(p=>({userId:p.identity,name:p.name||'Member',isSpeaking:Boolean(p.isSpeaking),tracks:(p.tracks||[]).map(t=>({source:t.source,muted:t.muted}))}));
}
export async function removeCommunityUserFromVoice(communityId,userId){
  if(!mediaConfigured())return;
  const channels=await CommunityChannel.find({communityId,type:{$in:['voice','video','stage']}}).select('_id').lean();
  for(const channel of channels){
    try{await roomClient().removeParticipant(roomNameForChannel(String(channel._id)),userId);}catch(error){
      if(!/not found|does not exist|room not found/i.test(String(error.message)))console.warn('Voice removal:',error.message);
    }
  }
}
export async function removeAllCommunityVoice(communityId){
  if(!mediaConfigured())return;
  const channels=await CommunityChannel.find({communityId,type:{$in:['voice','video','stage']}}).select('_id').lean();
  for(const channel of channels){try{await roomClient().deleteRoom(roomNameForChannel(String(channel._id)));}catch(error){if(!/not found/i.test(String(error.message)))console.warn('Delete voice room:',error.message);}}
}
export async function disconnectQuickRoom(roomId,userId){
  if(!mediaConfigured())return;
  try{await roomClient().removeParticipant(roomNameForQuick(roomId),userId);}catch(error){if(!/not found|does not exist/i.test(String(error.message)))console.warn('Disconnect quick room:',error.message);}
}
export async function livekitWebhook(body,authorization){
  if(!mediaConfigured())throw new AppError('LiveKit is not configured.',503);
  const receiver=new WebhookReceiver(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
  const event=await receiver.receive(body,authorization);
  const room=event.room?.name||'';
  const quick=/^aevora-quick-([a-f\d-]{36})$/i.exec(room);
  if(quick&&event.event==='room_finished')await QuickVoiceRoom.updateOne({roomId:quick[1]},{$set:{closedAt:new Date()}});
  const match=/^aevora-community-([a-f\d]{24})$/i.exec(room);
  if(match && ['participant_joined','participant_left','track_published','track_unpublished','participant_connected','participant_disconnected'].includes(event.event)){
    const payload={channelId:match[1],kind:event.event,userId:event.participant?.identity||null};
    emitChannel(match[1],'community:voice:presence',payload);
    const channel=await CommunityChannel.findById(match[1]).select('communityId').lean();
    if(channel)emitCommunity(String(channel.communityId),'community:voice:presence',payload);
  }
  return event.event;
}
