import { Server } from "socket.io";
import { fromNodeHeaders } from "better-auth/node";
import { env } from "../config/env.js";
import { Conversation, Friendship, Message, Presence } from "../social/models.js";
import { audienceAllows, blocked, privacyFor, requireId } from "../social/helpers.js";
import { emitUser, registerSocket } from "../social/events.js";
import { attachCommunityListeners, registerCommunitySocket } from "../communities/events.js";

export function attachSockets(httpServer, auth) {
  const io = new Server(httpServer, { path: "/socket.io", cors: { origin: env.CLIENT_URL, credentials: true }, maxHttpBufferSize: 25000, transports: ["websocket", "polling"] });
  io.use(async (socket, next) => {
    try {
      if (socket.handshake.headers.origin !== env.CLIENT_URL) return next(new Error("Invalid origin"));
      const session = await auth.api.getSession({ headers: fromNodeHeaders(socket.handshake.headers), query: { disableCookieCache: true } });
      if (!session?.user?.username) return next(new Error("Not authenticated"));
      socket.data.userId = session.user.id;
      next();
    } catch { next(new Error("Authentication failed")); }
  });
  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);
    void attachCommunityListeners(socket).catch((error) => console.error("Community sockets:", error.message));
    // Notify accepted friends when this user's first device connects.
    const announce = async (online) => {
      const privacy = await privacyFor(userId);
      if (privacy.onlineVisibility === "nobody") return;
      const friendships = await Friendship.find({ members: userId, status: "accepted" }).limit(500).lean();
      for (const relation of friendships) {
        const friendId = relation.members.find((id) => id !== userId);
        if (friendId && !await blocked(userId, friendId)) emitUser(friendId, "presence:changed", { userId, online });
      }
    };
    // Expensive presence fan-out must not delay registering socket event handlers.
    void (async () => {
      if ((await io.in(`user:${userId}`).fetchSockets()).length === 1) await announce(true);
    })().catch((error) => console.warn("Presence announcement failed:", error.message));
    let deliveredCount = 0, deliveredWindow = Date.now();
    socket.on("message:delivered", async (payload = {}, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (Date.now() - deliveredWindow > 60_000) { deliveredWindow = Date.now(); deliveredCount = 0; }
        if (++deliveredCount > 300) return reply({ ok: false, error: "Rate limit exceeded." });
        const conversationId = requireId(payload.conversationId);
        const messageIds = [...new Set(Array.isArray(payload.messageIds) ? payload.messageIds : [])].slice(0, 80).map(requireId);
        if (!messageIds.length) return reply({ ok: true });
        const c = await Conversation.findById(conversationId).lean();
        if (!c?.members.some((m) => m.userId === userId && m.accepted)) return reply({ ok: false, error: "Not permitted." });
        const records = await Message.find({ _id: { $in: messageIds }, conversationId: c._id, senderId: { $ne: userId }, deletedAt: null }).select("_id senderId deliveredTo").lean();
        const valid = [];
        for (const msg of records) if (!await blocked(userId, msg.senderId)) valid.push(msg);
        if (valid.length) {
          await Message.updateMany({ _id: { $in: valid.map((m) => m._id) }, deliveredTo: { $ne: userId } }, { $addToSet: { deliveredTo: userId } });
          for (const msg of valid) {
            if (!msg.deliveredTo.includes(userId)) {
              emitUser(msg.senderId, "message:delivery", { conversationId, messageId: String(msg._id), userId });
            }
          }
          // Include the recipient's other connected devices.
          socket.to(`user:${userId}`).emit("message:delivery:own", { conversationId, messageIds: valid.map((msg) => String(msg._id)), userId });
        }
        reply({ ok: true });
      } catch (error) { console.error("Message delivery acknowledgement failed:", error.message); reply({ ok: false, error: "Delivery acknowledgement failed." }); }
    });
    // Catch-up is an offer, not a delivery receipt. A recipient client must acknowledge it.
    // Catch up in the background. Do not block typing, presence or delivery
    // acknowledgment listeners while fetching offline messages from MongoDB.
    void (async () => {
      const convs = await Conversation.find({ members: { $elemMatch: { userId, accepted: true } } }).limit(100).select("_id").lean();
      const ids = convs.map((c) => c._id);
      if (ids.length) {
        const pending = await Message.find({ conversationId: { $in: ids }, senderId: { $ne: userId }, deliveredTo: { $ne: userId }, deletedAt: null }).sort({ _id: -1 }).limit(300).select("_id conversationId senderId").lean();
        const batches = new Map();
        for (const msg of pending) {
          if (await blocked(userId, msg.senderId)) continue;
          const key = String(msg.conversationId);
          if (!batches.has(key)) batches.set(key, []);
          batches.get(key).push(String(msg._id));
        }
        for (const [conversationId, messageIds] of batches) socket.emit("message:sync", { conversationId, messageIds });
      }
    })().catch((error) => console.error("Message catch-up failed:", error.message));
    const allowedTyping = async (conversationId) => {
      try {
        const c = await Conversation.findById(conversationId).lean();
        if (!c?.members.some((m) => m.userId === userId && m.accepted)) return null;
        return c;
      } catch { return null; }
    };
    let lastTyping = 0;
    socket.on("typing", async (payload = {}) => {
      if (typeof payload.conversationId !== "string" || (payload.active && Date.now() - lastTyping < 400)) return;
      lastTyping = Date.now();
      const c = await allowedTyping(payload.conversationId); if (!c) return;
      for (const target of c.members) if (target.userId !== userId && target.accepted && !await blocked(userId, target.userId)) emitUser(target.userId, "typing", { conversationId: String(c._id), userId, active: Boolean(payload.active) });
    });
    socket.on("presence:query", async (payload, reply) => {
      if (typeof reply !== "function") return;
      try {
        const target = requireId(payload?.userId);
        if (await blocked(userId, target)) return reply({ visible: false });
        const pr = await privacyFor(target);
        const allowedOnline = pr.onlineVisibility === "everyone" || (pr.onlineVisibility === "friends" && await audienceAllows(userId, target, "friends"));
        const allowedLast = pr.lastActiveVisibility === "everyone" || (pr.lastActiveVisibility === "friends" && await audienceAllows(userId, target, "friends"));
        const peers = await io.in(`user:${target}`).fetchSockets();
        const last = allowedLast ? await Presence.findOne({ userId: target }).lean() : null;
        reply({ visible: allowedOnline, online: allowedOnline && peers.length > 0, lastActiveAt: allowedLast ? last?.lastActiveAt || null : null });
      } catch { reply({ visible: false }); }
    });
    socket.on("disconnect", async () => {
      try {
        if ((await io.in(`user:${userId}`).fetchSockets()).length === 0) {
          await Presence.updateOne({ userId }, { $set: { lastActiveAt: new Date() } }, { upsert: true });
          await announce(false);
        }
      } catch (error) { console.warn("Presence update failed:", error.message); }
    });
  });
  registerSocket(io);
  registerCommunitySocket(io);
  return io;
}
