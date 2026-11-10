/** Pure policy decisions, shared by services and unit-tested independently of MongoDB. */
export function evaluateMessagePolicy(p, sender, { blocked = false, friends = false, follower = false, subscriber = false } = {}) {
  if (blocked || p.denyUsers?.includes(sender)) return { allowed: false, request: false };
  if (p.allowUsers?.includes(sender)) return { allowed: true, request: false };
  if (p.messagePolicy === "anyone") return { allowed: true, request: !friends };
  if (p.messagePolicy === "friends") return { allowed: friends, request: false };
  if (p.messagePolicy === "custom") {
    const allowed = Boolean((p.allowFriends && friends) || (p.allowFollowers && follower) || (p.allowSubscribers && subscriber));
    return { allowed, request: allowed && !friends };
  }
  return { allowed: false, request: false };
}
export function evaluateAudience(audience, { self = false, blocked = false, friends = false, follower = false, subscriber = false } = {}) {
  if (self) return true;
  if (blocked) return false;
  switch (audience) {
    case "public": case "everyone": return true;
    case "friends": return friends;
    case "followers": return follower;
    case "subscribers": return subscriber;
    default: return false;
  }
}
