import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/AppError.js';
import { Media, SocialStory, SocialStoryView, StoryMusic, StoryMusicFavorite, StoryStickerResponse } from './models.js';
import { canSeeStory } from './feedRules.js';
import { blocked, objectId, usersByIds, privacyFor, audienceAllows } from './helpers.js';
import { body, wrap } from './routeUtils.js';
import { storyBatch, storySlide, reactionResponse, musicInput } from './storyRules.js';

const router = Router();
const visibleStory = async (viewer, id) => {
  const story = await SocialStory.findById(objectId(id)).lean();
  if (!story || !await canSeeStory(viewer, story)) throw new AppError('Story not available.', 404);
  return story;
};
const musicSafe = (track) => track ? ({ id: String(track._id), ownerId: track.ownerId, mediaId: String(track.mediaId), coverId: track.coverId ? String(track.coverId) : null, title: track.title, artist: track.artist, genre: track.genre, mood: track.mood, duration: track.duration, uses: track.uses, visibility: track.visibility }) : null;

router.get('/story-music', wrap(async (req) => {
  const category = ['trending','recommended','favorites','recent','mine'].includes(String(req.query.category)) ? String(req.query.category) : 'trending';
  const term = String(req.query.q || '').trim().slice(0, 80);
  const filter = { $or: [{ visibility: 'public' }, { ownerId: req.user.id }] };
  if (term) filter.$and = [{ $or: ['title','artist','genre','mood'].map(field => ({ [field]: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } })) }];
  let records;
  if (['favorites','recent'].includes(category)) {
    const mine = await StoryMusicFavorite.find({ userId: req.user.id, ...(category === 'favorites' ? { favorite: true } : { recentlyUsedAt: { $ne: null } }) }).sort(category === 'favorites' ? { updatedAt: -1 } : { recentlyUsedAt: -1 }).limit(80).lean();
    const allowed = await StoryMusic.find({ _id: { $in: mine.map(x=>x.trackId) }, ...filter }).lean();
    const keyed = new Map(allowed.map(x=>[String(x._id), x]));
    records = mine.map(f=>keyed.get(String(f.trackId))).filter(Boolean);
  } else {
    if (category === 'mine') { delete filter.$or; filter.ownerId = req.user.id; }
    records = await StoryMusic.find(filter).sort(category === 'recommended' ? { createdAt: -1 } : { uses: -1, createdAt: -1 }).limit(60).lean();
  }
  const favs = await StoryMusicFavorite.find({ userId: req.user.id, favorite: true, trackId: { $in: records.map(r=>r._id) } }).select('trackId').lean();
  const liked = new Set(favs.map(x=>String(x.trackId)));
  return records.map(t=>({ ...musicSafe(t), favorite: liked.has(String(t._id)) }));
}));
router.post('/story-music', wrap(async (req) => {
  const input = body(req, musicInput);
  const media = await Media.findOne({ _id: objectId(input.mediaId), ownerId: req.user.id, purpose: 'story_audio', kind: 'audio', status: 'ready' }).lean();
  if (!media) throw new AppError('Upload and process the audio track first.', 400);
  if (!media.duration || media.duration > 600) throw new AppError('Audio track duration must be between 1 and 600 seconds.', 400);
  if (input.coverId) {
    const cover = await Media.findOne({ _id: objectId(input.coverId), ownerId: req.user.id, purpose: 'story', kind: { $in: ['image','gif'] }, status: 'ready' });
    if (!cover) throw new AppError('Music cover image must be uploaded and optimized first.', 400);
  }
  if (await StoryMusic.exists({ mediaId: media._id })) throw new AppError('This audio was already added to the catalog.', 409);
  const item = await StoryMusic.create({ ...input, mediaId: media._id, ownerId: req.user.id, duration: media.duration });
  return musicSafe(item);
}));
router.post('/story-music/:id/favorite', wrap(async (req) => {
  const { favorite } = body(req, z.object({ favorite: z.boolean() }).strict());
  const track = await StoryMusic.findById(objectId(req.params.id)).lean();
  if (!track || (track.visibility !== 'public' && track.ownerId !== req.user.id)) throw new AppError('Music not found.', 404);
  await StoryMusicFavorite.updateOne({ userId: req.user.id, trackId: track._id }, { $set: { favorite } }, { upsert: true });
  return { favorite };
}));

