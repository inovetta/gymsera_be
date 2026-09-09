const notificationsService = require('../services/notifications.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

const listNotifications = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const result = await notificationsService.listNotifications(
      req.user.id,
      req.user.role,
      { page, limit, offset }
    );
    return sendSuccess(
      res,
      { notifications: result.notifications },
      'Notifications retrieved',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

const getUnreadCount = async (req, res, next) => {
  try {
    const result = await notificationsService.getUnreadCount(req.user.id, req.user.role);
    return sendSuccess(res, result, 'Unread count retrieved');
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
    const result = await notificationsService.markAllAsRead(req.user.id, req.user.role);
    return sendSuccess(res, result, 'All notifications marked as read');
  } catch (err) {
    next(err);
  }
};

const registerDeviceToken = async (req, res, next) => {
  try {
    const { token, platform, deviceId, deviceName } = req.body;
    const result = await notificationsService.registerDeviceToken({
      userId: req.user.id,
      token,
      platform,
      deviceId,
      deviceName,
    });
    return sendSuccess(res, result, 'Device token registered successfully');
  } catch (err) {
    next(err);
  }
};

const deleteDeviceToken = async (req, res, next) => {
  try {
    const { token } = req.body || {};
    const result = await notificationsService.deleteDeviceToken({
      userId: req.user.id,
      token,
    });
    return sendSuccess(res, result, 'Device token deleted successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  registerDeviceToken,
  deleteDeviceToken,
};

