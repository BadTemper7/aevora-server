import { audienceAllows, blocked, isFollower, isFriend, privacyFor } from "./helpers.js";

// Feed and media-file endpoints intentionally share these authorization checks.
export async function canSeePost(viewer, post) {
  if (viewer === post.ownerId) return true;
  if (await blocked(viewer, post.ownerId)) return false;
  const privacy = await privacyFor(post.ownerId);
  if (privacy.privateProfile && !await isFriend(viewer, post.ownerId) && !await isFollower(viewer, post.ownerId)) return false;
  if (!await audienceAllows(viewer, post.ownerId, privacy.profileVisibility || "public")) return false;
  return audienceAllows(viewer, post.ownerId, post.visibility);
}

export async function canSeeStory(viewer, story) {
  if (new Date(story.expiresAt).getTime() <= Date.now()) return false;
  if (viewer === story.ownerId) return true;
  if (await blocked(viewer, story.ownerId)) return false;
  const privacy = await privacyFor(story.ownerId);
  if (privacy.privateProfile && !await isFriend(viewer, story.ownerId) && !await isFollower(viewer, story.ownerId)) return false;
  if (!await audienceAllows(viewer, story.ownerId, privacy.profileVisibility || "public")) return false;
  return audienceAllows(viewer, story.ownerId, story.visibility);
}