async function validateSlides(slides, ownerId) {
  const mediaIds = [...new Set([...slides.map(x=>x.mediaId), ...slides.flatMap(x=>x.layers.filter(l=>l.type==='image').map(l=>l.mediaId))].filter(Boolean))].map(objectId);
  const trackIds = [...new Set(slides.map(x=>x.music?.trackId).filter(Boolean))].map(objectId);
  const [media, tracks] = await Promise.all([
    Media.find({ _id: { $in: mediaIds }, ownerId, purpose: 'story', status: 'ready' }).lean(),
    StoryMusic.find({ _id: { $in: trackIds }, $or: [{ visibility: 'public' }, { ownerId }] }).lean(),
  ]);
  const byMedia = new Map(media.map(m=>[String(m._id),m]));
  const byTrack = new Map(tracks.map(m=>[String(m._id),m]));
  for (const slide of slides) {
    for (const layer of slide.layers) if (layer.type === 'image' && !['image','gif'].includes(byMedia.get(layer.mediaId)?.kind)) throw new AppError('Sticker image is unavailable or still processing.', 400);
    if (slide.mediaId) {
      const m = byMedia.get(slide.mediaId);
      if (!m || m.kind !== slide.mediaKind) throw new AppError('Story media is unavailable, still processing, or mismatched.', 400);
      if (m.kind === 'video') {
        const trimStart = slide.effects.trimStart || 0;
        const trimEnd = slide.effects.trimEnd || m.duration;
        if (trimStart >= m.duration || trimEnd > m.duration + 0.05 || slide.duration > trimEnd - trimStart + 0.05) throw new AppError('Video story duration exceeds the selected clip.', 400);
      }
    }
    if (slide.music) {
      const music = byTrack.get(slide.music.trackId);
      if (!music) throw new AppError('The selected music track is unavailable.', 400);
      if (slide.music.start + slide.duration > music.duration + 0.05) throw new AppError('The selected music segment exceeds the track duration.', 400);
    }
    for (const layer of slide.layers) if (layer.type === 'countdown' && (new Date(layer.endsAt).getTime() <= Date.now() || new Date(layer.endsAt).getTime() > Date.now()+23*3600_000)) throw new AppError('Countdown must end within the next 23 hours.', 400);
    for (const layer of slide.layers) if (layer.type === 'mention') {
      const username = layer.username.toLowerCase();
      const other = await mongoose.connection.db.collection('user').findOne({ username: { $regex: `^${username}$`, $options: 'i' } }, { projection: { _id: 1 } });
      if (!other || await blocked(ownerId, String(other._id))) throw new AppError('Tagged user is not available.', 400);
      const privacy = await privacyFor(String(other._id));
      if (!await audienceAllows(ownerId, String(other._id), privacy.mentionAudience || 'everyone')) throw new AppError('That user does not allow mentions.', 403);
    }
  }
}

