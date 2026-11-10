import assert from "node:assert/strict";
import test from "node:test";
import { conversationMatchesTab } from "../src/social/conversationFilters.js";

const direct = { type: "direct", contextType: "general" };
const group = { type: "group", contextType: "general" };
const marketplace = { type: "direct", contextType: "marketplace" };
const member = { accepted: true, requestState: "accepted" };

test("Inbox includes accepted direct messages only", () => {
  assert.equal(conversationMatchesTab(direct, member, "inbox"), true);
  assert.equal(conversationMatchesTab(group, member, "inbox"), false);
  assert.equal(conversationMatchesTab(marketplace, member, "inbox"), false);
});
test("Marketplace and Groups use actual conversation metadata", () => {
  assert.equal(conversationMatchesTab(marketplace, member, "marketplace"), true);
  assert.equal(conversationMatchesTab(direct, member, "marketplace"), false);
  assert.equal(conversationMatchesTab(group, member, "groups"), true);
  assert.equal(conversationMatchesTab(marketplace, member, "groups"), false);
});
test("Pending requests, archived and hidden chats remain separated", () => {
  const pending = { accepted: false, requestState: "pending" };
  assert.equal(conversationMatchesTab(direct, pending, "requests"), true);
  assert.equal(conversationMatchesTab(direct, pending, "inbox"), false);
  assert.equal(conversationMatchesTab(direct, { ...member, archived: true }, "archived"), true);
  assert.equal(conversationMatchesTab(direct, { ...member, archived: true }, "inbox"), false);
  assert.equal(conversationMatchesTab({ ...direct, lastMessageAt: "2026-11-01" }, { ...member, hiddenAt: "2026-11-02" }, "inbox"), false);
  assert.equal(conversationMatchesTab(direct, { ...member, requestState: "rejected" }, "requests"), false);
});
