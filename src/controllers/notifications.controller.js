const notificationsService = require('../services/notifications.service');
const { sendSuccess } = require('../utils/response.utils');

const listNotifications = async (req, res, next) => {
  try {
    const list = await notificationsService.listNotifications(req.user.id);
    return sendSuccess(res, { notifications: list }, 'Notifications retrieved');
  } catch (err) {
    next(err);
  }
};

const markAsRead = async (req, res, next) => {
  try {
    const result = await notificationsService.markAsRead(req.params.id, req.user.id);
    return sendSuccess(res, result, 'Notification marked as read');
  } catch (err) {
    next(err);
  }
};

const markAllAsRead = async (req, res, next) => {
  try {
    const result = await notificationsService.markAllAsRead(req.user.id);
    return sendSuccess(res, result, 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listNotifications,
  markAsRead,
  markAllAsRead,
};
