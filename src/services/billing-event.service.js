/**
 * Billing webhook inbox and processor (BILL-12, spec §7.6).
 *
 *   receive → (sender already verified by the controller)
 *           → INSERT billing_events (provider, providerEventId UNIQUE)
 *               already PROCESSED/IGNORED → stop (a redelivery is a no-op)
 *           → process: re-fetch the provider's current truth and apply it
 *             through the SAME sync entry point the app's /sync uses
 *             (appleBilling.syncFromApple / googlePlayBilling.syncFromGoogle /
 *             stripeBilling.syncFromStripe) → mark PROCESSED | IGNORED
 *           → on error: FAILED + lastError + attempts; the sweep retries it
 *
 * The event is processed inline, before the webhook responds, because the
 * API also runs on Vercel serverless, where work left running after the
 * response can be frozen. Once the row is inserted the webhook answers 200
 * even if processing failed — the sweep owns the retry, not the provider.
 *
 * Nothing here trusts a notification's own claims about state: the payload
 * only tells us WHICH subscription to look at. Because every event re-reads
 * the provider, events arriving out of order still converge on the
 * provider's truth.
 */
const { Op, UniqueConstraintError } = require('sequelize');
const { BillingEvent, TenantSubscription } = require('../models/platform');

const ALERT_AFTER_ATTEMPTS = 5;
const MAX_SWEEP_ATTEMPTS = 20;

/**
 * Inserts the event, or finds the existing row for a redelivery.
 * @returns {Promise<{ event: object, duplicate: boolean }>}
 */
const recordEvent = async ({ provider, providerEventId, eventType = null, rawPayload }) => {
  try {
    const event = await BillingEvent.create({
      provider,
      providerEventId: String(providerEventId),
      eventType,
      rawPayload: typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload),
      status: 'RECEIVED',
      receivedAt: new Date(),
    });
    return { event, duplicate: false };
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    const event = await BillingEvent.findOne({ where: { provider, providerEventId: String(providerEventId) } });
    return { event, duplicate: true };
  }
};

const _processApple = async (payload) => {
  const appleBilling = require('./apple-billing.service');
  const decoded = appleBilling.appleApi.verifyAndDecode(payload.signedPayload);
  const transactionJws = decoded.data?.signedTransactionInfo;
  if (!transactionJws) return { outcome: 'IGNORED', note: `${decoded.notificationType || 'Notification'} carries no transaction` };
  // Used only as a key to look the subscription up — its state is re-fetched.
  const transaction = appleBilling.appleApi.verifyAndDecode(transactionJws);
  const synced = await appleBilling.syncFromApple({ transactionId: String(transaction.originalTransactionId) });
  if (!synced) return { outcome: 'IGNORED', note: 'No GymsEra tenant owns this transaction' };
  return { outcome: 'PROCESSED' };
};

// RTDN subscriptionNotification.notificationType 12 = SUBSCRIPTION_REVOKED.
const GOOGLE_SUBSCRIPTION_REVOKED = 12;

const _processGoogle = async (payload) => {
  const googlePlayBilling = require('./google-play-billing.service');
  let purchaseToken;
  let revoked = false;
  if (payload?.ackRetry) {
    // Recorded by google-play-billing.service.js when a server-side
    // acknowledge failed (BILL-06): re-run the same verified sync + ack.
    purchaseToken = payload.ackRetry.purchaseToken;
  } else if (payload?.voidedPurchase) {
    // Recorded by sweepGoogleVoidedPurchases from the Voided Purchases API.
    purchaseToken = payload.voidedPurchase.purchaseToken;
    revoked = true;
  } else {
    const dataB64 = payload?.message?.data;
    if (!dataB64) return { outcome: 'IGNORED', note: 'Empty Pub/Sub message' };
    const decoded = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'));
    if (decoded.voidedPurchaseNotification) {
      purchaseToken = decoded.voidedPurchaseNotification.purchaseToken;
      revoked = true;
    } else {
      purchaseToken = decoded.subscriptionNotification?.purchaseToken;
      revoked = decoded.subscriptionNotification?.notificationType === GOOGLE_SUBSCRIPTION_REVOKED;
    }
  }
  if (!purchaseToken) return { outcome: 'IGNORED', note: 'Not a subscription notification' };

  const synced = await googlePlayBilling.syncFromGoogle({ purchaseToken, revoked, throwOnAckFailure: true });
  if (!synced) return { outcome: 'IGNORED', note: 'No GymsEra tenant owns this purchase token' };
  if (synced.pending) return { outcome: 'IGNORED', note: `Not paid: ${synced.paymentState} — nothing granted (BILL-08)` };
  return { outcome: 'PROCESSED' };
};

const _processStripe = async (payload) => {
  const stripeBilling = require('./stripe-billing.service');
  return stripeBilling.processWebhookEvent(payload);
};

const PROCESSORS = { APPLE: _processApple, GOOGLE: _processGoogle, STRIPE: _processStripe };

