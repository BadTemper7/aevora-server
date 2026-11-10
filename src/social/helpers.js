import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { Block, Friendship, Follow, Privacy, Subscription } from "./models.js";
import { evaluateAudience, evaluateMessagePolicy } from "./policyRules.js";

export function requireId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{6,128}$/.test(value)) throw new AppError("Invalid user identifier.", 400);
  return value;
}
export function objectId(value) {
  if (!mongoose.isValidObjectId(value)) throw new AppError("Invalid identifier.", 400);
  return new mongoose.Types.ObjectId(value);
}
export function limitValue(value, max = 30) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : 20; }
export function cleanText(value, max = 5000) {
  if (typeof value !== "string") return "";
  return value.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max);
}
export function cleanUsername(value) { return String(value || "").trim().toLowerCase(); }
export const blocked = async (a, b) => Boolean(await Block.exists({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
export async function ensureNotBlocked(a, b) { if (await blocked(a, b)) throw new AppError("This interaction is not permitted.", 403, { code: "BLOCKED" }); }
export const isFriend = async (a, b) => Boolean(await Friendship.exists({ members: { $all: [a, b] }, status: "accepted" }));
export const isFollower = async (a, b) => Boolean(await Follow.exists({ follower: a, target: b, status: "accepted" }));
export const isSubscriber = async (a, b) => Boolean(await Subscription.exists({ subscriber: a, creator: b }));
export const privacyFor = async (id) => (await Privacy.findOne({ userId: id }).lean()) || { userId: id, messagePolicy: "friends", allowFriends: true, allowFollowers: false, allowSubscribers: false, friendRequestAudience: "everyone", followAudience: "everyone", communityInviteAudience: "friends", profileVisibility: "public", friendsListVisibility: "friends", onlineVisibility: "friends", lastActiveVisibility: "friends", readReceiptsVisibility: "friends", commentAudience: "everyone", mentionAudience: "everyone", videoDefaultVisibility: "public", privateProfile: false };
export async function relationship(a, b) {
  if (a === b) return { self: true, friends: false, following: false, subscribed: false, blocked: false };
  const [friend, follow, subscribed, hasBlock] = await Promise.all([
    Friendship.findOne({ members: { $all: [a, b] } }).lean(), Follow.findOne({ follower: a, target: b }).lean(),
    Subscription.exists({ subscriber: a, creator: b }), blocked(a, b),
  ]);
  return { self: false, friends: friend?.status === "accepted", friendStatus: friend?.status === "accepted" ? "friends" : friend?.status === "pending" ? (friend.from === a ? "sent" : "received") : "none", following: follow?.status === "accepted", followRequested: follow?.status === "pending", subscribed: Boolean(subscribed), blocked: hasBlock };
}
export async function canMessage(sender, recipient) {
  if (sender === recipient) return { allowed: false, request: false };
  const [denied, p, friends, follower, subscriber] = await Promise.all([
    blocked(sender, recipient), privacyFor(recipient), isFriend(sender, recipient),
    isFollower(sender, recipient), isSubscriber(sender, recipient),
  ]);
  return evaluateMessagePolicy(p, sender, { blocked: denied, friends, follower, subscriber });
}
export async function audienceAllows(viewer, owner, audience) {
  if (viewer === owner) return true;
  if (await blocked(viewer, owner)) return false;
  if (["everyone", "public"].includes(audience)) return true;
  if (audience === "friends") return isFriend(viewer, owner);
  if (audience === "followers") return isFollower(viewer, owner);
  if (audience === "subscribers") return isSubscriber(viewer, owner);
  return false;
}
export async function canSeeVideo(viewer, video) {
  if (viewer === video.ownerId) return true;
  const pr = await privacyFor(video.ownerId);
  if (pr.privateProfile && !await isFriend(viewer, video.ownerId) && !await isFollower(viewer, video.ownerId)) return false;
  return audienceAllows(viewer, video.ownerId, video.visibility);
}
function dbIds(value) {
  if (typeof value !== "string") return [value];
  return mongoose.isValidObjectId(value) ? [value, new mongoose.Types.ObjectId(value)] : [value];
}
export function safeUser(record) {
  if (!record) return null;
  const id = String(record._id ?? record.id ?? "");
  return id ? { id, name: record.name || record.username, username: record.username, image: record.image || null } : null;
}
export async function userById(id) {
  // Better Auth's MongoDB adapter maps logical user.id to MongoDB _id.
  // Support existing installations that used a string `id` field as well.
  const user = await mongoose.connection.db.collection("user").findOne({ $or: [{ _id: { $in: dbIds(id) } }, { id }] }, { projection: { _id: 1, id: 1, name: 1, username: 1, image: 1 } });
  return safeUser(user);
}
export async function usersByIds(ids) {
  if (!ids.length) return new Map();
  const unique = [...new Set(ids)];
  const records = await mongoose.connection.db.collection("user").find({ $or: [{ _id: { $in: unique.flatMap(dbIds) } }, { id: { $in: unique } }] }, { projection: { _id: 1, id: 1, name: 1, username: 1, image: 1 } }).toArray();
  return new Map(records.map(safeUser).filter(Boolean).map((user) => [user.id, user]));
}
export async function requireUser(id) { const user = await userById(id); if (!user?.username) throw new AppError("User not found.", 404); return user; }
