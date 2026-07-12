const { Notification } = require('../models/platform');

const listNotifications = async (userId) => {
  return Notification.findAll({
    where: { userId },
    order: [['createdAt', 'DESC']],
  });
};

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

const markAllAsRead = async (userId) => {
  await Notification.update({ isRead: true }, { where: { userId, isRead: false } });
  return { success: true };
};

const createNotification = async ({ userId, type, title, body, metadata = null }) => {
  return Notification.create({
    userId,
    type,
    title,
    body,
    metadata,
  });
};

module.exports = {
  listNotifications,
  markAsRead,
  markAllAsRead,
  createNotification,
};
