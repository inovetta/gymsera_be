const { Notification } = require('../models/platform');
const { Sequelize } = require('sequelize');

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
 * Create a new notification record.
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
  return Notification.create({
    userId,
    role,
    type,
    title,
    message: message || body || '',
    priority,
    deepLink,
    metadataJson: metadataJson || metadata || null,
  });
};

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  createNotification,
  mapRole,
};
