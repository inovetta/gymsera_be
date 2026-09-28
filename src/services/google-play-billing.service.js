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
 *     it. The server acknowledges every verified purchase itself inside
 *     syncFromGoogle (BILL-06), for the app's /sync and for RTDNs alike, and
 *     retries through the billing_events inbox; the Flutter client's own
 *     completePurchase is only a backup.
 *
 * Until real Play Console access exists, BillingPlan rows hold placeholder
 * product/base-plan IDs and androidSyncStatus stays NOT_CONFIGURED — every
 * function below is real, production-shaped code; only the store-side IDs
 * are stubbed (see platform.js's placeholder-ID backfill).
 */
const { URLSearchParams } = require('url');
const { JWT } = require('google-auth-library');
const { BillingPlan } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionMigrationService = require('./subscription-migration.service');

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

/**
 * Google's subscriptionState enum -> our status vocabulary (BILL-04, spec
 * §7.4). CANCELED only means auto-renew was turned off: the subscriber paid
 * to the end of the period and stays entitled until then. A state we don't
 * know is never guessed as ACTIVE — the sync fails and the inbox keeps
 * retrying/alerting until someone looks.
 */
const _statusFromSubscriptionState = (subscriptionState, expiresAt) => {
  switch (subscriptionState) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'ACTIVE';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'GRACE';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return 'ON_HOLD';
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'PAUSED';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return expiresAt && expiresAt > new Date() ? 'ACTIVE' : 'EXPIRED';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'EXPIRED';
    default:
      throw createError(`Google Play reported an unknown subscription state "${subscriptionState}"`, 502);
  }
};

/**
 * Maps a verified Google Play purchase to TenantSubscription values and
 * applies them through subscription-migration.service.js#applyVerifiedSubscription
 * — the one write path shared by every provider. Keyed on
 * externalOriginalTransactionId (= purchaseToken, stable across renewals for
 * one subscription) — safe to call repeatedly.
 *
 * `purchaseToken` is passed explicitly rather than read off `purchase` —
 * Google's subscriptionsv2.get response doesn't echo the token that was
 * used to fetch it, so the caller (who already has it) always supplies it.
 */
