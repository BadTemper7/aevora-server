import mongoose from "mongoose";

const { Schema, model, models } = mongoose;
const str = { type: String, required: true, trim: true };
const stamp = { timestamps: true, versionKey: false };
const opts = (collection) => ({ ...stamp, collection });

const relationSchema = new Schema({
  key: { ...str, unique: true }, members: { type: [String], required: true, validate: (a) => a.length === 2 },
  from: str, to: str, status: { type: String, enum: ["pending", "accepted"], default: "pending" },
}, opts("social_friendships"));
relationSchema.index({ members: 1, status: 1 });
relationSchema.index({ to: 1, status: 1, createdAt: -1 });
relationSchema.index({ from: 1, status: 1, createdAt: -1 });
export const Friendship = models.SocialFriendship || model("SocialFriendship", relationSchema);

const followSchema = new Schema({
  follower: str, target: str, status: { type: String, enum: ["pending", "accepted"], default: "accepted" },
  notificationsEnabled: { type: Boolean, default: true },
}, opts("social_follows"));
followSchema.index({ follower: 1, target: 1 }, { unique: true });
followSchema.index({ target: 1, status: 1, createdAt: -1 });
export const Follow = models.SocialFollow || model("SocialFollow", followSchema);

const subscriptionSchema = new Schema({ subscriber: str, creator: str, notificationsEnabled: { type: Boolean, default: true } }, opts("social_subscriptions"));
subscriptionSchema.index({ subscriber: 1, creator: 1 }, { unique: true });
subscriptionSchema.index({ creator: 1, createdAt: -1 });
export const Subscription = models.SocialSubscription || model("SocialSubscription", subscriptionSchema);

const blockSchema = new Schema({ blocker: str, blocked: str }, opts("social_blocks"));
blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });
export const Block = models.SocialBlock || model("SocialBlock", blockSchema);

const privacySchema = new Schema({
  userId: { ...str, unique: true },
  messagePolicy: { type: String, enum: ["friends", "anyone", "custom"], default: "friends" },
  allowUsers: { type: [String], default: [] }, denyUsers: { type: [String], default: [] },
  allowFriends: { type: Boolean, default: true }, allowFollowers: { type: Boolean, default: false },
  allowSubscribers: { type: Boolean, default: false },
  profileVisibility: { type: String, enum: ["public", "followers", "friends", "private"], default: "public" },
  friendRequestAudience: { type: String, enum: ["everyone", "followers", "nobody"], default: "everyone" },
  followAudience: { type: String, enum: ["everyone", "nobody"], default: "everyone" },
  communityInviteAudience: { type: String, enum: ["everyone", "friends", "nobody"], default: "friends" },
  friendsListVisibility: { type: String, enum: ["public", "friends", "private"], default: "friends" },
  onlineVisibility: { type: String, enum: ["everyone", "friends", "nobody"], default: "friends" },
  lastActiveVisibility: { type: String, enum: ["everyone", "friends", "nobody"], default: "friends" },
  readReceiptsVisibility: { type: String, enum: ["everyone", "friends", "nobody"], default: "friends" },
  commentAudience: { type: String, enum: ["everyone", "followers", "friends", "nobody"], default: "everyone" },
  mentionAudience: { type: String, enum: ["everyone", "followers", "friends", "nobody"], default: "everyone" },
  videoDefaultVisibility: { type: String, enum: ["public", "friends", "subscribers", "private"], default: "public" },
  privateProfile: { type: Boolean, default: false },
}, opts("social_privacy"));
export const Privacy = models.SocialPrivacy || model("SocialPrivacy", privacySchema);

const profileSchema = new Schema({ userId: { ...str, unique: true }, bio: { type: String, maxlength: 500, default: "" }, avatarId: String, coverId: String, location: { type: String, maxlength: 100, default: "" }, website: { type: String, maxlength: 300, default: "" } }, opts("social_profiles"));
export const Profile = models.SocialProfile || model("SocialProfile", profileSchema);

