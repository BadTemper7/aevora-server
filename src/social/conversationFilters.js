/** Conversation categories are persisted metadata; never create fake rows. */
export function conversationMatchesTab(conversation, member, tab = "inbox") {
  if (!member || member.requestState === "rejected") return false;
  if (tab === "requests") return member.requestState === "pending";
  if (!member.accepted) return false;
  if (tab === "archived") return Boolean(member.archived);
  if (member.archived) return false;
  if (member.hiddenAt && (!conversation.lastMessageAt || new Date(conversation.lastMessageAt) <= new Date(member.hiddenAt))) return false;
  if (tab === "marketplace") return conversation.contextType === "marketplace";
  if (tab === "groups") return conversation.type === "group" && conversation.contextType !== "marketplace";
  return conversation.type === "direct" && conversation.contextType !== "marketplace";
}
