import { RoomServiceClient } from 'livekit-server-sdk';
import { roomNameForQuick, mediaConfigured } from './mediaService.js';
export async function removeAllQuickVoice(roomId){
  if(!mediaConfigured())return;
  const uri=process.env.LIVEKIT_URL.replace(/^wss:/,'https:').replace(/^ws:/,'http:');
  const client=new RoomServiceClient(uri,process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
  try{await client.deleteRoom(roomNameForQuick(roomId));}catch(error){if(!/not found/i.test(String(error.message)))throw error;}
}
