import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildObjectPrefix, normalizeObjectKey } from '../src/storage/imagekitPaths.js';
const text = (file) => readFile(new URL(file, import.meta.url), 'utf8');

test('ImageKit object keys are namespaced by owner and content purpose', () => {
  assert.equal(buildObjectPrefix({ kind: 'image', purpose: 'avatar', ownerId: 'user-1', entityId: '123' }), 'aevora/users/user-1/avatars/123');
  assert.equal(buildObjectPrefix({ kind: 'file', purpose: 'unknown', ownerId: 'one', entityId: '2' }), 'aevora/documents/one/2');
  assert.equal(buildObjectPrefix({ kind: 'video', purpose: 'message', ownerId: 'A/B', entityId: 'ok' }), 'aevora/messages/A_B/attachments/ok');
});
test('ImageKit path sanitization rejects traversal and unsafe URL characters', () => {
  assert.equal(normalizeObjectKey('/aevora/users/owner/abc.webp'), 'aevora/users/owner/abc.webp');
  for (const input of ['../secret', 'files//x', '/foo/./x', 'file?x=1', 'foo#frag', 'file\\name']) assert.throws(() => normalizeObjectKey(input));
});
test('ImageKit is the only active cloud provider for new uploads', async () => {
  const worker = await text('../src/media/processor.js');
  const routes = await text('../src/media/routes.js');
  const env = await text('../src/config/env.js');
  assert.ok(worker.includes("storageMode === 'imagekit'"));
  assert.ok(worker.includes("storageProvider: 'imagekit'"));
  assert.ok(routes.includes("storageProvider: storageMode === 'imagekit' ? 'imagekit' : 'local'"));
  assert.ok(env.includes("['local', 'imagekit']"));
});
test('Permanent upload happens only after processing, and data is marked ready afterwards', async () => {
  const worker = await text('../src/media/processor.js');
  const optimize = worker.indexOf("const finalSize = (await stat(effective)).size");
  const upload = worker.indexOf('await putPrivateObject({ objectKey:');
  const ready = worker.indexOf("status: 'ready', storageProvider:", upload);
  assert.ok(optimize > 0 && upload > optimize && ready > upload);
  assert.ok(worker.includes('storageFileId: fileId'));
  assert.ok(worker.includes('ownerId: item.ownerId, purpose: item.purpose, checksum'));
});
test('Uploads are private and signed download is server-only', async () => {
  const storage = await text('../src/storage/imagekit.js');
  const routes = await text('../src/media/routes.js');
  assert.match(storage, /isPrivateFile:\s*true/);
  assert.match(storage, /signed:\s*true/);
  assert.ok(routes.includes('await authorizeMedia(req, media)'));
  assert.ok(routes.includes("status !== 'ready'"));
  assert.ok(storage.includes("privateKey: env.IMAGEKIT_PRIVATE_KEY"));
});
test('Old media stays supported in local and R2 read branches', async () => {
  const routes = await text('../src/media/routes.js');
  assert.ok(routes.includes("'cloudflare-r2'"));
  assert.ok(routes.includes("media.storageProvider === 'imagekit'"));
  assert.ok(routes.includes('createReadStream(filename'));
});
