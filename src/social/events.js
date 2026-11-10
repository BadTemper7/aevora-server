let socketServer = null;
export function registerSocket(io) { socketServer = io; }
export function emitUser(id, event, data) { socketServer?.to(`user:${id}`).emit(event, data); }
export function emitConversation(conversation, event, data) { for (const member of conversation.members) if (member.accepted) emitUser(member.userId, event, data); }
export async function userOnline(id) { return Boolean((await socketServer?.in(`user:${id}`).fetchSockets())?.length); }
