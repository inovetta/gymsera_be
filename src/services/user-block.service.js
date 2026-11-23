'use strict';
/**
 * NEW-256: blocking in chat (App Store 1.2, Google Play UGC policy).
 *
 * Chat is between a traveller (`conversations.user_id`) and a gym (`conversations.tenant_id`), so a
 * block is between those two: the traveller blocks the gym (blocked_by USER) or the gym blocks the
 * traveller (blocked_by TENANT). While either row exists:
 *   - no message is accepted in either direction (inbox.service calls assertCanMessage on every send);
 *   - the side that blocked no longer sees the conversation in its inbox list.
 * Unblocking removes only the caller's own side's row.
 */
const { Op } = require('sequelize');
const { UserBlock, Conversation, GymListing, User, Tenant } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const { BlockSide } = require('../constants/moderation');

/** { blockedByUser, blockedByTenant } for one traveller and one gym. */
const getBlockState = async (userId, tenantId) => {
  if (!userId || !tenantId) return { blockedByUser: false, blockedByTenant: false };
  const rows = await UserBlock.findAll({ where: { userId, tenantId }, attributes: ['blockedBy'] });
  const sides = new Set(rows.map((r) => r.blockedBy));
  return { blockedByUser: sides.has(BlockSide.USER), blockedByTenant: sides.has(BlockSide.ORGANIZATION) };
};

/** The block state as the given side sees it (what the clients show). */
const blockStateFor = async (conversation, side) => {
  const s = await getBlockState(conversation.userId, conversation.tenantId);
  const mine = side === BlockSide.USER ? s.blockedByUser : s.blockedByTenant;
  const theirs = side === BlockSide.USER ? s.blockedByTenant : s.blockedByUser;
  return { blockedByMe: mine, blockedByOther: theirs, canSend: !mine && !theirs };
};

/**
 * Refuses a message between a blocked pair with 403 `conversation_blocked`. `senderSide` words the
 * refusal: the side that blocked is told how to undo it; the other side is not told who blocked.
 */
const assertCanMessage = async (userId, tenantId, senderSide) => {
  const s = await getBlockState(userId, tenantId);
  if (!s.blockedByUser && !s.blockedByTenant) return;
  const blockedByMe = senderSide === BlockSide.USER ? s.blockedByUser : s.blockedByTenant;
  throw createError(
    blockedByMe
      ? 'You blocked this conversation. Unblock it to send messages.'
      : 'You can no longer send messages in this conversation.',
    403,
    'conversation_blocked'
  );
};

/** Blocks the other side of a conversation. Idempotent. */
const block = async (conversation, side, actorUserId) => {
  const [row] = await UserBlock.findOrCreate({
    where: { userId: conversation.userId, tenantId: conversation.tenantId, blockedBy: side },
    defaults: { createdByUserId: actorUserId },
  });
  return row;
};

/** Removes the caller's side's block. Idempotent. */
const unblock = async (conversation, side) => {
  await UserBlock.destroy({
    where: { userId: conversation.userId, tenantId: conversation.tenantId, blockedBy: side },
  });
};

/** Tenant ids a traveller has blocked (their conversations are hidden from the traveller). */
const tenantIdsBlockedByUser = async (userId) =>
  (await UserBlock.findAll({ where: { userId, blockedBy: BlockSide.USER }, attributes: ['tenantId'] })).map((r) => r.tenantId);

/** Traveller ids a gym has blocked (their conversations are hidden from the gym). */
const userIdsBlockedByTenant = async (tenantId) =>
  (await UserBlock.findAll({ where: { tenantId, blockedBy: BlockSide.ORGANIZATION }, attributes: ['userId'] })).map((r) => r.userId);

/** The newest conversation of each (user, tenant) pair, for "Unblock" in the lists. */
const latestConversations = async (pairs) => {
  if (!pairs.length) return new Map();
  const rows = await Conversation.findAll({
    where: { [Op.or]: pairs.map(({ userId, tenantId }) => ({ userId, tenantId })) },
    include: [{ model: GymListing, as: 'gymListing', attributes: ['id', 'title'] }],
    order: [['lastMessageAt', 'DESC']],
  });
  const map = new Map();
  for (const c of rows) {
    const key = `${c.userId}:${c.tenantId}`;
    if (!map.has(key)) map.set(key, c);
  }
  return map;
};

/** Settings › Blocked: the gyms this traveller blocked. */
const listForUser = async (userId) => {
  const rows = await UserBlock.findAll({
    where: { userId, blockedBy: BlockSide.USER },
    include: [{ model: Tenant, as: 'tenant', attributes: ['id', 'businessName'] }],
    order: [['createdAt', 'DESC']],
  });
  const convs = await latestConversations(rows.map((r) => ({ userId: r.userId, tenantId: r.tenantId })));
  return rows.map((r) => {
    const c = convs.get(`${r.userId}:${r.tenantId}`);
    return {
      tenantId: r.tenantId,
      name: c?.gymListing?.title || r.tenant?.businessName || 'Gym',
      conversationId: c?.id || null,
      blockedAt: r.createdAt,
    };
  });
};

/** Host inbox › Blocked: the travellers this gym blocked. */
const listForTenant = async (tenantId) => {
  const rows = await UserBlock.findAll({
    where: { tenantId, blockedBy: BlockSide.ORGANIZATION },
    include: [{ model: User, as: 'user', attributes: ['id', 'fullName', 'profileImageUrl'] }],
    order: [['createdAt', 'DESC']],
  });
  const convs = await latestConversations(rows.map((r) => ({ userId: r.userId, tenantId: r.tenantId })));
  return rows.map((r) => {
    const c = convs.get(`${r.userId}:${r.tenantId}`);
    return {
      userId: r.userId,
      name: r.user?.fullName || 'Traveller',
      profileImageUrl: r.user?.profileImageUrl || null,
      conversationId: c?.id || null,
      blockedAt: r.createdAt,
    };
  });
};

module.exports = {
  getBlockState,
  blockStateFor,
  assertCanMessage,
  block,
  unblock,
  tenantIdsBlockedByUser,
  userIdsBlockedByTenant,
  listForUser,
  listForTenant,
};
