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
router.post('/', authenticate, authorize('PLATFORM_ADMIN'), validate.strict(validators.createPlan), controller.createPlan);
router.patch('/:id', authenticate, authorize('PLATFORM_ADMIN'), validate.strict(validators.updatePlan), controller.updatePlan);

/**
 * POST /admin/billing-plans/:id/sync-stripe
 * The one automated provider-sync action — creates a new Stripe Price at
 * the catalog's current amount (Prices are immutable) and repoints this
 * plan at it. Existing Stripe subscribers keep referencing their original
 * Price automatically.
 */
router.post('/:id/sync-stripe', authenticate, authorize('PLATFORM_ADMIN'), validate.allowBody([]), controller.syncStripe);

/**
 * POST /admin/billing-plans/:id/mark-synced { provider: 'ios' | 'android' }
 * Admin-attested — neither store exposes a safe price-write API.
 */
router.post(
  '/:id/mark-synced',
  authenticate,
  authorize('PLATFORM_ADMIN'),
  validate.strict(validators.markSynced),
  controller.markSynced
);

/**
 * BILL-11: one extra currency per tier. PUT sets the catalog price (major units in the body, stored as integer
 * minor units); sync-stripe creates that currency's Stripe Prices; DELETE removes it.
 */
router.put('/:id/prices/:currency', authenticate, authorize('PLATFORM_ADMIN'), validate.strict(validators.upsertPrice), controller.upsertPrice);
router.delete('/:id/prices/:currency', authenticate, authorize('PLATFORM_ADMIN'), validate.strict(validators.priceParams), controller.deletePrice);
router.post('/:id/prices/:currency/sync-stripe', authenticate, authorize('PLATFORM_ADMIN'), validate.strict(validators.priceParams), controller.syncStripeCurrencyPrice);

module.exports = router;
