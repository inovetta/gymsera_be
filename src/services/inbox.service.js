const { Conversation, Message, User, GymListing } = require('../models/platform');
const { Op } = require('sequelize');

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

const listInquiries = async (tenantId) => {
  return Conversation.findAll({
    where: { tenantId },
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['id', 'fullName', 'profileImageUrl'],
      },
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'title', 'logoUrl', 'branchId'],
      }
    ],
    order: [['lastMessageAt', 'DESC']],
  });
};

const getInquiryDetail = async (conversationId, tenantId) => {
  const whereClause = { id: conversationId };
  if (tenantId) whereClause.tenantId = tenantId;
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
        attributes: ['id', 'title', 'logoUrl', 'branchId'],
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

  return { conversation, messages };
};

const replyToInquiry = async (conversationId, senderId, text, tenantId, options = {}) => {
  const whereClause = { id: conversationId };
  if (tenantId) whereClause.tenantId = tenantId;
  const conversation = await Conversation.findOne({ where: whereClause });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

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
    const listing = await GymListing.findByPk(conversation.gymListingId);
    const tenantName = listing ? listing.title : 'Gymsera Host';

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

const markInquiryRead = async (conversationId, tenantId) => {
  const whereClause = { id: conversationId };
  if (tenantId) whereClause.tenantId = tenantId;
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
  } catch (_) {}

  return { success: true };
};

const createTravelerInquiry = async (userId, branchIdOrGymId, text, options = {}) => {
  // Find GymListing mapping to the branchId or gymId
  const listing = await GymListing.findOne({
    where: {
      [Op.or]: [
        { branchId: branchIdOrGymId },
        { id: branchIdOrGymId }
      ]
    }
  });

  if (!listing) {
    const err = new Error('Gym listing not found');
    err.statusCode = 404;
    throw err;
  }

  const finalBranchId = listing.branchId || branchIdOrGymId;

  // Find or create Conversation
  let [conversation, created] = await Conversation.findOrCreate({
    where: {
      userId,
      branchId: finalBranchId,
      tenantId: listing.tenantId,
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
    if (listing && listing.tenantId) {
      // Only the staff of this conversation's branch (NEW-84).
      socketGateway.emitToBranch(listing.tenantId, conversation.branchId, 'new_message', {
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
    const tenant = await Tenant.findByPk(listing.tenantId);

    const travelerUser = await PlatformUser.findByPk(userId);
    const travelerName = travelerUser ? travelerUser.fullName : 'Traveler';

    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'inquiry_received',
        title: 'New Inquiry Received',
        message: `New inquiry from ${travelerName} about ${listing.title}.`,
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
  return Conversation.findAll({
    where: { userId },
    include: [
      {
        model: GymListing,
        as: 'gymListing',
        attributes: ['id', 'title', 'logoUrl', 'branchId'],
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
        attributes: ['id', 'title', 'logoUrl', 'branchId'],
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

  return { conversation, messages };
};

const replyAsUser = async (conversationId, userId, text, options = {}) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, userId } });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

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
  } catch (_) {}

  return { success: true };
};

const findOrCreateHostConversation = async (tenantId, userId, branchId, initialMessage = null) => {
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
          { branchId: finalBranchId },
          { id: finalBranchId },
        ],
      },
    });
  }

  if (!listing) {
    listing = await GymListing.findOne({ where: { tenantId } });
    if (listing && listing.branchId && !finalBranchId) {
      finalBranchId = listing.branchId;
    }
  }

  if (!finalBranchId) {
    finalBranchId = listing ? listing.branchId : tenantId;
  }

  // Find existing conversation
  let conversation = await Conversation.findOne({
    where: {
      userId,
      tenantId,
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
        attributes: ['id', 'title', 'logoUrl', 'branchId'],
      },
    ],
  });

  if (!conversation) {
    conversation = await Conversation.create({
      userId,
      tenantId,
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
        senderId: tenantId,
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
          attributes: ['id', 'title', 'logoUrl', 'branchId'],
        },
      ],
    });
  }

  return conversation;
};

module.exports = {
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