const syncSubscriptionFromPurchase = async (
  tenantId,
  purchase,
  purchaseToken,
  { originListingId = null, revoked = false, upcomingOverride = undefined } = {}
) => {
  const lineItem = purchase.lineItems?.[0];
  if (!lineItem) throw createError('Google Play purchase has no line items', 400);

  const productId = lineItem.productId;
  const basePlanId = lineItem.offerDetails?.basePlanId;
  const plan = await findPlanForProductId(productId, basePlanId);
  const isAnnual = basePlanId === plan.androidAnnualBasePlanId;

  const expiresAt = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
  const recurringPrice = lineItem.autoRenewingPlan?.recurringPrice || null;

  // BILL-03: a downgrade bought with ReplacementMode.DEFERRED is recorded by
  // Play on the current purchase (deferredItemReplacement) and applied at
  // renewal — until then it is only pendingChange.
  let upcomingChange = upcomingOverride;
  if (upcomingChange === undefined) {
    upcomingChange = null;
    const deferredProductId = lineItem.deferredItemReplacement?.productId;
    if (deferredProductId && deferredProductId !== productId) {
      const nextPlan = await BillingPlan.findOne({ where: { androidProductId: deferredProductId } });
      if (nextPlan && nextPlan.id !== plan.id) {
        upcomingChange = {
          billingPlanId: nextPlan.id,
          branchCount: nextPlan.branchCount,
          productId: deferredProductId,
          effectiveAt: expiresAt ? expiresAt.toISOString() : null,
        };
      }
    }
  }
  // `revoked`: Google reported this purchase refunded/revoked (RTDN
  // SUBSCRIPTION_REVOKED, a voided-purchase notification, or the Voided
  // Purchases API) — a subscriptionsv2 read alone can't always show it (BILL-02).
  const status = revoked ? 'REVOKED' : _statusFromSubscriptionState(purchase.subscriptionState, expiresAt);
  const latestOrderId = purchase.latestOrderId ? String(purchase.latestOrderId) : null;

  const values = {
    platform: 'ANDROID',
    billingPlanId: plan.id,
    branchCount: plan.branchCount,
    productId,
    externalOriginalTransactionId: purchaseToken,
    externalTransactionId: latestOrderId || purchaseToken,
    environment: purchase.testPurchase ? 'SANDBOX' : 'PRODUCTION',
    startDate: purchase.startTime ? new Date(purchase.startTime).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    endDate: expiresAt ? expiresAt.toISOString().split('T')[0] : null,
    // Catalog price: only a fallback when Play reports no price — see
    // subscription-migration.service.js#applyVerifiedSubscription.
    amount: isAnnual ? plan.annualPrice : plan.monthlyPrice,
    currency: plan.currency,
    billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY',
    // What Play charges for this subscription (BILL-05): the recurring price
    // of the purchased base plan, including any accepted price change.
    chargedAmount: recurringPrice
      ? Math.round((Number(recurringPrice.units || 0) + Number(recurringPrice.nanos || 0) / 1e9) * 100) / 100
      : null,
    chargedCurrency: recurringPrice?.currencyCode || null,
    upcomingChange,
    status,
    autoRenew:
      !!purchase.acknowledgementState && ['ACTIVE', 'GRACE'].includes(status) && lineItem.autoRenewingPlan?.autoRenewEnabled !== false,
    paymentStatus: 'PAID',
    lastVerifiedAt: new Date(),
  };

  return subscriptionMigrationService.applyVerifiedSubscription(tenantId, values, {
    originListingId,
    idempotencyPrefix: values.externalTransactionId,
    // Google's own subscriptionsv2 response says exactly which prior
    // purchase this one replaces — set on a genuine in-app
    // subscription-replacement purchase (see
    // billing_provider.dart#changeAndroidPlan), absent on an unrelated fresh
    // purchase. requestProviderChange only trusts it if it matches the row it
    // independently found ACTIVE.
    supersededExternalId: purchase.linkedPurchaseToken || null,
    // The tenant id the app sent as applicationUserName (BILL-01).
    boundTenantId: purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    logLabel: 'Google Play Billing',
  });
};

/**
 * Acknowledges a purchase with the Play Developer API — Play auto-refunds a
 * subscription left unacknowledged for 3 days (BILL-06). Tolerant of "already
 * acknowledged" (a 400 from Google on retry), which is expected, not an error;
 * any other failure is thrown so the caller can retry it.
 */
const acknowledgePurchaseIfNeeded = async (purchaseToken, productId) => {
  const auth = _playDeveloperApiAuth();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${_packageName()}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
  try {
    await auth.request({ url, method: 'POST', data: {} });
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message || '';
    if (!/already.*acknowledg/i.test(message)) throw err;
  }
};

/**
 * Voided Purchases API — subscription purchases refunded, charged back or
 * revoked since `startTimeMillis`. Read by the daily sweep so a refund whose
 * RTDN never arrived still ends entitlement (BILL-02, spec §7.6).
 */
