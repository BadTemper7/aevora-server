import test from "node:test";
import assert from "node:assert/strict";
import { isSupportedReactionEmoji } from "../src/social/reactionOptions.js";

test("reactions accept all standard single emojis, not only the quick set", () => {
  for (const emoji of ["\u{1f44d}", "\u{1f680}", "\u2764\ufe0f", "\u{1f1f5}\u{1f1ed}", "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}", "1\ufe0f\u20e3"]) {
    assert.equal(isSupportedReactionEmoji(emoji), true);
  }
});

test("a reaction must be one emoji grapheme", () => {
  for (const value of ["hello", "\u{1f680}\u{1f680}", "0", "", null, "\u{1f680} hello"]) {
    assert.equal(isSupportedReactionEmoji(value), false);
  }
});
