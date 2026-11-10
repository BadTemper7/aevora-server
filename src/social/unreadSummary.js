/** MongoDB pipeline: persisted per-member read positions, no per-chat N+1 counts. */
export function conversationUnreadPipeline(userId, blockedIds = [], now = new Date()) {
  const minimum = new Date(0);
  return [
    { $match: { members: { $elemMatch: { userId, accepted: true } } } },
    { $project: { member: { $arrayElemAt: [{ $filter: {
      input: '$members', as: 'm', cond: { $eq: ['$$m.userId', userId] },
    } }, 0] } } },
    { $lookup: {
      from: 'social_messages', let: {
        cid: '$_id', since: { $max: [
          { $ifNull: ['$member.lastReadAt', minimum] },
          { $ifNull: ['$member.hiddenAt', minimum] },
        ] },
      },
      pipeline: [
        { $match: { $expr: { $and: [
          { $eq: ['$conversationId', '$$cid'] },
          { $gt: ['$createdAt', '$$since'] },
        ] } } },
        { $match: {
          senderId: { $nin: [userId, ...blockedIds] }, hiddenFor: { $ne: userId },
          deletedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
        } },
        { $count: 'count' },
      ],
      as: 'unreadRows',
    } },
    { $project: {
      count: { $ifNull: [{ $arrayElemAt: ['$unreadRows.count', 0] }, 0] },
      manuallyUnread: '$member.manuallyUnread',
    } },
    { $group: {
      _id: null,
      unread: { $sum: '$count' },
      conversations: { $sum: { $cond: [
        { $or: [{ $gt: ['$count', 0] }, { $eq: ['$manuallyUnread', true] }] }, 1, 0,
      ] } },
    } },
  ];
}
