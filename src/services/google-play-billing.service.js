/**
 * Google Play Developer API — Play Billing subscription verification.
 *
 * Sibling to apple-billing.service.js, same shape, same rules — see that
 * file's header for the shared principles (never trust the client alone,
 * one choke point for the branchCount write, capacity reconciliation inside
 * the same transaction). What's different is Google's own model:
 *
 *   - Verification is a plain OAuth-JWT-authenticated REST call
 *     (subscriptionsv2.get), not a signed-JWS payload to decode — there is
 *     no certificate chain to verify because the call itself is already
 *     server-to-server and authenticated.
 *   - Real-time Developer Notifications (RTDN) arrive via Google Cloud
 *     Pub/Sub push, with no embedded signature — authenticated instead by a
 *     secret token on the push endpoint's own URL (see billing.routes.js).
 *   - A purchase must be acknowledged within 3 days or Google auto-refunds
 *     it. The Flutter client's own completePurchase call handles this on
 *     the happy path (the in_app_purchase plugin maps it to Android's
 *     acknowledge internally); acknowledgePurchaseIfNeeded here is the
 *     server-side safety net for the case where that client call never
 *     completes (app killed mid-flow) — mirrors "never trust the client
 *     alone" applied to acknowledgement specifically, not just verification.
 *
 * Until real Play Console access exists, BillingPlan rows hold placeholder
 * product/base-plan IDs and androidSyncStatus stays NOT_CONFIGURED — every
 * function below is real, production-shaped code; only the store-side IDs
 * are stubbed (see platform.js's placeholder-ID backfill).
 */
const { JWT } = require('google-auth-library');
const { BillingPlan, Tenant, TenantSubscription } = require('../models/platform');
const { sequelize } = require('../database/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');
const subscriptionMigrationService = require('./subscription-migration.service');
const TenantDbManager = require('../database/TenantDbManager');

const ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

let _cachedAuthClient = null;

/** Service-account JWT client for the Play Developer API, cached across calls (google-auth-library handles its own token refresh). */
const _playDeveloperApiAuth = () => {
  if (_cachedAuthClient) return _cachedAuthClient;

  const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw createError('Google Play service-account credentials are not configured on the server', 500);
  }
  const credentials = JSON.parse(serviceAccountJson);
  _cachedAuthClient = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [ANDROIDPUBLISHER_SCOPE],
  });
  return _cachedAuthClient;
};

const _packageName = () => {
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!packageName) throw createError('GOOGLE_PLAY_PACKAGE_NAME is not configured on the server', 500);
  return packageName;
};

/**
 * Ask Google directly what this purchase token actually is — the app's own
 * claim that it paid is never trusted on its own, same principle as Apple's
 * getTransactionInfo.
 */
const getSubscriptionPurchase = async (purchaseToken) => {
  const auth = _playDeveloperApiAuth();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${_packageName()}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const response = await auth.request({ url, method: 'GET' });
  return response.data;
};

/**
 * A verified purchase's productId/basePlanId back to the BillingPlan row it
 * belongs to — mirrors apple-billing.service.js#findPlanForProductId.
 */
const findPlanForProductId = async (productId, basePlanId) => {
  const { Op } = require('sequelize');
  const plan = await BillingPlan.findOne({
    where: {
      androidProductId: productId,
      [Op.or]: [{ androidMonthlyBasePlanId: basePlanId }, { androidAnnualBasePlanId: basePlanId }],
    },
  });
  if (!plan) throw createError(`No BillingPlan is configured for Android product "${productId}" / base plan "${basePlanId}"`, 404);
  return plan;
};

/** Google's subscriptionState enum -> our status vocabulary. */
const _statusFromSubscriptionState = (subscriptionState) => {
  switch (subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'ACTIVE';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'CANCELLED';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'EXPIRED';
    default:
      return 'ACTIVE';
  }
};

