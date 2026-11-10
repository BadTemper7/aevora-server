import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsStoredThumbnail, isDynamicImageThumbnail } from '../src/media/thumbnailPolicy.js';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('ImageKit stores exactly one optimized image or GIF, but videos retain poster frames', () => {
  for (const kind of ['image','gif']) assert.equal(needsStoredThumbnail(kind, 'imagekit'), false, kind);
  assert.equal(needsStoredThumbnail('video', 'imagekit'), true);
  assert.equal(needsStoredThumbnail('file', 'imagekit'), false);
  assert.equal(needsStoredThumbnail('image', 'local'), true);
});

test('image thumbnails use the signed transformed original when no separate file exists', () => {
  assert.equal(isDynamicImageThumbnail({ storageProvider: 'imagekit', kind: 'image', objectKey: 'a', thumbObjectKey: null }), true);
  assert.equal(isDynamicImageThumbnail({ storageProvider: 'imagekit', kind: 'gif', objectKey: 'a', thumbObjectKey: null }), true);
  assert.equal(isDynamicImageThumbnail({ storageProvider: 'imagekit', kind: 'video', objectKey: 'a', thumbObjectKey: null }), false);
  assert.equal(isDynamicImageThumbnail({ storageProvider: 'imagekit', kind: 'image', objectKey: 'a', thumbObjectKey: 'oldthumb' }), false);
  assert.equal(isDynamicImageThumbnail({ storageProvider: 'local', kind: 'image', objectKey: 'a' }), false);
  const adapter = source('../src/storage/imagekit.js');
  const routes = source('../src/media/routes.js');
  assert.match(adapter, /signed: true/);
  assert.match(adapter, /transformThumbnail \? \{ transformation:/);
  assert.match(routes, /const dynamicThumbnail = thumbnail && isDynamicImageThumbnail\(media\)/);
  assert.match(routes, /streamPrivateObject\(objectKey, range, dynamicThumbnail\)/);
});

test('mixed attachment metadata is returned in paginated and real-time messages', () => {
  const routes = source('../src/social/messageRoutes.js');
  const models = source('../src/social/models.js');
  assert.match(models, /"mixed"/);
  assert.match(routes, /z\.enum\(\["text", "image", "video", "gif", "file", "mixed"\]\)/);
  assert.match(routes, /hydrateMessageAttachments\(visible\)/);
  assert.match(routes, /void emitNewMessage\(c, storedMessage\)/);
  assert.match(routes, /return storedMessage/);
  assert.match(routes, /asset\.kind/);
});