async function publishSlides(viewer, slides, promptSource = null) {
  await validateSlides(slides, viewer);
  if (promptSource) {
    const original = await visibleStory(viewer, promptSource.storyId);
    if (!original.layers.some(l=>l.id === promptSource.stickerId && l.type === 'add_yours')) throw new AppError('The selected story prompt is not available.', 400);
  }
  const groupId = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 3600_000);
  const docs = slides.map((slide, slideIndex) => ({ ...slide, ownerId: viewer, groupId, slideIndex, expiresAt, ...(promptSource ? { promptSource } : {}) }));
  let rows;
  try { rows = await SocialStory.insertMany(docs, { ordered: true }); }
  catch (error) { await SocialStory.deleteMany({ groupId, ownerId: viewer }).catch(console.error); throw error; }
  const ids = [...new Set(slides.map(s=>s.music?.trackId).filter(Boolean))];
  for (const trackId of ids) {
    await StoryMusic.updateOne({ _id: objectId(trackId) }, { $inc: { uses: 1 } });
    await StoryMusicFavorite.updateOne({ userId: viewer, trackId: objectId(trackId) }, { $set: { recentlyUsedAt: new Date() } }, { upsert: true });
  }
  return { groupId, stories: rows.map(x=>({ id: x.id, expiresAt: x.expiresAt })) };
}
router.get('/stories', wrap(async (req) => {
  const rows = await SocialStory.find({ expiresAt: { $gt: new Date() } }).sort({ _id: -1 }).limit(150).lean();
  const allowed = [];
  for (const story of rows) if (await canSeeStory(req.user.id, story)) allowed.push(story);
  const [users, seen, tracks] = await Promise.all([
    usersByIds(allowed.map(s=>s.ownerId)),
    SocialStoryView.find({ viewerId: req.user.id, storyId: { $in: allowed.map(s=>s._id) } }).select('storyId').lean(),
    StoryMusic.find({ _id: { $in: allowed.map(s=>s.music?.trackId).filter(Boolean).map(objectId) } }).lean(),
  ]);
  const viewed = new Set(seen.map(s=>String(s.storyId)));
  const trackMap = new Map(tracks.map(t=>[String(t._id), musicSafe(t)]));
  return allowed.map(s=>({ id: String(s._id), ownerId: s.ownerId, author: users.get(s.ownerId) || { name: 'Account' },
    mediaId: s.mediaId ? String(s.mediaId) : null, mediaKind: s.mediaKind, duration: s.duration || (s.mediaKind === 'video' ? 15 : 10), effects: s.effects || {}, layers: s.layers || [],
    music: s.music ? { ...s.music, track: trackMap.get(s.music.trackId) || null } : null,
    groupId: s.groupId || String(s._id), slideIndex: s.slideIndex || 0, seen: s.ownerId === req.user.id || viewed.has(String(s._id)), createdAt: s.createdAt, expiresAt: s.expiresAt }));
}));
router.post('/stories/batch', wrap(async (req) => {
  const input = body(req, storyBatch.extend({ promptSource: z.object({ storyId: z.string().regex(/^[a-f0-9]{24}$/i), stickerId: z.string().min(1).max(64) }).nullable().optional() }).strict());
  return publishSlides(req.user.id, input.slides, input.promptSource);
}));
router.post('/stories', wrap(async (req) => {
  const input = body(req, z.object({ mediaId: z.string().regex(/^[a-f0-9]{24}$/i), visibility: z.enum(['public','friends','followers']).default('public') }).strict());
  const media = await Media.findOne({ _id: objectId(input.mediaId), ownerId: req.user.id, purpose: 'story', status: 'ready' }).lean();
  if (!media || !['image','gif','video'].includes(media.kind)) throw new AppError('Story media is not ready.', 400);
  const parsed = storySlide.parse({ mediaId: input.mediaId, mediaKind: media.kind, visibility: input.visibility, duration: media.kind === 'video' ? Math.min(15, media.duration || 15) : 10 });
  const result = await publishSlides(req.user.id, [parsed]);
  return { id: result.stories[0].id, mediaId: input.mediaId, expiresAt: result.stories[0].expiresAt };
}));
router.post('/stories/:id/view', wrap(async (req) => {
  const story = await visibleStory(req.user.id, req.params.id);
  await SocialStoryView.updateOne({ storyId: story._id, viewerId: req.user.id }, { $setOnInsert: { storyId: story._id, viewerId: req.user.id, expiresAt: story.expiresAt } }, { upsert: true });
  return { seen: true };
}));
router.delete('/stories/:id', wrap(async (req) => {
  const story = await SocialStory.findOneAndDelete({ _id: objectId(req.params.id), ownerId: req.user.id });
  if (!story) throw new AppError('Story not found or not yours.', 404);
  await Promise.all([SocialStoryView.deleteMany({ storyId: story._id }), StoryStickerResponse.deleteMany({ storyId: story._id })]);
  return { deleted: true };
}));
router.get('/stories/:id/sticker-results', wrap(async (req) => {
  const story = await visibleStory(req.user.id, req.params.id);
  const all = await StoryStickerResponse.find({ storyId: story._id }).lean();
  return story.layers.filter(l=>['poll','question','slider','countdown'].includes(l.type)).map(layer=>{
    const responses = all.filter(r=>r.stickerId === layer.id);
    return { stickerId: layer.id, type: layer.type, count: responses.length,
      ...(layer.type === 'poll' ? { votes: layer.options.map((_,i)=>responses.filter(r=>r.option===i).length) } : {}),
      ...(layer.type === 'slider' ? { average: responses.length ? responses.reduce((s,r)=>s+(r.value||0),0)/responses.length : 0 } : {}),
      ...(layer.type === 'question' && req.user.id === story.ownerId ? { answers: responses.map(r=>({ text:r.answer, userId:r.userId })) } : {}),
      mine: responses.find(r=>r.userId === req.user.id) || null,
    };
  });
}));
router.post('/stories/:id/stickers/:stickerId/respond', wrap(async (req) => {
  const story = await visibleStory(req.user.id, req.params.id);
  if (story.ownerId === req.user.id) throw new AppError('You cannot respond to your own sticker.', 400);
  const sticker = (story.layers || []).find(x=>x.id === req.params.stickerId);
  if (!sticker || !['poll','question','slider','countdown'].includes(sticker.type)) throw new AppError('Sticker is unavailable.', 404);
  const input = body(req, reactionResponse);
  if (input.type !== sticker.type) throw new AppError('Response type does not match sticker.', 400);
  if (sticker.type === 'poll' && input.option >= sticker.options.length) throw new AppError('Invalid poll option.', 400);
  if (sticker.type === 'countdown' && new Date(sticker.endsAt) <= new Date()) throw new AppError('Countdown ended.', 400);
  const response = await StoryStickerResponse.findOneAndUpdate({ storyId: story._id, stickerId: sticker.id, userId: req.user.id }, { $set: { ...input, expiresAt: new Date(story.expiresAt.getTime() + 7 * 86400_000), reminderSentAt: null } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  return { saved: true, id: response.id };
}));
export default router;
