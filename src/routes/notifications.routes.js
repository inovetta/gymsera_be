const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const controller = require('../controllers/notifications.controller');

const router = Router();

router.use(authenticate);

router.get('/', controller.listNotifications);
router.get('/unread-count', controller.getUnreadCount);
router.patch('/:id/read', validate.allowBody([]), controller.markAsRead);
router.patch('/read-all', validate.allowBody([]), controller.markAllAsRead);
router.post('/read-all', validate.allowBody([]), controller.markAllAsRead);

// Device token registration & deletion
router.post('/token', validate.allowBody(['token', 'platform', 'deviceId', 'deviceName', 'appVersion', 'locale', 'timezone']), controller.registerDeviceToken);
router.delete('/token', validate.allowBody(['token']), controller.deleteDeviceToken);

// Real-time FCM push testing endpoint
router.post('/test-push', validate.allowBody(['title', 'body']), controller.testPush);

module.exports = router;

