const { Conversation, Message, User, GymListing } = require('../models/platform');
const { Op } = require('sequelize');
const userBlocks = require('./user-block.service');
const moderationWords = require('./moderation-words.service');
const { BlockSide } = require('../constants/moderation');

/**
 * RT-05: parse the client's idempotency key. Absent -> null (legacy clients keep working).
 */
const parseClientMessageId = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 64) {
    const err = new Error('clientMessageId must be a string of 1-64 characters');
    err.statusCode = 400;
    throw err;
  }
  return value.trim();
};

/**
 * Creates the message, or returns the one this sender already stored under the same key
 * (resend, retry, double tap, concurrent duplicates). `created` tells the caller whether to
 * run side effects (unread counters, notifications, socket broadcast).
 */
const createMessageOnce = async (attrs, rawClientMessageId) => {
  const clientMessageId = parseClientMessageId(rawClientMessageId);
  if (!clientMessageId) return { message: await Message.create(attrs), created: true };

  const lookup = () =>
    Message.findOne({
      where: { conversationId: attrs.conversationId, senderId: attrs.senderId, clientMessageId },
    });
  const existing = await lookup();
  if (existing) return { message: existing, created: false };
  try {
    return { message: await Message.create({ ...attrs, clientMessageId }), created: true };
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    const winner = await lookup();
    if (!winner) throw err;
    return { message: winner, created: false };
  }
};

/**
 * API contract v2 A3 J6: a conversation nests `business { id, name }` (was `gymListing { id, title, logoUrl, branchId }`) and
 * `branchName` (read from the organization's database; null when it cannot be read). The conversation's own
 * `branchId` and `organizationId` stay. Takes one conversation or a list (model rows or plain objects).
 */
const shapeConversations = async (input) => {
  const list = Array.isArray(input) ? input : [input];
  const plain = list.map((c) => (c && typeof c.toJSON === 'function' ? c.toJSON() : { ...c }));
  const idsByOrg = new Map();
  for (const c of plain) {
    if (!c.organizationId || !c.branchId) continue;
    if (!idsByOrg.has(c.organizationId)) idsByOrg.set(c.organizationId, new Set());
    idsByOrg.get(c.organizationId).add(c.branchId);
  }
  const names = new Map();
  const { Tenant } = require('../models/platform');
  const TenantDbManager = require('../database/TenantDbManager');
  await Promise.all([...idsByOrg].map(async ([organizationId, ids]) => {
    try {
      const org = await Tenant.findByPk(organizationId, { attributes: ['id', 'connectionStringEncrypted'] });
      if (!org || !org.connectionStringEncrypted || org.connectionStringEncrypted === 'PENDING_PROVISIONING') return;
      const db = await TenantDbManager.getConnection(org.id, org.connectionStringEncrypted);
      const rows = await db.models.Branch.findAll({ where: { id: [...ids] }, attributes: ['id', 'branchName'] });
      for (const r of rows) names.set(r.id, r.branchName);
    } catch (_) { /* the name is a convenience; the conversation still reads */ }
  }));
  const shaped = plain.map((c) => {
    const { gymListing, ...rest } = c;
    return { ...rest, business: gymListing ? { id: gymListing.id, name: gymListing.name } : null, branchName: names.get(c.branchId) || null };
  });
  return Array.isArray(input) ? shaped : shaped[0];
};

const listInquiries = async (organizationId) => {
  // NEW-256: a traveller this gym blocked is hidden from the gym's inbox.
  const blockedUserIds = await userBlocks.userIdsBlockedByTenant(organizationId);
  return Conversation.findAll({
    where: { organizationId, ...(blockedUserIds.length ? { userId: { [Op.notIn]: blockedUserIds } } : {}) },
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'profileImageUrl'],
      },
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
      }
    ],
    order: [['lastMessageAt', 'DESC']],
  });
};

/**
 * NEW-257: the gym side of the inbox always scopes to the caller's tenant. No tenant (a GYM_HOST
 * token without one) used to drop the filter and reach any gym's conversation; now it finds none.
 */
const _gymConversationWhere = (conversationId, organizationId) => {
  if (!organizationId) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }
  return { id: conversationId, organizationId };
};

