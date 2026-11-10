let socketServer = null;
export const registerCommunitySocket = io => { socketServer = io; };
export const emitCommunity = (id,event,payload) => socketServer?.to(`community:${id}`).emit(event,payload);
export const emitChannel = (id,event,payload) => socketServer?.to(`channel:${id}`).emit(event,payload);
export async function removeCommunityUser(communityId,userId) {
  if(!socketServer)return;
  const sockets=await socketServer.in(`user:${userId}`).fetchSockets();
  const { CommunityChannel }=await import('./models.js');
  const ownChannels=await CommunityChannel.find({communityId}).select('_id').lean();
  for(const socket of sockets){
    socket.leave(`community:${communityId}`);
    // Never eject users from unrelated community channels.
    for(const channel of ownChannels) socket.leave(`channel:${channel._id}`);
    socket.emit('community:removed',{communityId});
  }
}
export async function attachCommunityListeners(socket) {
  // Membership-only events carry no channel content; join on each authenticated
  // connection so unread badges update even outside the community page.
  void import('./models.js').then(async ({ CommunityMember }) => {
    const rows = await CommunityMember.find({ userId: socket.data.userId, status: 'active' })
      .select('communityId').limit(200).lean();
    if (socket.connected) for (const row of rows) socket.join(`community:${row.communityId}`);
  }).catch(error => console.warn('Community activity subscription failed:', error.message));
  let joins=0,lastJoinWindow=Date.now();
  socket.on('community:join',async (payload,ack)=>{
    const reply=typeof ack==='function'?ack:()=>{};
    try{
      if(Date.now()-lastJoinWindow>60000){joins=0;lastJoinWindow=Date.now();}
      if(++joins>90)return reply({ok:false,error:'Too many requests.'});
      const { communityContext, channelContext }=await import('./permissions.js');
      if(payload?.communityId){await communityContext(payload.communityId,socket.data.userId);socket.join(`community:${payload.communityId}`);}
      if(payload?.channelId){const ctx=await channelContext(payload.channelId,socket.data.userId);socket.join(`channel:${ctx.channel._id}`);socket.join(`community:${ctx.community._id}`);}
      reply({ok:true});
    }catch(error){reply({ok:false,error:error.message||'Not permitted.'});}
  });
  socket.on('community:leave',({communityId,channelId}={})=>{
    if(channelId&&/^[a-f\d]{24}$/i.test(channelId))socket.leave(`channel:${channelId}`);
    if(communityId&&/^[a-f\d]{24}$/i.test(communityId))socket.leave(`community:${communityId}`);
  });
}
