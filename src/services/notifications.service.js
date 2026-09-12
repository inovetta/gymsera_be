const { Notification, DeviceToken, User } = require('../models/platform');
const { Sequelize } = require('sequelize');
const pushService = require('./push.service');

/**
 * Maps application-level user roles to notification roles.
 */
const mapRole = (backendRole) => {
  if (!backendRole) return 'traveler';
  const roleUpper = backendRole.toUpperCase();
  if (roleUpper === 'PLATFORM_ADMIN') return 'admin';
  if (roleUpper === 'GYM_HOST') return 'host';
  if (['BRANCH_MANAGER', 'FRONT_DESK', 'TRAINER'].includes(roleUpper)) return 'staff';
  return 'traveler'; // Default/MEMBER
};

/**
 * List paginated notifications for a user, filtered by their recipient role.
 * Priority = 'high' notifications are sorted to the top, followed by newest first.
 */
const listNotifications = async (userId, backendRole, { page = 1, limit = 20, offset = 0 } = {}) => {
  const role = mapRole(backendRole);
  const where = { userId, role };

  const { count, rows } = await Notification.findAndCountAll({
    where,
    order: [
      [Sequelize.literal("CASE WHEN priority = 'high' THEN 0 ELSE 1 END"), 'ASC'],
      ['createdAt', 'DESC'],
    ],
    limit,
    offset,
  });

  return {
    notifications: rows,
    pagination: {
      totalItems: count,
      currentPage: page,
      totalPages: Math.ceil(count / limit),
      limit,
    },
  };
};

/**
 * Get count of unread notifications for a user/role.
 */
const getUnreadCount = async (userId, backendRole) => {
  const role = mapRole(backendRole);
  const unreadCount = await Notification.count({
    where: { userId, role, isRead: false },
  });
  return { unreadCount };
};

/**
 * Mark a single notification as read.
 */
const markAsRead = async (id, userId) => {
  const notification = await Notification.findOne({ where: { id, userId } });
  if (!notification) {
    const err = new Error('Notification not found');
    err.statusCode = 404;
    throw err;
  }
  notification.isRead = true;
  await notification.save();
  return { success: true };
};

/**
 * Mark all notifications for a user as read.
 */
const markAllAsRead = async (userId, backendRole) => {
  const role = mapRole(backendRole);
  await Notification.update(
    { isRead: true },
    { where: { userId, role, isRead: false } }
  );
  return { success: true };
};

/**
 * Register or update an FCM device token for a user.
 */
const registerDeviceToken = async ({ userId, token, platform = 'android', deviceId = null, deviceName = null }) => {
  if (!token) {
    const err = new Error('Token is required');
    err.statusCode = 400;
    throw err;
  }

  const normalizedPlatform = (platform || 'android').toLowerCase();

  const upsertToken = async () => {
    const [deviceToken, created] = await DeviceToken.findOrCreate({
      where: { token },
      defaults: {
        userId,
        token,
        platform: normalizedPlatform,
        deviceId,
        deviceName,
        lastActiveAt: new Date(),
      },
    });

    if (!created) {
      deviceToken.userId = userId;
      deviceToken.platform = normalizedPlatform;
      if (deviceId) deviceToken.deviceId = deviceId;
      if (deviceName) deviceToken.deviceName = deviceName;
      deviceToken.lastActiveAt = new Date();
      await deviceToken.save();
    }

    return { success: true, registered: true };
  };

  try {
    return await upsertToken();
  } catch (err) {
    if (err.message && err.message.includes("doesn't exist")) {
      try {
        await DeviceToken.sync();
        return await upsertToken();
      } catch (syncErr) {
        console.warn('[registerDeviceToken] Failed after sync:', syncErr.message);
      }
    }
    throw err;
  }
};

/**
 * Remove an FCM device token for a user (e.g. on logout).
 */
const deleteDeviceToken = async ({ userId, token }) => {
  if (!token) {
    await DeviceToken.destroy({ where: { userId } });
    return { success: true, clearedAll: true };
  }

  await DeviceToken.destroy({ where: { userId, token } });

  return { success: true, deleted: true };
};


/**
 * Create a new notification record and dispatch real-time push notification.
 */
const createNotification = async ({
  userId,
  role = 'traveler',
  type,
  title,
  message,
  body, // compatibility alias
  priority = 'normal',
  deepLink = null,
  metadataJson = null,
  metadata = null, // compatibility alias
}) => {
  const finalMessage = message || body || '';
  const finalMetadata = metadataJson || metadata || null;

  const notification = await Notification.create({
    userId,
    role,
    type,
    title,
    message: finalMessage,
    priority,
    deepLink,
    metadataJson: finalMetadata,
  });

  // 1. Dispatch real-time WebSocket event directly to user room
  try {
    const socketGateway = require('../socket');
    const socketPayload = {
      id: notification.id,
      title: notification.title,
      message: notification.message,
      body: notification.message,
      type: notification.type,
      priority: notification.priority,
      deepLink: notification.deepLink,
      isRead: false,
      createdAt: notification.createdAt,
      metadataJson: finalMetadata,
      event: (finalMetadata && finalMetadata.event) || notification.type || 'new_notification',
    };
    socketGateway.emitToUser(userId, 'new_notification', socketPayload);
    socketGateway.emitToUser(userId, 'notification', socketPayload);
    console.log(`[notifications.service] Emitted new_notification to user:${userId} for "${title}"`);
  } catch (socketErr) {
    console.warn('[notifications.service] Socket emission error:', socketErr.message);
  }

  // 2. Dispatch FCM push notification asynchronously
  try {
    const pushData = {
      notificationId: String(notification.id),
      type: type || 'notification',
      role: role || 'traveler',
      priority: priority || 'normal',
      deepLink: deepLink || '',
      title: title || 'GymsEra Notification',
      body: finalMessage,
      message: finalMessage,
      event: (finalMetadata && finalMetadata.event) ? finalMetadata.event : (type || 'new_notification'),
      ...(finalMetadata && typeof finalMetadata === 'object' ? finalMetadata : {}),
    };

    pushService.sendToUser(userId, {
      title: title || 'GymsEra Notification',
      body: finalMessage,
      data: pushData,
    }).catch(pushErr => {
      console.error(`[notifications.service] Push error for user ${userId}:`, pushErr.message);
    });
  } catch (err) {
    console.error(`[notifications.service] Failed to queue push notification for user ${userId}:`, err.message);
  }

  return notification;
};

/**
 * Dispatch an immediate test notification to all registered devices of a user
 */
const testPushNotification = async ({ userId, title, body }) => {
  const pushTitle = title || 'GymsEra Test Push';
  const pushBody = body || 'This is an end-to-end test notification verifying status bar and real-time delivery.';
  const testData = {
    event: 'test_push',
    type: 'test',
    deepLink: '/notifications',
    sentAt: new Date().toISOString(),
  };

  const pushResult = await pushService.sendToUser(userId, {
    title: pushTitle,
    body: pushBody,
    data: testData,
  });

  return {
    pushResult,
    status: pushService.getPushStatus(),
  };
};

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  createNotification,
  registerDeviceToken,
  deleteDeviceToken,
  testPushNotification,
  mapRole,
};