const getInquiryDetail = async (conversationId, organizationId) => {
  const whereClause = _gymConversationWhere(conversationId, organizationId);
  const conversation = await Conversation.findOne({
    where: whereClause,
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'profileImageUrl'],
      },
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
      }
    ]
  });

  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const messages = await Message.findAll({
    where: { conversationId },
    order: [['createdAt', 'ASC']],
  });

  return { conversation, messages, block: await userBlocks.blockStateFor(conversation, BlockSide.ORGANIZATION) };
};

const replyToInquiry = async (conversationId, senderId, text, organizationId, options = {}) => {
  const whereClause = _gymConversationWhere(conversationId, organizationId);
  const conversation = await Conversation.findOne({ where: whereClause });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  // NEW-256: no message between a blocked pair, and none with a listed word.
  await userBlocks.assertCanMessage(conversation.userId, conversation.organizationId, BlockSide.ORGANIZATION);
  await moderationWords.assertClean(text);

  const { message, created } = await createMessageOnce(
    { conversationId, senderId, senderType: 'HOST', text, isRead: false },
    options?.clientMessageId
  );
  if (!created) return message;

  await conversation.update({
    lastMessageText: text,
    lastMessageAt: new Date(),
    unreadCountUser: conversation.unreadCountUser + 1,
  });

  // Create unified Traveler notification
  try {
    const { GymListing } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const listing = await GymListing.findByPk(conversation.businessId);
    const tenantName = listing ? listing.name : 'GymsEra Host';

    await notificationsService.createNotification({
      userId: conversation.userId,
      role: 'traveler',
      type: 'inquiry_replied',
      title: 'New Reply Received',
      message: `You have a new reply from ${tenantName}.`,
      deepLink: '/traveler/inbox',
      metadataJson: { conversationId },
    });
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create reply notification:', notifErr.message);
  }

  // Real-time socket broadcast
  try {
    const socketGateway = require('../socket');
    const messagePayload = {
      ...(typeof message.toJSON === 'function' ? message.toJSON() : message),
      tempId: options?.tempId || null,
    };
    socketGateway.emitToConversation(conversationId, 'new_message', {
      message: messagePayload,
      conversationId,
    });
    if (conversation.userId) {
      socketGateway.emitToUser(conversation.userId, 'new_message', {
        message: messagePayload,
        conversationId,
      });
    }
    socketGateway.emitConversationUpdated(conversationId, {
      lastMessageText: text,
      lastMessageAt: message.createdAt,
    });
  } catch (socketErr) {
    console.warn('[Socket Broadcast Warning]:', socketErr.message);
  }

  return message;
};

const markInquiryRead = async (conversationId, organizationId) => {
  const whereClause = _gymConversationWhere(conversationId, organizationId);
  const conversation = await Conversation.findOne({ where: whereClause });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  await conversation.update({ unreadCountHost: 0 });

  await Message.update(
    { isRead: true },
    { where: { conversationId, senderType: 'USER', isRead: false } }
  );

  try {
    const socketGateway = require('../socket');
    socketGateway.emitToConversation(conversationId, 'messages_read', {
      conversationId,
      readerRole: 'HOST',
      readAt: new Date().toISOString(),
    });
    socketGateway.emitConversationUpdated(conversationId, { unreadCountHost: 0 });
  } catch (_) { /* ignored on purpose */ }

  return { success: true };
};