/**
 * Upserts the tenant's TenantSubscription row from a verified Google Play
 * purchase. Keyed on externalOriginalTransactionId (= purchaseToken, stable
 * across renewals for one subscription) — safe to call repeatedly. Mirrors
 * apple-billing.service.js#syncSubscriptionFromTransaction function-for-
 * function, including the cross-provider migration hook.
 *
 * `purchaseToken` is passed explicitly rather than read off `purchase` —
 * Google's subscriptionsv2.get response doesn't echo the token that was
 * used to fetch it, so the caller (who already has it) always supplies it.
 */
const syncSubscriptionFromPurchase = async (tenantId, purchase, purchaseToken, { originListingId = null } = {}) => {
  const lineItem = purchase.lineItems?.[0];
  if (!lineItem) throw createError('Google Play purchase has no line items', 400);

  const productId = lineItem.productId;
  const basePlanId = lineItem.offerDetails?.basePlanId;
  const plan = await findPlanForProductId(productId, basePlanId);
  const isAnnual = basePlanId === plan.androidAnnualBasePlanId;

  const expiresAt = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  const status = _statusFromSubscriptionState(purchase.subscriptionState);
  const latestOrderId = purchase.latestOrderId ? String(purchase.latestOrderId) : null;

  const platformTx = await sequelize.transaction();
  try {
    const existing = await TenantSubscription.findOne({
      where: { externalOriginalTransactionId: purchaseToken },
      transaction: platformTx,
      lock: true,
    });
    const previousMaxBranches = existing ? existing.branchCount : null;
    const planChanged = !existing || existing.billingPlanId !== plan.id;

    const values = {
      tenantId,
      platform: 'ANDROID',
      billingPlanId: plan.id,
      branchCount: plan.branchCount,
      productId,
      externalOriginalTransactionId: purchaseToken,
      externalTransactionId: latestOrderId || purchaseToken,
      environment: purchase.testPurchase ? 'SANDBOX' : 'PRODUCTION',
      startDate: purchase.startTime ? new Date(purchase.startTime).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      endDate: expiresAt ? expiresAt.toISOString().split('T')[0] : null,
      // See apple-billing.service.js's identical comment — never recomputed
      // on a plain renewal, only on a new row or a real plan change.
      ...(planChanged
        ? { amount: isAnnual ? plan.annualPrice : plan.monthlyPrice, billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY' }
        : {}),
      status,
      autoRenew: !!purchase.acknowledgementState && status === 'ACTIVE' && lineItem.autoRenewingPlan?.autoRenewEnabled !== false,
      paymentStatus: 'PAID',
      lastVerifiedAt: new Date(),
    };

    let subscription;
    // See apple-billing.service.js's identical comment — true whenever
    // requestProviderChange already handled reconciliation itself.
    let reconciledByActivation = false;
    let migratedFrom = null;
    if (existing) {
      // A renewal/resync for a token already on file — never a migration
      // decision (that only ever runs once, in the `else` branch below, the
      // first time a given purchase token is seen). But Google's own report
      // for THIS token could still say ACTIVE even after a prior purchase
      // superseded it locally, if that "supersession" wasn't a real in-app
      // replacement and this subscription genuinely kept billing at the
      // store — see subscription-migration.service.js#reconcileRenewalStatus
      // for why blindly trusting that would resurrect a second ACTIVE row.
      const reconciledValues = await subscriptionMigrationService.reconcileRenewalStatus(
        tenantId,
        existing,
        values,
        { transaction: platformTx }
      );
      await existing.update(reconciledValues, { transaction: platformTx });
      subscription = existing;
    } else {
      let tenantDb = null;
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      }
      const activation = await subscriptionMigrationService.requestProviderChange(
        tenantId,
        {
          newPlatform: 'ANDROID',
          newSubscriptionValues: values,
          // Google's own subscriptionsv2 response says exactly which prior
          // purchase this one replaces — set on a genuine in-app
          // subscription-replacement purchase (see
          // billing_provider.dart#changeAndroidPlan), absent on an
          // unrelated fresh purchase. Passed through so
          // requestProviderChange can close out the old row as a confirmed,
          // store-handled replacement instead of guessing.
          supersededExternalId: purchase.linkedPurchaseToken || null,
        },
        {
          transaction: platformTx,
          tenantDb,
          originListingId,
          idempotencyPrefix: values.externalTransactionId,
          actorType: 'SYSTEM',
        }
      );
      subscription = activation.subscription;
      reconciledByActivation = true;
      migratedFrom = activation.migratedFrom;
    }

    // subscription.status, not values.status — reconcileRenewalStatus above
    // can override what was about to be written, and .update() leaves the
    // instance holding whatever was actually persisted. Reading values.status
    // here would reconcile capacity for a row that just got refused ACTIVE
    // status, double-counting a superseded row's branchCount.
    if (!reconciledByActivation && subscription.status === 'ACTIVE' && values.branchCount != null) {
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
        await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, values.branchCount, {
          transaction: platformTx,
          previousMaxBranches,
          originListingId,
          idempotencyPrefix: values.externalTransactionId,
          actorType: 'SYSTEM',
        });
      }
    }

    await platformTx.commit();

    if (migratedFrom?.platform === 'STRIPE' && migratedFrom.externalOriginalTransactionId) {
      try {
        const stripeBilling = require('./stripe-billing.service');
        await stripeBilling.cancelAtPeriodEnd(migratedFrom.externalOriginalTransactionId);
      } catch (err) {
        console.warn('[Google Play Billing] Failed to schedule Stripe cancellation after migration:', err.message);
      }
    }

    return subscription;
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

