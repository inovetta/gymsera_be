const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const tenantContext = require('../middleware/tenantContext');
const controller = require('../controllers/subscriptions.controller');

const router = Router();

// Require auth and tenant context for all member subroutes
router.use(authenticate, tenantContext);

router.get('/branches/:branchId/subscription-status', controller.getMemberBranchSubscriptionStatus);
router.get('/subscriptions/:id/upgrade-options', controller.getUpgradeOptions);
router.post('/subscriptions/:id/upgrade', controller.upgradeSubscription);

module.exports = router;
