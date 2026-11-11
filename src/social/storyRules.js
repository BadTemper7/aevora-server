import { z } from 'zod';

export const storyVisibility = z.enum(['public', 'friends', 'followers']);
const xy = z.number().finite().min(0).max(100);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff');
const position = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), x: xy.default(50), y: xy.default(50), rotation: z.number().min(-180).max(180).default(0), size: z.number().min(0.3).max(3).default(1) };
const textLayer = z.object({ ...position, type: z.literal('text'), text: z.string().trim().min(1).max(250), color, background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), font: z.enum(['sans','serif','mono']).default('sans'), align: z.enum(['left','center','right']).default('center'), bold: z.boolean().default(false), italic: z.boolean().default(false) }).strict();
const drawingLayer = z.object({ ...position, type: z.literal('drawing'), path: z.string().regex(/^[ML0-9 .,\-]{2,4000}$/), color, strokeWidth: z.number().min(0.2).max(8).default(1) }).strict();
const emojiLayer = z.object({ ...position, type: z.literal('emoji'), emoji: z.string().min(1).max(64) }).strict();
const gifLayer = z.object({ ...position, type: z.literal('gif'), url: z.string().url().refine(v => {
  try { return new URL(v).protocol === 'https:' && /(^|\.)giphy\.com$/.test(new URL(v).hostname); } catch { return false; }
}, 'Use an approved GIPHY GIF URL') }).strict();
const imageStickerLayer = z.object({ ...position, type: z.literal('image'), mediaId: z.string().regex(/^[a-f0-9]{24}$/i) }).strict();
const locationLayer = z.object({ ...position, type: z.literal('location'), label: z.string().trim().min(2).max(100) }).strict();
const mentionLayer = z.object({ ...position, type: z.literal('mention'), username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/) }).strict();
const pollLayer = z.object({ ...position, type: z.literal('poll'), question: z.string().trim().min(1).max(120), options: z.array(z.string().trim().min(1).max(60)).min(2).max(4) }).strict();
const questionLayer = z.object({ ...position, type: z.literal('question'), question: z.string().trim().min(1).max(140) }).strict();
const sliderLayer = z.object({ ...position, type: z.literal('slider'), question: z.string().trim().min(1).max(140), emoji: z.string().min(1).max(64) }).strict();
const countdownLayer = z.object({ ...position, type: z.literal('countdown'), label: z.string().trim().min(1).max(80), endsAt: z.string().datetime() }).strict();
const linkLayer = z.object({ ...position, type: z.literal('link'), label: z.string().trim().min(1).max(60), url: z.string().url().refine(v => /^https:\/\//.test(v), 'Use a secure HTTPS link') }).strict();
const promptLayer = z.object({ ...position, type: z.literal('add_yours'), prompt: z.string().trim().min(1).max(120) }).strict();
export const storyLayer = z.discriminatedUnion('type', [textLayer, drawingLayer, emojiLayer, gifLayer, imageStickerLayer, locationLayer, mentionLayer, pollLayer, questionLayer, sliderLayer, countdownLayer, linkLayer, promptLayer]);
export const storyEffects = z.object({ background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#17172b'), fit: z.enum(['contain','cover']).default('contain'), blurBackground: z.boolean().default(false), zoom: z.number().min(1).max(3).default(1), positionX: xy.default(50), positionY: xy.default(50), rotate: z.number().min(-180).max(180).default(0), brightness: z.number().min(0.3).max(2).default(1), contrast: z.number().min(0.3).max(2).default(1), saturation: z.number().min(0).max(3).default(1), trimStart: z.number().min(0).max(3600).default(0), trimEnd: z.number().min(0).max(3600).default(0) }).strict();
export const storyMusicSettings = z.object({ trackId: z.string().regex(/^[a-f0-9]{24}$/i), start: z.number().min(0).max(3600).default(0), volume: z.number().min(0).max(1).default(0.7), originalVolume: z.number().min(0).max(1).default(1), style: z.enum(['hidden','cover','title','minimal','animated']).default('title'), fadeIn: z.number().min(0).max(3).default(0), fadeOut: z.number().min(0).max(3).default(0), x: xy.default(50), y: xy.default(82), size: z.number().min(.5).max(2).default(1) }).strict();
export const storySlide = z.object({ mediaId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().default(null), mediaKind: z.enum(['image','gif','video','text']), duration: z.number().min(3).max(60).default(10), visibility: storyVisibility.default('public'), effects: storyEffects.default({}), layers: z.array(storyLayer).max(24).default([]), music: storyMusicSettings.nullable().default(null) }).strict().superRefine((slide, ctx) => {
  if (slide.mediaKind !== 'text' && !slide.mediaId) ctx.addIssue({ code: 'custom', message: 'A photo or video is required.', path: ['mediaId'] });
  if (slide.mediaKind === 'text' && slide.mediaId) ctx.addIssue({ code: 'custom', message: 'Text stories cannot include an uploaded background.', path: ['mediaId'] });
  if (slide.mediaKind === 'video' && slide.effects.trimEnd && slide.effects.trimEnd <= slide.effects.trimStart) ctx.addIssue({ code:'custom', message:'Video end time must be after start.', path:['effects','trimEnd'] });
  if (new Set(slide.layers.map(x=>x.id)).size !== slide.layers.length) ctx.addIssue({ code:'custom', message:'Every sticker must have a unique ID.', path:['layers'] });
});
export const storyBatch = z.object({ slides: z.array(storySlide).min(1).max(10) }).strict();
export const reactionResponse = z.discriminatedUnion('type', [
 z.object({ type:z.literal('poll'), option:z.number().int().min(0).max(3) }),
 z.object({ type:z.literal('question'), answer:z.string().trim().min(1).max(500) }),
 z.object({ type:z.literal('slider'), value:z.number().min(0).max(100) }),
 z.object({ type:z.literal('countdown'), remind:z.boolean() }),
]);
export const musicInput = z.object({ mediaId:z.string().regex(/^[a-f0-9]{24}$/i), title:z.string().trim().min(1).max(120), artist:z.string().trim().min(1).max(120), genre:z.string().trim().max(50).default('Other'), mood:z.string().trim().max(50).default('Other'), visibility:z.enum(['public','private']).default('private'), rightsType:z.enum(['original','licensed']), rightsConfirmed:z.literal(true), coverId: z.string().regex(/^[a-f0-9]{24}$/i).nullable().default(null) }).strict();
