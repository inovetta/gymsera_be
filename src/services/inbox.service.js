const { Conversation, Message, User, GymListing } = require('../models/platform');
const { Op } = require('sequelize');

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
  const conversation = await Conversation.findOne({
    where: { id: conversationId, tenantId },
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

const replyToInquiry = async (conversationId, senderId, text, tenantId) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, tenantId } });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const message = await Message.create({
    conversationId,
    senderId,
    senderType: 'HOST',
    text,
    isRead: false,
  });

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

  return message;
};

const markInquiryRead = async (conversationId, tenantId) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, tenantId } });
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

  return { success: true };
};

const createTravelerInquiry = async (userId, branchIdOrGymId, text) => {
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

  if (!created) {
    // If conversation already exists, update it
    await conversation.update({
      lastMessageText: text,
      lastMessageAt: new Date(),
      unreadCountHost: conversation.unreadCountHost + 1,
    });
  }

  // Create message
  const message = await Message.create({
    conversationId: conversation.id,
    senderId: userId,
    senderType: 'USER',
    text,
    isRead: false,
  });

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

const replyAsUser = async (conversationId, userId, text) => {
  const conversation = await Conversation.findOne({ where: { id: conversationId, userId } });
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.statusCode = 404;
    throw err;
  }

  const message = await Message.create({
    conversationId,
    senderId: userId,
    senderType: 'USER',
    text,
    isRead: false,
  });

  await conversation.update({
    lastMessageText: text,
    lastMessageAt: new Date(),
    unreadCountHost: conversation.unreadCountHost + 1,
  });

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

  return { success: true };
};

module.exports = {
  listInquiries,
  getInquiryDetail,
  replyToInquiry,
  markInquiryRead,
  createTravelerInquiry,
  listTravelerConversations,
  getTravelerConversationDetail,
  replyAsUser,
  markTravelerRead,
};

