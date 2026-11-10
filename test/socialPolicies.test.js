import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAudience, evaluateMessagePolicy } from "../src/social/policyRules.js";

test("friendship required by friends-only messaging", () => {
  assert.deepEqual(evaluateMessagePolicy({ messagePolicy:"friends" }, "someone"), { allowed:false, request:false });
  assert.deepEqual(evaluateMessagePolicy({ messagePolicy:"friends" }, "someone", { friends:true }), { allowed:true, request:false });
});
test("anyone policy sends unknown people to message requests", () => {
  assert.deepEqual(evaluateMessagePolicy({ messagePolicy:"anyone" }, "someone"), { allowed:true, request:true });
  assert.deepEqual(evaluateMessagePolicy({ messagePolicy:"anyone" }, "someone", { friends:true }), { allowed:true, request:false });
});
test("explicit deny and blocking override custom allows", () => {
  const p = { messagePolicy:"custom", allowUsers:["jane"], denyUsers:["jane"], allowFriends:true };
  assert.equal(evaluateMessagePolicy(p,"jane",{friends:true}).allowed,false);
  assert.equal(evaluateMessagePolicy({ ...p, denyUsers:[] },"jane",{blocked:true}).allowed,false);
});
test("custom follower and subscriber permissions are independent", () => {
  const p = { messagePolicy:"custom", allowFriends:false,allowFollowers:true,allowSubscribers:false };
  assert.deepEqual(evaluateMessagePolicy(p,"jane",{follower:true}),{allowed:true,request:true});
  assert.equal(evaluateMessagePolicy(p,"jane",{subscriber:true}).allowed,false);
});
test("privacy audience enforces friends, subscribers and blocks", () => {
  assert.equal(evaluateAudience("friends",{friends:true}),true);
  assert.equal(evaluateAudience("friends",{follower:true}),false);
  assert.equal(evaluateAudience("subscribers",{subscriber:true}),true);
  assert.equal(evaluateAudience("public",{blocked:true}),false);
  assert.equal(evaluateAudience("private",{self:true}),true);
});
