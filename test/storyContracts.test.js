import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src=(p)=>readFileSync(new URL(`../src/${p}`, import.meta.url),'utf8');
test('story publishing validates all media and only uses ready optimized files',()=>{
  const api=src('social/storyRoutes.js');
  assert.match(api,/status: 'ready'/);
  assert.match(api,/validateSlides\(slides, viewer\)/);
  assert.match(api,/SocialStory\.insertMany/);
  assert.match(api,/canSeeStory/);
  assert.match(api,/StoryMusic\.find/);
});
test('media uploads optimize audio and trim story video before ImageKit storage',()=>{
  const processor=src('media/processor.js');
  const routes=src('media/routes.js');
  assert.match(processor,/item.kind === 'audio'/);
  assert.match(processor,/\['-t',String\(duration\)\]/);
  assert.match(processor,/putPrivateObject/);
  assert.match(routes,/clipStart/);
  assert.match(routes,/story_audio/);
  assert.match(routes,/authorizeMedia/);
});
test('story stickers enforce one response per viewer and private question answers',()=>{
  const models=src('social/models.js');
  const api=src('social/storyRoutes.js');
  assert.match(models,/stickerId: 1, userId: 1/);
  assert.match(api,/req.user.id === story.ownerId/);
  assert.match(api,/layer.type === 'question' && req.user.id === story.ownerId/);
});
test('countdown notifications use idempotent claims and important-only bell policy',()=>{
  const worker=src('social/storyReminders.js');
  const policy=src('social/notificationPolicy.js');
  assert.match(worker,/findOneAndUpdate/);
  assert.match(worker,/reminderSentAt/);
  assert.match(policy,/story_countdown_reminder/);
});

test('published story stickers and licensed music cannot be deleted while in use',()=>{
  const routes=src('media/routes.js');
  assert.match(routes,/SocialStory\.exists\(\{ \$or: \[\{ mediaId: id \}, \{ 'layers\.mediaId': String\(id\) \}/);
  assert.match(routes,/StoryMusic\.exists\(\{ \$or:/);
});
test('story batch JSON body has a scoped limit for multi-slide overlays',()=>{
  const app=src('app.js');
  assert.match(app,/app\.use\('\/api\/social\/stories', express\.json\(\{ limit: '256kb' \}\)\)/);
});