/**
 * Server-side safety net alongside the client's own completePurchase call —
 * Play auto-refunds a subscription left unacknowledged for 3 days. Tolerant
 * of "already acknowledged" (a 400 from Google on retry), which is expected,
 * not an error, exactly like every other idempotent-retry path in this
 * codebase (see platform.js's _logIfUnexpected for the same philosophy).
 */
const acknowledgePurchaseIfNeeded = async (purchaseToken, productId) => {
  const auth = _playDeveloperApiAuth();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${_packageName()}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  try {
    await auth.request({ url, method: 'POST', data: {} });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message || '';
    if (!/already.*acknowledg/i.test(message)) {
      console.warn('[Google Play Billing] Acknowledge failed unexpectedly:', message);
    }
  }
};

/**
 * Real-time Developer Notifications — Google POSTing renewal/cancel/expiry
 * events at us via Pub/Sub push. Always re-fetches the purchase fresh via
 * getSubscriptionPurchase rather than trusting the notification payload's
 * own state — mirrors Apple's handleNotification re-decoding the signed
 * transaction rather than trusting the outer envelope.
 */
const handleRtdnNotification = async (pubsubMessage) => {
  const dataB64 = pubsubMessage?.message?.data;
  if (!dataB64) return null;
  const decoded = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'));
  const notification = decoded.subscriptionNotification;
  if (!notification?.purchaseToken) return null; // e.g. a test notification, nothing to sync

  const purchase = await getSubscriptionPurchase(notification.purchaseToken);

  const { TenantSubscription: TS } = require('../models/platform');
  const existing = await TS.findOne({ where: { externalOriginalTransactionId: notification.purchaseToken } });
  if (!existing) {
    // A renewal can arrive before the app ever called /billing/android/sync
    // once — nothing to update yet; the next app-initiated sync creates the
    // row. Not an error, same as Apple's equivalent case.
    return null;
  }
  return syncSubscriptionFromPurchase(existing.tenantId, purchase, notification.purchaseToken);
};

module.exports = {
  getSubscriptionPurchase,
  findPlanForProductId,
  syncSubscriptionFromPurchase,
  acknowledgePurchaseIfNeeded,
  handleRtdnNotification,
};
