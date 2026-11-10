import mongoose from 'mongoose';
const { Schema, models, model } = mongoose;
const options = (collection) => ({ collection, timestamps: true, versionKey: false });
const id = { type: String, required: true };
const text = (max, defaultValue = '') => ({ type: String, trim: true, maxlength: max, default: defaultValue });
const make = (name, schema) => models[name] || model(name, schema);

const communitySchema = new Schema({
  ownerId: id,
  slug: { ...id, lowercase: true, trim: true, unique: true, minlength: 3, maxlength: 48 },
  name: { ...id, trim: true, maxlength: 80 }, description: text(2000),
  visibility: { type: String, enum: ['public','private','invite'], default: 'public' },
  category: { type: String, enum: ['Gaming','Technology','Entertainment','Education','General'], default: 'General' },
  rules: text(6000), iconId: String, bannerId: String,
  requireApproval: { type: Boolean, default: false }, memberCount: { type: Number, default: 1, min: 0 },
  defaultNotifications: { type: String, enum: ['all','mentions','off'], default: 'mentions' },
  archivedAt: Date, deletedAt: Date,
}, options('community_spaces'));
communitySchema.index({ visibility: 1, category: 1, memberCount: -1 });
communitySchema.index({ name: 'text', description: 'text' });
export const Community = make('AevoraCommunity', communitySchema);

const memberSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, ref: 'AevoraCommunity', required: true },
  userId: id, role: { type: String, enum: ['owner','admin','moderator','member','guest'], default: 'member' },
  roleIds: { type: [Schema.Types.ObjectId], default: [] }, status: { type: String, enum: ['active','pending','left','removed'], default: 'active' },
  nickname: text(48), rulesAcceptedAt: Date,
  timeoutUntil: Date, voiceMutedUntil: Date, joinedAt: { type: Date, default: Date.now },
}, options('community_members'));
memberSchema.index({ communityId: 1, userId: 1 }, { unique: true });
memberSchema.index({ communityId: 1, status: 1, role: 1 });
export const CommunityMember = make('AevoraCommunityMember', memberSchema);

const roleSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true },
  name: { ...id, maxlength: 40 }, color: { type: String, default: '#64748b', match: /^#[0-9a-fA-F]{6}$/ },
  permissions: { type: [String], default: [] }, position: { type: Number, default: 0 },
  isDefault: { type: Boolean, default: false },
}, options('community_roles'));
roleSchema.index({ communityId: 1, name: 1 }, { unique: true });
export const CommunityRole = make('AevoraCommunityRole', roleSchema);

const categorySchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, name: { ...id, maxlength: 50 },
  position: { type: Number, default: 0 },
}, options('community_channel_categories'));
categorySchema.index({ communityId: 1, position: 1 });
export const ChannelCategory = make('AevoraChannelCategory', categorySchema);

const channelSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true },
  categoryId: { type: Schema.Types.ObjectId, ref: 'AevoraChannelCategory' },
  name: { ...id, maxlength: 80 }, topic: text(400),
  type: { type: String, enum: ['text','voice','video','announcement','forum','stage'], required: true },
  position: { type: Number, default: 0 },
  slowModeSeconds: { type: Number, min: 0, max: 3600, default: 0 },
  // Allow/deny role IDs and core role names are enforced in permissions.js.
  overrides: { type: [{ role: String, allow: [String], deny: [String] }], default: [] },
  archivedAt: Date, lastMessageAt: Date,
}, options('community_channels'));
channelSchema.index({ communityId: 1, categoryId: 1, position: 1 });
export const CommunityChannel = make('AevoraCommunityChannel', channelSchema);

const invitationSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, inviterId: id,
  invitedId: String, tokenHash: { type: String, select: false },
  maxUses: { type: Number, default: 0 }, uses: { type: Number, default: 0 }, expiresAt: Date,
  revokedAt: Date, status: { type: String, enum: ['pending','accepted','declined'], default: 'pending' },
  temporary: { type: Boolean, default: false },
}, options('community_invitations'));
invitationSchema.index({ tokenHash: 1 }, { unique: true, sparse: true });
invitationSchema.index({ invitedId: 1, status: 1 });
invitationSchema.index({ communityId: 1, createdAt: -1 });
export const CommunityInvitation = make('AevoraCommunityInvitation', invitationSchema);

const banSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, userId: id, byId: id,
  reason: text(500), expiresAt: Date,
}, options('community_bans'));
banSchema.index({ communityId: 1, userId: 1 }, { unique: true });
export const CommunityBan = make('AevoraCommunityBan', banSchema);

const messageSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, channelId: { type: Schema.Types.ObjectId, required: true },
  senderId: id, clientId: String, content: text(5000),
  mediaIds: { type: [Schema.Types.ObjectId], default: [] }, gifUrl: String,
  replyTo: Schema.Types.ObjectId, threadId: Schema.Types.ObjectId,
  editedAt: Date, deletedAt: Date, pinnedAt: Date, pinnedBy: String,
  mentions: { type: [String], default: [] },
}, options('community_messages'));
messageSchema.index({ channelId: 1, createdAt: -1 });
messageSchema.index({ channelId: 1, senderId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
messageSchema.index({ channelId: 1, pinnedAt: -1 });
messageSchema.index({ channelId: 1, threadId: 1, createdAt: 1 });
export const ChannelMessage = make('AevoraChannelMessage', messageSchema);

const reactionSchema = new Schema({ messageId: { type: Schema.Types.ObjectId, required: true }, userId: id, emoji: { ...id, maxlength: 64 } }, options('community_message_reactions'));
reactionSchema.index({ messageId: 1, userId: 1 }, { unique: true });
export const ChannelReaction = make('AevoraChannelReaction', reactionSchema);

const threadSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, channelId: { type: Schema.Types.ObjectId, required: true },
  authorId: id, title: { ...id, maxlength: 150 }, body: text(5000), tags: { type: [String], default: [] },
  closedAt: Date, pinnedAt: Date, lastReplyAt: Date, replyCount: { type: Number, default: 0 },
}, options('community_forum_threads'));
threadSchema.index({ channelId: 1, pinnedAt: -1, lastReplyAt: -1 });
export const ForumThread = make('AevoraForumThread', threadSchema);

const pollSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, channelId: { type: Schema.Types.ObjectId, required: true },
  authorId: id, question: { ...id, maxlength: 240 }, options: [{ id: String, text: String }], closesAt: Date,
}, options('community_polls'));
pollSchema.index({ channelId: 1, createdAt: -1 });
export const ChannelPoll = make('AevoraChannelPoll', pollSchema);
const voteSchema = new Schema({ pollId: { type: Schema.Types.ObjectId, required: true }, userId: id, optionId: id }, options('community_poll_votes'));
voteSchema.index({ pollId: 1, userId: 1 }, { unique: true });
export const ChannelPollVote = make('AevoraChannelPollVote', voteSchema);

const eventSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true },
  channelId: Schema.Types.ObjectId, creatorId: id,
  title: { ...id, maxlength: 140 }, description: text(2000),
  startsAt: { type: Date, required: true }, endsAt: Date,
  cancelledAt: Date,
}, options('community_events'));
eventSchema.index({ communityId: 1, startsAt: 1 });
export const CommunityEvent = make('AevoraCommunityEvent', eventSchema);
const rsvpSchema = new Schema({ eventId: { type: Schema.Types.ObjectId, required: true }, userId: id, response: { type: String, enum: ['going','interested'], required: true } }, options('community_event_rsvps'));
rsvpSchema.index({ eventId: 1, userId: 1 }, { unique: true });
export const CommunityRSVP = make('AevoraCommunityRSVP', rsvpSchema);

const reportSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, reporterId: id,
  targetType: { type: String, enum: ['member','message','channel'], required: true }, targetId: id,
  reason: { ...id, maxlength: 120 }, details: text(1000),
  status: { type: String, enum: ['open','reviewing','resolved','dismissed'], default: 'open' }, resolvedBy: String,
}, options('community_reports'));
reportSchema.index({ communityId: 1, status: 1, createdAt: -1 });
export const CommunityReport = make('AevoraCommunityReport', reportSchema);
const auditSchema = new Schema({ communityId: { type: Schema.Types.ObjectId, required: true }, actorId: id, action: id, targetId: String, detail: { type: Schema.Types.Mixed, default: {} } }, options('community_audit_logs'));
auditSchema.index({ communityId: 1, createdAt: -1 });
export const CommunityAuditLog = make('AevoraCommunityAuditLog', auditSchema);

const settingsSchema = new Schema({
  communityId: { type: Schema.Types.ObjectId, required: true }, userId: id,
  mode: { type: String, enum: ['all','mentions','off'], default: 'mentions' },
  mutedChannelIds: { type: [String], default: [] },
  lastRead: { type: [{ channelId: String, timestamp: Date }], default: [] },
}, options('community_notification_settings'));
settingsSchema.index({ communityId: 1, userId: 1 }, { unique: true });
export const CommunityNotificationSettings = make('AevoraCommunityNotificationSettings', settingsSchema);

const stageSchema = new Schema({ channelId: { type: Schema.Types.ObjectId, required: true, unique: true }, topic: text(140), speakers: { type: [String], default: [] }, raisedHands: { type: [String], default: [] }, active: { type: Boolean, default: false } }, options('community_stages'));
export const CommunityStage = make('AevoraCommunityStage', stageSchema);

const quickRoomSchema = new Schema({ roomId: { ...id, unique: true }, ownerId: id, invitedIds: { type: [String], default: [] }, closedAt: Date, expiresAt: { type: Date, required: true } }, options('community_quick_voice_rooms'));
quickRoomSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const QuickVoiceRoom = make('AevoraQuickVoiceRoom', quickRoomSchema);