const memberSchema = new Schema({
  userId: str, role: { type: String, enum: ["owner", "admin", "member"], default: "member" },
  accepted: { type: Boolean, default: true }, requestState: { type: String, enum: ["none", "pending", "accepted", "rejected"], default: "none" },
  lastReadAt: Date, lastDeliveredAt: Date, hiddenAt: Date, muted: { type: Boolean, default: false },
  pinned: { type: Boolean, default: false }, archived: { type: Boolean, default: false },
  manuallyUnread: { type: Boolean, default: false },
  nicknames: { type: [{ userId: String, value: { type: String, maxlength: 40 } }], default: [] },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });
const conversationSchema = new Schema({
  type: { type: String, enum: ["direct", "group"], required: true },
  contextType: { type: String, enum: ["general", "marketplace"], default: "general" },
  pairKey: String, name: { type: String, maxlength: 80 }, avatarId: String,
  createdBy: str, members: { type: [memberSchema], required: true },
  theme: { type: String, enum: ["default", "blue", "violet", "emerald", "rose"], default: "default" },
  quickEmoji: { type: String, default: "👍", maxlength: 64 },
  nicknames: { type: [{ userId: String, value: { type: String, maxlength: 40 } }], default: [] },
  disappearingSeconds: { type: Number, enum: [0, 86400, 604800, 2592000], default: 0 },
  lastMessageAt: Date, lastPreview: { type: String, default: "" },
}, opts("social_conversations"));
conversationSchema.index({ pairKey: 1 }, { unique: true, partialFilterExpression: { pairKey: { $type: "string" } } });
conversationSchema.index({ "members.userId": 1, lastMessageAt: -1 });
export const Conversation = models.SocialConversation || model("SocialConversation", conversationSchema);

const reactionSchema = new Schema({ userId: str, emoji: { ...str, maxlength: 64 } }, { _id: false });
const messageSchema = new Schema({
  conversationId: { type: Schema.Types.ObjectId, ref: "SocialConversation", required: true },
  senderId: str, clientId: String,
  kind: { type: String, enum: ["text", "image", "video", "gif", "file", "audio", "mixed", "sticker"], default: "text" },
  text: { type: String, maxlength: 5000, default: "" },
  mediaIds: { type: [Schema.Types.ObjectId], default: [] },
  gif: { type: new Schema({ id: String, url: String, previewUrl: String, source: String }, { _id: false }), default: undefined },
  replyTo: { type: Schema.Types.ObjectId, ref: "SocialMessage" },
  reactions: { type: [reactionSchema], default: [] }, editedAt: Date, deletedAt: Date,
  hiddenFor: { type: [String], default: [] }, pinnedAt: Date, pinnedBy: String, expiresAt: Date,
  deliveredTo: { type: [String], default: [] }, readBy: { type: [String], default: [] },
}, opts("social_messages"));
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, pinnedAt: -1 }, { partialFilterExpression: { pinnedAt: { $type: "date" } } });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
messageSchema.index({ conversationId: 1, senderId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: "string" } } });
messageSchema.index({ conversationId: 1, text: "text" });
export const Message = models.SocialMessage || model("SocialMessage", messageSchema);

