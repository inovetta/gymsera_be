const { Router } = require('express');
const controller = require('../controllers/billing-plans.controller');
const validators = require('../validators/billing-plans.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const router = Router();

/**
 * @swagger
 * tags:
 *   name: BillingPlans
 *   description: >
 *     Super Admin's central GymsEra plan catalog — the one source of truth
 *     for branch-tier pricing and per-provider (iOS/Android/Stripe) product
 *     identifiers, consumed by every client via GET /billing/plans.
 */

router.get('/', authenticate, authorize('PLATFORM_ADMIN'), controller.listPlans);
router.get('/:id', authenticate, authorize('PLATFORM_ADMIN'), controller.getPlan);
router.post('/', authenticate, authorize('PLATFORM_ADMIN'), validate(validators.createPlan), controller.createPlan);
router.patch('/:id', authenticate, authorize('PLATFORM_ADMIN'), validate(validators.updatePlan), controller.updatePlan);

/**
 * POST /admin/billing-plans/:id/sync-stripe
 * The one automated provider-sync action — creates a new Stripe Price at
 * the catalog's current amount (Prices are immutable) and repoints this
 * plan at it. Existing Stripe subscribers keep referencing their original
 * Price automatically.
 */
router.post('/:id/sync-stripe', authenticate, authorize('PLATFORM_ADMIN'), controller.syncStripe);

/**
 * POST /admin/billing-plans/:id/mark-synced { provider: 'ios' | 'android' }
 * Admin-attested — neither store exposes a safe price-write API.
 */
router.post(
  '/:id/mark-synced',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate(validators.markSynced),
  controller.markSynced
);

module.exports = router;