const createTravelerInquiry = async (userId, branchIdOrGymId, text, options = {}) => {
  // Find GymListing mapping to the branchId or businessId
  const listing = await GymListing.findOne({
    where: {
      [Op.or]: [
        { primaryBranchId: branchIdOrGymId },
        { id: branchIdOrGymId }
      ]
    }
  });

  if (!listing) {
    const err = new Error('Gym listing not found');
    err.statusCode = 404;
    throw err;
  }

  const finalBranchId = listing.primaryBranchId || branchIdOrGymId;

  // NEW-256: no message between a blocked pair, and none with a listed word.
  await userBlocks.assertCanMessage(userId, listing.organizationId, BlockSide.USER);
  await moderationWords.assertClean(text);

  // Find or create Conversation
  let [conversation, created] = await Conversation.findOrCreate({
    where: {
      userId,
      branchId: finalBranchId,
      organizationId: listing.organizationId,
    },
    defaults: {
      type: 'INQUIRY',
      lastMessageText: text,
      lastMessageAt: new Date(),
      unreadCountHost: 1,
      unreadCountUser: 0,
    }
  });

  // Create message (idempotent on options.clientMessageId)
  const { message, created: messageCreated } = await createMessageOnce(
    {
      conversationId: conversation.id,
      senderId: userId,
      senderType: 'USER',
      text,
      isRead: false,
    },
    options?.clientMessageId
  );
  if (!messageCreated) return { conversation, message };

  if (!created) {
    // If conversation already exists, update it
    await conversation.update({
      lastMessageText: text,
      lastMessageAt: new Date(),
      unreadCountHost: conversation.unreadCountHost + 1,
    });
  }

  // Real-time socket broadcast
  try {
    const socketGateway = require('../socket');
    const messagePayload = {
      ...(typeof message.toJSON === 'function' ? message.toJSON() : message),
      tempId: options?.tempId || null,
    };
    socketGateway.emitToConversation(conversation.id, 'new_message', {
      message: messagePayload,
      conversationId: conversation.id,
    });
    if (listing && listing.organizationId) {
      // Only the staff of this conversation's branch (NEW-84).
      socketGateway.emitToBranch(listing.organizationId, conversation.branchId, 'new_message', {
        message: messagePayload,
        conversationId: conversation.id,
      });
    }
    socketGateway.emitConversationUpdated(conversation.id, {
      lastMessageText: text,
      lastMessageAt: message.createdAt,
    });
  } catch (socketErr) {
    console.warn('[Socket Broadcast Warning]:', socketErr.message);
  }

  // Create unified Host notification
  try {
    const { Tenant, User: PlatformUser } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const tenant = await Tenant.findByPk(listing.organizationId);

    const travelerUser = await PlatformUser.findByPk(userId);
    const travelerName = travelerUser ? travelerUser.fullName : 'Traveler';

    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'inquiry_received',
        title: 'New Inquiry Received',
        message: `New inquiry from ${travelerName} about ${listing.name}.`,
        deepLink: '/host/inbox',
        metadataJson: { conversationId: conversation.id, branchId: finalBranchId },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create inquiry notification:', notifErr.message);
  }

  return { conversation, message };
};

// ── Traveler-facing inbox functions ───────────────────────────────────────────

const listTravelerConversations = async (userId) => {
  // NEW-256: a gym this traveller blocked is hidden from the traveller's inbox.
  const blockedTenantIds = await userBlocks.tenantIdsBlockedByUser(userId);
  return Conversation.findAll({
    where: { userId, ...(blockedTenantIds.length ? { organizationId: { [Op.notIn]: blockedTenantIds } } : {}) },
    include: [
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
      }
    ],
    order: [['lastMessageAt', 'DESC']],
  });
};

const getTravelerConversationDetail = async (conversationId, userId) => {
  const conversation = await Conversation.findOne({
    where: { id: conversationId, userId },
    include: [
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
      }
    ]
  });

  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const messages = await Message.findAll({
    where: { conversationId },
    order: [['createdAt', 'ASC']],
  });

  return { conversation, messages, block: await userBlocks.blockStateFor(conversation, BlockSide.USER) };
};

const replyAsUser = async (conversationId, userId, text, options = {}) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, userId } });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  // NEW-256: no message between a blocked pair, and none with a listed word.
  await userBlocks.assertCanMessage(conversation.userId, conversation.organizationId, BlockSide.USER);
  await moderationWords.assertClean(text);

  const { message, created } = await createMessageOnce(
    { conversationId, senderId: userId, senderType: 'USER', text, isRead: false },
    options?.clientMessageId
  );
  if (!created) return message;

  await conversation.update({
    lastMessageText: text,
    lastMessageAt: new Date(),
    unreadCountHost: conversation.unreadCountHost + 1,
  });

  // Real-time socket broadcast
  try {
    const socketGateway = require('../socket');
    const messagePayload = {
      ...(typeof message.toJSON === 'function' ? message.toJSON() : message),
      tempId: options?.tempId || null,
    };
    socketGateway.emitToConversation(conversationId, 'new_message', {
      message: messagePayload,
      conversationId,
    });
    socketGateway.emitConversationUpdated(conversationId, {
      lastMessageText: text,
      lastMessageAt: message.createdAt,
    });
  } catch (socketErr) {
    console.warn('[Socket Broadcast Warning]:', socketErr.message);
  }

  return message;
};

