/**
 * LiveKit's Node server SDK (v2.x) expects protobuf TrackSource enum values in
 * VideoGrant.canPublishSources, not the browser SDK's string Track.Source values.
 * These values are defined by livekit_models.proto: CAMERA=1, MICROPHONE=2,
 * SCREEN_SHARE=3, SCREEN_SHARE_AUDIO=4.
 * https://github.com/livekit/protocol/blob/main/protobufs/livekit_models.proto
 */
export const LIVEKIT_TRACK_SOURCE = Object.freeze({
  CAMERA: 1,
  MICROPHONE: 2,
  SCREEN_SHARE: 3,
  SCREEN_SHARE_AUDIO: 4,
});

/** Keep LiveKit track publishing permissions in sync with Aevora's channel ACL. */
export function buildMediaGrant({ room, canSpeak = true, canCamera = true, canShare = true }) {
  const sources = [
    ...(canSpeak ? [LIVEKIT_TRACK_SOURCE.MICROPHONE] : []),
    ...(canCamera ? [LIVEKIT_TRACK_SOURCE.CAMERA] : []),
    ...(canShare
      ? [LIVEKIT_TRACK_SOURCE.SCREEN_SHARE, LIVEKIT_TRACK_SOURCE.SCREEN_SHARE_AUDIO]
      : []),
  ];

  return {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublish: sources.length > 0,
    canPublishData: true,
    ...(sources.length > 0 ? { canPublishSources: sources } : {}),
  };
}