/**
 * Processes one inbox row. Never throws — the outcome is written to the row.
 * @returns {Promise<object>} the updated BillingEvent.
 */
const processEvent = async (event) => {
  const attempts = event.attempts + 1;
  try {
    const payload = JSON.parse(event.rawPayload);
    const { outcome, note = null } = await PROCESSORS[event.provider](payload);
    await event.update({ status: outcome, attempts, lastError: note, processedAt: new Date() });
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    await event.update({ status: 'FAILED', attempts, lastError: message });
    const log = attempts >= ALERT_AFTER_ATTEMPTS ? console.error : console.warn;
    log(
      `[BillingEvent]${attempts >= ALERT_AFTER_ATTEMPTS ? ' ALERT' : ''} ${event.provider} event ${event.providerEventId} ` +
        `failed (attempt ${attempts}): ${message}`
    );
  }
  return event;
};

/**
 * Records a verified provider event and processes it unless an earlier
 * delivery already did. Throws only if the event could not be recorded — the
 * webhook must then answer non-2xx so the provider redelivers.
 */
const receiveEvent = async (fields) => {
  const { event, duplicate } = await recordEvent(fields);
  if (duplicate && ['PROCESSED', 'IGNORED'].includes(event.status)) return event;
  return processEvent(event);
};

/**
 * Retries every RECEIVED/FAILED event, oldest first. Run every minute by
 * server.js and daily by the subscription-expiry cron (Vercel).
 */
const processPendingEvents = async ({ limit = 50 } = {}) => {
  const pending = await BillingEvent.findAll({
    where: { status: { [Op.in]: ['RECEIVED', 'FAILED'] }, attempts: { [Op.lt]: MAX_SWEEP_ATTEMPTS } },
    order: [['receivedAt', 'ASC']],
    limit,
  });
  for (const event of pending) {
    await processEvent(event);
  }
  return { processed: pending.length };
};

/**
 * Re-fetches one store-backed row from its provider through that provider's
 * one sync entry point (the same one webhooks and the app's /sync use).
 */
const refreshStoreSubscription = async (row) => {
  if (row.platform === 'IOS') {
    return require('./apple-billing.service').syncFromApple({
      transactionId: row.externalOriginalTransactionId,
      tenantId: row.tenantId,
    });
  }
  if (row.platform === 'ANDROID') {
    return require('./google-play-billing.service').syncFromGoogle({
      purchaseToken: row.externalOriginalTransactionId,
      tenantId: row.tenantId,
    });
  }
  if (row.platform === 'STRIPE') {
    return require('./stripe-billing.service').syncFromStripe({ subscriptionId: row.externalOriginalTransactionId });
  }
  throw new Error(`Not a store-backed subscription: ${row.platform}`);
};

/**
 * Daily safety net for notifications that never arrived: every store-backed
 * row that can still carry entitlement is re-fetched through the same sync
 * entry point (spec §7.6).
 */
const reconcileStoreSubscriptions = async () => {
  const rows = await TenantSubscription.findAll({
    where: {
      platform: { [Op.in]: ['IOS', 'ANDROID', 'STRIPE'] },
      // GRACE / ON_HOLD / PAUSED can still recover (or lapse) at the provider (BILL-04).
      status: { [Op.in]: ['ACTIVE', 'GRACE', 'ON_HOLD', 'PAUSED', 'PENDING_CANCEL', 'SCHEDULED'] },
      externalOriginalTransactionId: { [Op.ne]: null },
    },
    attributes: ['id', 'tenantId', 'platform', 'externalOriginalTransactionId'],
  });
  let failed = 0;
  for (const row of rows) {
    try {
      await refreshStoreSubscription(row);
    } catch (err) {
      failed++;
      console.warn(`[BillingEvent] Daily reconciliation failed for subscription ${row.id} (${row.platform}): ${err.message}`);
    }
  }
  return { checked: rows.length, failed };
};

/**
 * Daily: Google refunds/chargebacks/revokes from the Voided Purchases API,
 * recorded in the inbox (one event per voided order — overlapping windows are
 * harmless) and processed like a voided-purchase RTDN (BILL-02, spec §7.6).
 */
const sweepGoogleVoidedPurchases = async ({ windowDays = 3 } = {}) => {
  const googlePlayBilling = require('./google-play-billing.service');
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const voided = await googlePlayBilling.playApi.listVoidedPurchases(since);
  for (const v of voided) {
    if (!v.purchaseToken || !v.orderId) continue;
    await receiveEvent({
      provider: 'GOOGLE',
      providerEventId: `voided:${v.orderId}`,
      eventType: 'voided-purchase',
      rawPayload: { voidedPurchase: v },
    });
  }
  return { found: voided.length };
};

module.exports = {
  ALERT_AFTER_ATTEMPTS,
  recordEvent,
  processEvent,
  receiveEvent,
  processPendingEvents,
  refreshStoreSubscription,
  reconcileStoreSubscriptions,
  sweepGoogleVoidedPurchases,
};