const markTravelerRead = async (conversationId, userId) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, userId } });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  await conversation.update({ unreadCountUser: 0 });

  await Message.update(
    { isRead: true },
    { where: { conversationId, senderType: 'HOST', isRead: false } }
  );

  try {
    const socketGateway = require('../socket');
    socketGateway.emitToConversation(conversationId, 'messages_read', {
      conversationId,
      readerRole: 'USER',
      readAt: new Date().toISOString(),
    });
    socketGateway.emitConversationUpdated(conversationId, { unreadCountUser: 0 });
  } catch (_) { /* ignored on purpose */ }

  return { success: true };
};

const findOrCreateHostConversation = async (organizationId, userId, branchId, initialMessage = null) => {
  const user = await User.findByPk(userId);
  if (!user) {
    const err = new Error('Member user not found');
    err.statusCode = 404;
    throw err;
  }

  let finalBranchId = branchId;
  let listing = null;

  if (finalBranchId) {
    listing = await GymListing.findOne({
      where: {
        [Op.or]: [
          { primaryBranchId: finalBranchId },
          { id: finalBranchId },
        ],
      },
    });
  }

  if (!listing) {
    listing = await GymListing.findOne({ where: { organizationId } });
    if (listing && listing.primaryBranchId && !finalBranchId) {
      finalBranchId = listing.primaryBranchId;
    }
  }

  if (!finalBranchId) {
    finalBranchId = listing ? listing.primaryBranchId : organizationId;
  }

  // NEW-256: an opening message is a message (blocked pair, listed word).
  if (initialMessage) {
    await userBlocks.assertCanMessage(userId, organizationId, BlockSide.ORGANIZATION);
    await moderationWords.assertClean(initialMessage);
  }

  // Find existing conversation
  let conversation = await Conversation.findOne({
    where: {
      userId,
      organizationId,
      branchId: finalBranchId,
    },
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'profileImageUrl'],
      },
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
      },
    ],
  });

  if (!conversation) {
    conversation = await Conversation.create({
      userId,
      organizationId,
      branchId: finalBranchId,
      type: 'MEMBER',
      lastMessageText: initialMessage || 'Conversation started',
      lastMessageAt: new Date(),
      unreadCountHost: 0,
      unreadCountUser: initialMessage ? 1 : 0,
    });

    if (initialMessage) {
      await Message.create({
        conversationId: conversation.id,
        senderId: organizationId,
        senderType: 'HOST',
        text: initialMessage,
        isRead: false,
      });
    }

    conversation = await Conversation.findByPk(conversation.id, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'fullName', 'profileImageUrl'],
        },
        {
          model: GymListing,
          as: 'gymListing',
          attributes: ['id', 'name', 'logoUrl', 'primaryBranchId'],
        },
      ],
    });
  }

  return conversation;
};

// ── NEW-256: block / unblock from a conversation ─────────────────────────────

const _notFound = () => {
  const err = new Error('Conversation not found');
  err.statusCode = 404;
  return err;
};

/** The traveller blocks (or unblocks) the gym of one of their conversations. */
const setTravelerBlock = async (conversationId, userId, blocked) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, userId } });
  if (!conversation) throw _notFound();
  if (blocked) await userBlocks.block(conversation, BlockSide.USER, userId);
  else await userBlocks.unblock(conversation, BlockSide.USER);
  return userBlocks.blockStateFor(conversation, BlockSide.USER);
};

/** The gym blocks (or unblocks) the traveller of one of its conversations. */
const setHostBlock = async (conversationId, organizationId, actorUserId, blocked) => {
  if (!organizationId) throw _notFound();
  const conversation = await Conversation.findOne({ where: { id: conversationId, organizationId } });
  if (!conversation) throw _notFound();
  if (blocked) await userBlocks.block(conversation, BlockSide.ORGANIZATION, actorUserId);
  else await userBlocks.unblock(conversation, BlockSide.ORGANIZATION);
  return userBlocks.blockStateFor(conversation, BlockSide.ORGANIZATION);
};

module.exports = {
  shapeConversations,
  setTravelerBlock,
  setHostBlock,
  listInquiries,
  getInquiryDetail,
  replyToInquiry,
  markInquiryRead,
  createTravelerInquiry,
  findOrCreateHostConversation,
  listTravelerConversations,
  getTravelerConversationDetail,
  replyAsUser,
  markTravelerRead,
};