const notificationSchema = new Schema({
  userId: str, actorId: str, type: str, entityId: String, title: { type: String, maxlength: 160, default: "" },
  detail: { type: String, maxlength: 250, default: "" }, dedupeKey: String, readAt: Date,
  groupKey: String, lastEventAt: Date, groupCount: { type: Number, default: 1, min: 1 },
  groupLeadName: String, url: String, actorIds: { type: [String], default: [] },
  dedupeKeys: { type: [String], default: [] },
}, opts("social_notifications"));
notificationSchema.index({ userId: 1, _id: -1 });
notificationSchema.index({ userId: 1, groupKey: 1 }, { unique: true, partialFilterExpression: { groupKey: { $type: "string" } } });
notificationSchema.index({ userId: 1, readAt: 1, _id: -1 });
notificationSchema.index({ userId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
export const Notification = models.SocialNotification || model("SocialNotification", notificationSchema);
const prefSchema = new Schema({
  userId: { ...str, unique: true }, disabledCategories: { type: [String], default: [] },
  enabledCategories: { type: [String], default: [] }, browserPush: { type: Boolean, default: false },
}, opts("social_notification_prefs"));
export const NotificationPrefs = models.SocialNotificationPrefs || model("SocialNotificationPrefs", prefSchema);

const videoSchema = new Schema({
  ownerId: str, mediaId: { type: Schema.Types.ObjectId, ref: "SocialMedia", required: true },
  thumbnailId: Schema.Types.ObjectId,
  title: { ...str, maxlength: 140 }, description: { type: String, maxlength: 2000, default: "" },
  visibility: { type: String, enum: ["public", "friends", "subscribers", "private"], default: "public" },
  viewCount: { type: Number, default: 0 },
}, opts("social_videos"));
videoSchema.index({ ownerId: 1, createdAt: -1 });
videoSchema.index({ visibility: 1, createdAt: -1 });
export const Video = models.SocialVideo || model("SocialVideo", videoSchema);
const interactionSchema = new Schema({ userId: str, videoId: { type: Schema.Types.ObjectId, ref: "SocialVideo", required: true }, liked: { type: Boolean, default: false }, saved: { type: Boolean, default: false }, viewedAt: Date, watchSeconds: { type: Number, default: 0 } }, opts("social_video_interactions"));
interactionSchema.index({ userId: 1, videoId: 1 }, { unique: true });
interactionSchema.index({ videoId: 1, liked: 1 });
export const VideoInteraction = models.SocialVideoInteraction || model("SocialVideoInteraction", interactionSchema);
const commentSchema = new Schema({ videoId: { type: Schema.Types.ObjectId, ref: "SocialVideo", required: true }, userId: str, text: { ...str, maxlength: 1500 }, parentId: Schema.Types.ObjectId }, opts("social_video_comments"));
commentSchema.index({ videoId: 1, createdAt: -1 });
export const VideoComment = models.SocialVideoComment || model("SocialVideoComment", commentSchema);

const mediaSchema = new Schema({
  ownerId: str, originalName: String, originalMime: String, mime: String, kind: { type: String, enum: ["image", "video", "gif", "file", "audio"], required: true },
  status: { type: String, enum: ["pending", "processing", "ready", "failed"], default: "pending" },
  originalKey: str, optimizedKey: String, thumbKey: String, size: Number, width: Number, height: Number,
  storageProvider: { type: String, enum: ['local','cloudflare-r2','imagekit'], default: 'local' },
  bucket: String, objectKey: String, thumbObjectKey: String, storageFileId: String, thumbStorageFileId: String,
  originalSize: Number, receivedSize: Number, optimizedSize: Number, thumbSize: Number, compressionRatio: Number,
  checksum: String, sourceChecksum: String, duration: Number, contentEtag: String, migratedAt: Date,
  error: String, startedAt: Date, completedAt: Date, progress: { type: Number, default: 0 }, attempts: { type: Number, default: 0 },
  purpose: { type: String, enum: ["message", "video", "avatar", "cover", "post", "story", "community", "story_audio"], required: true },
  variant: { type: String, enum: ["icon", "banner", null], default: null },
  uploadedAt: { type: Date, default: Date.now },
}, opts("social_media"));
mediaSchema.index({ ownerId: 1, createdAt: -1 });
mediaSchema.index({ status: 1, createdAt: 1 });
mediaSchema.index({ ownerId: 1, purpose: 1, checksum: 1, status: 1 });
mediaSchema.index({ storageProvider: 1, objectKey: 1 });
mediaSchema.index({ storageProvider: 1, storageFileId: 1 });
export const Media = models.SocialMedia || model("SocialMedia", mediaSchema);

const gifFavoriteSchema = new Schema({
  userId: str,
  source: { type: String, enum: ["tenor", "giphy", "upload"], required: true },
  sourceId: str,
  mediaId: Schema.Types.ObjectId,
  url: String,
  previewUrl: String,
}, opts("social_gif_favorites"));
gifFavoriteSchema.index({ userId: 1, source: 1, sourceId: 1 }, { unique: true });
gifFavoriteSchema.index({ userId: 1, createdAt: -1 });
export const GifFavorite = models.SocialGifFavorite || model("SocialGifFavorite", gifFavoriteSchema);

const reportSchema = new Schema({
  reporterId: str, targetType: { type: String, enum: ["user", "message", "video", "conversation"], required: true },
  targetId: str, reason: { ...str, maxlength: 300 }, description: { type: String, maxlength: 1000, default: "" }, status: { type: String, enum: ["open", "reviewing", "resolved", "dismissed"], default: "open" },
  moderatorId: String, moderatorNote: { type: String, maxlength: 1000 }, resolvedAt: Date,
  evidence: {
    text: { type: String, maxlength: 1000 }, senderId: String, capturedAt: Date,
    messages: { type: [{ messageId: String, text: { type: String, maxlength: 1000 }, senderId: String, createdAt: Date }], default: [] },
  },
}, opts("social_reports"));
reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reporterId: 1, createdAt: -1 });
export const Report = models.SocialReport || model("SocialReport", reportSchema);

