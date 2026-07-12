const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const controller = require('../controllers/notifications.controller');

const router = Router();

router.use(authenticate);

router.get('/', controller.listNotifications);
router.patch('/:id/read', controller.markAsRead);
router.post('/read-all', controller.markAllAsRead);

module.exports = router;
