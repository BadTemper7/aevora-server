import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVEKIT_TRACK_SOURCE, buildMediaGrant } from '../src/communities/trackSources.js';

const room = 'aevora-community-test';

test('LiveKit track sources match protocol enum values and are numeric', () => {
  assert.deepEqual(LIVEKIT_TRACK_SOURCE, {
    CAMERA: 1, MICROPHONE: 2, SCREEN_SHARE: 3, SCREEN_SHARE_AUDIO: 4,
  });
  assert(Object.values(LIVEKIT_TRACK_SOURCE).every(Number.isInteger));
});

test('standard voice/video token grant permits all requested tracks', () => {
  assert.deepEqual(buildMediaGrant({ room }), {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
    canPublishSources: [2, 1, 3, 4],
  });
});

test('voice-only token grant excludes camera and screen sharing', () => {
  const grant = buildMediaGrant({ room, canCamera: false, canShare: false });
  assert.deepEqual(grant.canPublishSources, [LIVEKIT_TRACK_SOURCE.MICROPHONE]);
});

test('stage audience can subscribe but cannot publish media', () => {
  const grant = buildMediaGrant({ room, canSpeak: false, canCamera: false, canShare: false });
  assert.equal(grant.canPublish, false);
  assert.equal(grant.canSubscribe, true);
  assert.equal(Object.hasOwn(grant, 'canPublishSources'), false);
});

test('screen-sharing permission controls video and screen audio together', () => {
  const grant = buildMediaGrant({ room, canSpeak: false, canCamera: false });
  assert.deepEqual(grant.canPublishSources, [
    LIVEKIT_TRACK_SOURCE.SCREEN_SHARE,
    LIVEKIT_TRACK_SOURCE.SCREEN_SHARE_AUDIO,
  ]);
});

// When dependencies are installed, also verify the actual LiveKit encoder. This
// optional test is skipped in source-only environments without npm packages.
const sdk = await import('livekit-server-sdk').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

test('LiveKit Server SDK serializes the grant into a valid signed JWT', { skip: !sdk }, async () => {
  const token = new sdk.AccessToken('test-api-key', 'test-secret-at-least-32-characters-long', {
    identity: 'test-user-id',
    ttl: '2m',
  });
  token.addGrant(buildMediaGrant({ room }));
  const jwt = await token.toJwt();
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.video.room, room);
  assert.deepEqual(payload.video.canPublishSources, ['microphone', 'camera', 'screen_share', 'screen_share_audio']);
});