export const pairKey = (a, b) => [String(a), String(b)].sort().join(":");

const presenceSchema = new Schema({ userId: { ...str, unique: true }, lastActiveAt: Date }, opts("social_presence"));
export const Presence = models.SocialPresence || model("SocialPresence", presenceSchema);

const eventJobSchema = new Schema({
  type: { type: String, enum: ["video_published", "post_published"], required: true }, entityId: str,
  ownerId: str, status: { type: String, enum: ["pending", "processing", "done", "failed"], default: "pending" },
  attempts: { type: Number, default: 0 }, startedAt: Date, finishedAt: Date, lastError: String,
}, opts("social_event_outbox"));
eventJobSchema.index({ type: 1, entityId: 1 }, { unique: true });
eventJobSchema.index({ status: 1, createdAt: 1 });
export const EventJob = models.SocialEventJob || model("SocialEventJob", eventJobSchema);

// Original Aevora home feed, backed by the same Better Auth user IDs.
const postSchema = new Schema({
  ownerId: str,
  content: { type: String, maxlength: 2000, default: "" },
  mediaIds: { type: [Schema.Types.ObjectId], default: [] },
  visibility: { type: String, enum: ["public", "friends", "followers", "private"], default: "public" },
  likesCount: { type: Number, min: 0, default: 0 },
  commentsCount: { type: Number, min: 0, default: 0 },
}, opts("social_posts"));
postSchema.index({ createdAt: -1 });
postSchema.index({ ownerId: 1, createdAt: -1 });
export const SocialPost = models.SocialFeedPost || model("SocialFeedPost", postSchema);

const postInteractionSchema = new Schema({
  postId: { type: Schema.Types.ObjectId, ref: "SocialFeedPost", required: true },
  userId: str,
  liked: { type: Boolean, default: false },
  saved: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
}, opts("social_post_interactions"));
postInteractionSchema.index({ postId: 1, userId: 1 }, { unique: true });
postInteractionSchema.index({ userId: 1, saved: 1, createdAt: -1 });
export const SocialPostInteraction = models.SocialPostInteraction || model("SocialPostInteraction", postInteractionSchema);

const postCommentSchema = new Schema({
  postId: { type: Schema.Types.ObjectId, ref: "SocialFeedPost", required: true },
  userId: str,
  text: { ...str, maxlength: 1000 },
}, opts("social_post_comments"));
postCommentSchema.index({ postId: 1, createdAt: -1 });
export const SocialPostComment = models.SocialPostComment || model("SocialPostComment", postCommentSchema);

