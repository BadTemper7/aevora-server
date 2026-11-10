import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { maxImageWidth, preferOriginal, percentageSaved, storageMime, videoMaxHeight } from '../src/media/policy.js';

const source = p => readFile(new URL(p, import.meta.url), 'utf8');
test('image policies scale avatars and community icons while keeping wide banners', () => {
  assert.equal(maxImageWidth('avatar'), 512);
  assert.equal(maxImageWidth('community','icon'), 512);
  assert.equal(maxImageWidth('cover'), 1920);
  assert.equal(maxImageWidth('community','banner'), 1920);
});
test('skip compression that grows files; preserve EXIF orientation cases', () => {
  const base = { mime: 'image/jpeg', width: 1280, height: 720, maxWidth: 1920, orientation: 1 };
  assert.equal(preferOriginal({ ...base, originalBytes: 1000, optimizedBytes: 1500 }), true);
  assert.equal(preferOriginal({ ...base, originalBytes: 1500, optimizedBytes: 1000 }), false);
  assert.equal(preferOriginal({ ...base, orientation: 8, originalBytes: 1000, optimizedBytes: 1500 }), false);
  assert.equal(preferOriginal({ ...base, width: 4000, originalBytes: 1000, optimizedBytes: 1500 }), false);
});
test('computed savings are bounded and MIME matches saved format', () => {
  assert.equal(percentageSaved(12000000,2800000),76.7);
  assert.equal(percentageSaved(100,200),0);
  assert.equal(storageMime('gif','image/gif',true),'image/gif');
  assert.equal(storageMime('gif','image/gif',false),'image/webp');
  assert.equal(storageMime('video','video/quicktime',false),'video/mp4');
  assert.ok(videoMaxHeight() >= 480);
});
test('no direct public link bypasses private media authorization', async () => {
  const routes = await source('../src/media/routes.js');
  assert.ok(routes.includes('await authorizeMedia(req, media)'));
  assert.ok(routes.includes("status !== 'ready'"));
  assert.ok(routes.includes('signedPrivateDownload(key, 60)'));
});
test('worker only marks ready after the object upload succeeds', async () => {
  const worker = await source('../src/media/processor.js');
  const store = worker.indexOf('putPrivateObject({ objectKey, filename: effective, mime })');
  const ready = worker.indexOf("status: 'ready', storageProvider:", store);
  assert.ok(store >= 0 && ready > store);
  assert.ok(worker.includes('thumbObjectKey'));
  assert.ok(worker.includes('status: \'failed\''));
});
test('R2 duplication remains scoped to same owner and purpose', async () => {
  const worker = await source('../src/media/processor.js');
  assert.match(worker, /ownerId:\s*item\.ownerId, purpose:\s*item\.purpose, checksum/);
});
test('production-compatible scanner fails closed when unavailable', async () => {
  const { scanUploadedFile } = await import('../src/media/scan.js');
  const previous = process.env.MALWARE_SCAN_MODE;
  const previousCommand = process.env.CLAMAV_COMMAND;
  process.env.MALWARE_SCAN_MODE = 'required';
  process.env.CLAMAV_COMMAND = '__missing_aevora_clamav_executable__';
  try {
    await assert.rejects(scanUploadedFile('/tmp/not-an-upload'), error => error.statusCode === 503);
  } finally {
    if (previous === undefined) delete process.env.MALWARE_SCAN_MODE; else process.env.MALWARE_SCAN_MODE = previous;
    if (previousCommand === undefined) delete process.env.CLAMAV_COMMAND; else process.env.CLAMAV_COMMAND = previousCommand;
  }
});
