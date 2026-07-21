const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/notifications.controller');

const router = Router();

router.use(authenticate);

router.get('/', controller.listNotifications);
router.get('/unread-count', controller.getUnreadCount);
router.patch('/:id/read', controller.markAsRead);
router.patch('/read-all', controller.markAllAsRead);
router.post('/read-all', controller.markAllAsRead);

module.exports = router;