const storySchema = new Schema({
  ownerId: str,
  mediaId: { type: Schema.Types.ObjectId, ref: "SocialMedia", default: null },
  mediaKind: { type: String, enum: ["image", "gif", "video", "text"], default: "image" },
  visibility: { type: String, enum: ["public", "friends", "followers"], default: "public" },
  duration: { type: Number, min: 3, max: 60, default: 10 },
  effects: { type: Schema.Types.Mixed, default: {} },
  layers: { type: [Schema.Types.Mixed], default: [] },
  music: { type: Schema.Types.Mixed, default: null },
  promptSource: { type: Schema.Types.Mixed, default: null },
  groupId: { type: String, index: true },
  slideIndex: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, opts("social_stories"));
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ ownerId: 1, createdAt: -1 });
storySchema.index({ groupId: 1, slideIndex: 1 });
export const SocialStory = models.SocialStory || model("SocialStory", storySchema);

const storyMusicSchema = new Schema({
  ownerId: str,
  mediaId: { type: Schema.Types.ObjectId, ref: 'SocialMedia', required: true },
  title: { ...str, maxlength: 120 }, artist: { ...str, maxlength: 120 },
  genre: { type: String, default: 'Other', maxlength: 50 }, mood: { type: String, default: 'Other', maxlength: 50 },
  visibility: { type: String, enum: ['public', 'private'], default: 'private' },
  rightsType: { type: String, enum: ['original', 'licensed'], required: true },
  rightsConfirmed: { type: Boolean, required: true },
  duration: Number, coverId: { type: Schema.Types.ObjectId, ref: 'SocialMedia', default: null }, uses: { type: Number, default: 0 },
}, opts('social_story_music'));
storyMusicSchema.index({ visibility: 1, uses: -1, createdAt: -1 });
storyMusicSchema.index({ ownerId: 1, createdAt: -1 });
storyMusicSchema.index({ mediaId: 1 }, { unique: true });
export const StoryMusic = models.StoryMusic || model('StoryMusic', storyMusicSchema);

const storyMusicFavoriteSchema = new Schema({ userId: str, trackId: { type: Schema.Types.ObjectId, ref: 'StoryMusic', required: true }, recentlyUsedAt: Date, favorite: { type: Boolean, default: false } }, opts('social_story_music_favorites'));
storyMusicFavoriteSchema.index({ userId: 1, trackId: 1 }, { unique: true });
export const StoryMusicFavorite = models.StoryMusicFavorite || model('StoryMusicFavorite', storyMusicFavoriteSchema);

const storyStickerResponseSchema = new Schema({
  storyId: { type: Schema.Types.ObjectId, ref: 'SocialStory', required: true }, stickerId: { ...str, maxlength: 64 },
  userId: str, type: { type: String, enum: ['poll','question','slider','countdown'], required: true },
  option: Number, answer: String, value: Number, remind: Boolean, reminderSentAt: Date, expiresAt: Date,
}, opts('social_story_sticker_responses'));
storyStickerResponseSchema.index({ storyId: 1, stickerId: 1, userId: 1 }, { unique: true });
storyStickerResponseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storyStickerResponseSchema.index({ type: 1, remind: 1, reminderSentAt: 1 });
export const StoryStickerResponse = models.StoryStickerResponse || model('StoryStickerResponse', storyStickerResponseSchema);

const storyViewSchema = new Schema({
  storyId: { type: Schema.Types.ObjectId, ref: "SocialStory", required: true },
  viewerId: str,
  expiresAt: { type: Date, required: true },
}, opts("social_story_views"));
storyViewSchema.index({ storyId: 1, viewerId: 1 }, { unique: true });
storyViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SocialStoryView = models.SocialStoryView || model("SocialStoryView", storyViewSchema);
