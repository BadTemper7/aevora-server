// Suggested quick reactions only. Any single valid Unicode emoji can also be
// selected from the full picker. Reactions are still one-per-user-per-message.
export const MESSAGE_REACTIONS = Object.freeze(["\u{1f44d}", "\u2764\ufe0f", "\u{1f606}", "\u{1f62e}", "\u{1f622}", "\u{1f389}"]);

export function isSupportedReactionEmoji(value) {
  if (typeof value !== "string" || !value.length || value.length > 64) return false;
  if (!/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u20e3]/u.test(value)) return false;
  if (/[\s\p{Cc}]/u.test(value)) return false;
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
  const first = graphemes[Symbol.iterator]();
  const current = first.next();
  return !current.done && current.value.segment === value && first.next().done;
}
