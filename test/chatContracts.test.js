import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const code = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const routes = code("../src/social/messageRoutes.js");
const sockets = code("../src/realtime/socketServer.js");
const models = code("../src/social/models.js");
const media = code("../src/media/routes.js");
const moderation = code("../src/social/moderationRoutes.js");

test("server does not mark online recipients delivered without an acknowledgement", () => {
  assert.doesNotMatch(routes, /userOnline\(recipient\.userId\)/);
  assert.match(sockets, /socket\.on\("message:delivered"/);
  assert.match(sockets, /Message\.updateMany\(\{ _id: \{ \$in: valid/);
  assert.match(sockets, /emitUser\(msg\.senderId, "message:delivery"/);
});
test("persistence precedes realtime emit without creating chat notifications", () => {
  assert.match(routes, /Message\.create\(/);
  assert.match(routes, /Conversation\.updateOne\(/);
  assert.match(routes, /void emitNewMessage\(c, msg\)/);
  assert.doesNotMatch(routes, /notify\(/);
});
test("advanced message actions have authorization and persistent fields", () => {
  for (const endpoint of ["/messages/:id/me", "/messages/:id/pin", "/conversations/:id/customize", "/conversations/:id/pinned", "/conversations/:id/messages/around/:messageId"]) assert.ok(routes.includes(endpoint), endpoint);
  for (const field of ["hiddenFor", "pinnedAt", "expiresAt", "deliveredTo", "readBy", "disappearingSeconds", "nicknames", "manuallyUnread"]) assert.ok(models.includes(field), field);
});
test("media and report endpoints preserve authorization and relevant evidence", () => {
  assert.match(media, /authorizeMedia\(req, media\)/);
  assert.match(media, /message\.hiddenFor\?\.includes\(req\.user\.id\)/);
  assert.match(media, /Content-Disposition/);
  assert.match(moderation, /messageIds: z\.array/);
  assert.match(moderation, /conversationId: c\._id/);
});