const listVoidedPurchases = async (startTimeMillis) => {
  const auth = _playDeveloperApiAuth();
  const voided = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ startTime: String(startTimeMillis), type: '1', maxResults: '1000' });
    if (pageToken) params.set('token', pageToken);
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${_packageName()}/purchases/voidedpurchases?${params}`;
    const response = await auth.request({ url, method: 'GET' });
    voided.push(...(response.data?.voidedPurchases || []));
    pageToken = response.data?.tokenPagination?.nextPageToken || null;
  } while (pageToken);
  return voided;
};

const playApi = { getSubscriptionPurchase, acknowledgePurchaseIfNeeded, listVoidedPurchases };

/**
 * The one entry point both POST /billing/android/sync and the RTDN processor
 * (billing-event.service.js) use: re-fetch the purchase from the Play
 * Developer API (never the notification's own claims), then apply it through
 * syncSubscriptionFromPurchase.
 */
const syncFromGoogle = async ({ purchaseToken, tenantId = null, originListingId = null, revoked = false, throwOnAckFailure = false }) => {
  const purchase = await playApi.getSubscriptionPurchase(purchaseToken);
  // Without a caller tenant (RTDN, daily sweep): the existing row's owner, or
  // the tenant named by obfuscatedExternalAccountId; null when nobody owns it.
  const owner =
    tenantId ||
    (await subscriptionMigrationService.resolveSubscriptionOwner(
      'ANDROID',
      purchaseToken,
      purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId
    ));
  if (!owner) return null;

  // A replacement purchase that Play has not started yet (DEFERRED downgrade,
  // BILL-03): not in effect, so it must not supersede the plan the host is
  // still on. It is recorded as that plan's pendingChange instead; the
  // replacement is applied when Play reports it started (its RTDN, or the sweep).
  if (purchase.linkedPurchaseToken && purchase.startTime && new Date(purchase.startTime) > new Date()) {
    const lineItem = purchase.lineItems?.[0];
    const nextPlan = lineItem ? await findPlanForProductId(lineItem.productId, lineItem.offerDetails?.basePlanId) : null;
    const linked = await playApi.getSubscriptionPurchase(purchase.linkedPurchaseToken);
    const subscription = await syncSubscriptionFromPurchase(owner, linked, purchase.linkedPurchaseToken, {
      originListingId,
      upcomingOverride: nextPlan
        ? {
          billingPlanId: nextPlan.id,
          branchCount: nextPlan.branchCount,
          productId: lineItem.productId,
          effectiveAt: new Date(purchase.startTime).toISOString(),
        }
        : undefined,
    });
    await _acknowledgeVerifiedPurchase(purchase, purchaseToken, { throwOnAckFailure });
    return subscription;
  }

  const subscription = await syncSubscriptionFromPurchase(owner, purchase, purchaseToken, { originListingId, revoked });
  await _acknowledgeVerifiedPurchase(purchase, purchaseToken, { throwOnAckFailure });
  return subscription;
};

/**
 * Server-side acknowledgement, as part of the verified sync (BILL-06, spec
 * §7.5.1): only after the purchase was verified with Google and applied, only
 * when Google says it still needs acknowledging, only for a paid (active or
 * grace) purchase, and with the product id Google reported — never the
 * client's. The app's own completePurchase is now only a backup.
 *
 * A failure must not fail the app's /sync (the app completes the purchase
 * only after a 200), so by default it is recorded in the billing_events inbox
 * as `ack:<token>` and the sweep retries it. When already running from the
 * inbox (`throwOnAckFailure`), it throws so that event stays FAILED.
 */
const ACKNOWLEDGEABLE_STATES = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'];
const _acknowledgeVerifiedPurchase = async (purchase, purchaseToken, { throwOnAckFailure }) => {
  if (purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_PENDING') return;
  if (!ACKNOWLEDGEABLE_STATES.includes(purchase.subscriptionState)) return;
  const productId = purchase.lineItems?.[0]?.productId;
  try {
    await playApi.acknowledgePurchaseIfNeeded(purchaseToken, productId);
  } catch (err) {
    if (throwOnAckFailure) throw err;
    console.warn('[Google Play Billing] Acknowledge failed; queued for retry:', err.message);
    const billingEvents = require('./billing-event.service');
    const { event, duplicate } = await billingEvents.recordEvent({
      provider: 'GOOGLE',
      providerEventId: `ack:${purchaseToken}`,
      eventType: 'acknowledge-retry',
      rawPayload: { ackRetry: { purchaseToken } },
    });
    if (!duplicate) await event.update({ status: 'FAILED', lastError: String(err.message).slice(0, 500) });
  }
};

module.exports = {
  playApi,
  getSubscriptionPurchase,
  findPlanForProductId,
  syncSubscriptionFromPurchase,
  acknowledgePurchaseIfNeeded,
  syncFromGoogle,
};
