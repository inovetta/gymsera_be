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
const { BillingEvent, TenantSubscription, Tenant } = require('../models/platform');
const { withDistributedLock } = require('../utils/distributed-lock');
const { redactString } = require('../utils/log-redaction');

const ALERT_AFTER_ATTEMPTS = 5;
const MAX_SWEEP_ATTEMPTS = 20;
// OBS-05: an event still RECEIVED this long after it arrived is stuck (the minute sweep should have processed it).
const UNPROCESSED_ALERT_AFTER_MS = 10 * 60 * 1000;

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

// The purchase token a Google event is about, and whether it revokes. Shared by the processor and
// by tenant attribution (OBS-05), so both read an event the same way.
const _googleTokenOf = (payload) => {
  if (payload?.ackRetry) {
    // Recorded by google-play-billing.service.js when a server-side
    // acknowledge failed (BILL-06): re-run the same verified sync + ack.
    return { purchaseToken: payload.ackRetry.purchaseToken, revoked: false };
  }
  if (payload?.voidedPurchase) {
    // Recorded by sweepGoogleVoidedPurchases from the Voided Purchases API.
    return { purchaseToken: payload.voidedPurchase.purchaseToken, revoked: true };
  }
  const dataB64 = payload?.message?.data;
  if (!dataB64) return { empty: true };
  const decoded = JSON.parse(Buffer.from(dataB64, 'base64').toString('utf8'));
  if (decoded.voidedPurchaseNotification) {
    return { purchaseToken: decoded.voidedPurchaseNotification.purchaseToken, revoked: true };
  }
  return {
    purchaseToken: decoded.subscriptionNotification?.purchaseToken,
    revoked: decoded.subscriptionNotification?.notificationType === GOOGLE_SUBSCRIPTION_REVOKED,
  };
};

const _processGoogle = async (payload) => {
  const googlePlayBilling = require('./google-play-billing.service');
  const { purchaseToken, revoked, empty } = _googleTokenOf(payload);
  if (empty) return { outcome: 'IGNORED', note: 'Empty Pub/Sub message' };
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

// Event provider -> TenantSubscription.platform
const SUBSCRIPTION_PLATFORM = { APPLE: 'IOS', GOOGLE: 'ANDROID', STRIPE: 'STRIPE' };

// The id the owning TenantSubscription row stores in externalOriginalTransactionId, read from the
// event the same way the processors read it. Null when the event does not name one.
const _storeKeyOf = (event, payload) => {
  if (event.provider === 'APPLE') {
    const appleApi = require('./apple-billing.service').appleApi;
    const decoded = appleApi.verifyAndDecode(payload.signedPayload);
    const jws = decoded.data?.signedTransactionInfo;
    return jws ? appleApi.verifyAndDecode(jws).originalTransactionId : null;
  }
  if (event.provider === 'GOOGLE') return _googleTokenOf(payload).purchaseToken || null;
  const object = payload.data?.object || {};
  if (payload.type?.startsWith('customer.subscription.')) return object.id || null;
  if (payload.type === 'checkout.session.completed' && object.mode === 'subscription') return object.subscription || null;
  return null; // charge.* needs a Stripe API call to find the subscription: left unattributed
};

/**
 * OBS-05: the tenant that already holds the subscription this event is about, or null. Looks the row
 * up exactly like the sync does (subscription-migration.service.js#resolveSubscriptionOwner, with no
 * binding token: attribution never creates or guesses an owner). Never throws.
 */
const resolveTenantId = async (event) => {
  try {
    const key = _storeKeyOf(event, JSON.parse(event.rawPayload));
    if (!key) return null;
    return await require('./subscription-migration.service').resolveSubscriptionOwner(
      SUBSCRIPTION_PLATFORM[event.provider],
      key
    );
  } catch (_) {
    return null;
  }
};

/**
 * Processes one inbox row. Never throws — the outcome is written to the row.
 * The tenant is resolved AFTER the attempt (a first purchase only has its row once the sync ran) and
 * for failures too, so a stuck event can be traced to a tenant. An attributed tenant is never replaced.
 * @returns {Promise<object>} the updated BillingEvent.
 */
const processEvent = async (event) => {
  const attempts = event.attempts + 1;
  try {
    const payload = JSON.parse(event.rawPayload);
    const { outcome, note = null } = await PROCESSORS[event.provider](payload);
    const tenantId = event.tenantId || (await resolveTenantId(event));
    await event.update({ status: outcome, attempts, lastError: note, processedAt: new Date(), tenantId });
  } catch (err) {
    const message = String(err?.message || err).slice(0, 500);
    const tenantId = event.tenantId || (await resolveTenantId(event));
    await event.update({ status: 'FAILED', attempts, lastError: message, tenantId });
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
  return withDistributedLock('cron:billing-events', 120000, async () => {
    const pending = await BillingEvent.findAll({
      where: { status: { [Op.in]: ['RECEIVED', 'FAILED'] }, attempts: { [Op.lt]: MAX_SWEEP_ATTEMPTS } },
      order: [['receivedAt', 'ASC']],
      limit,
    });
    for (const event of pending) {
      await processEvent(event);
    }
    return { processed: pending.length };
  });
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

// How long an EXPIRED store row is still re-fetched every night (P7c item 3, R-82).
const RECHECK_EXPIRED_DAYS = 7;

/**
 * Daily safety net for notifications that never arrived: every store-backed
 * row that can still carry entitlement is re-fetched through the same sync
 * entry point (spec §7.6). That includes a row that stopped entitling as
 * EXPIRED in the last RECHECK_EXPIRED_DAYS: the daily expiry pass expires a
 * store row past its end date when the re-fetch before it failed (an outage),
 * and without this a renewed, paying host stayed expired (NEW-172).
 */
const reconcileStoreSubscriptions = async () => {
  const since = new Date(Date.now() - RECHECK_EXPIRED_DAYS * 24 * 60 * 60 * 1000);
  const rows = await TenantSubscription.findAll({
    where: {
      platform: { [Op.in]: ['IOS', 'ANDROID', 'STRIPE'] },
      externalOriginalTransactionId: { [Op.ne]: null },
      [Op.or]: [
        // GRACE / ON_HOLD / PAUSED can still recover (or lapse) at the provider (BILL-04).
        { status: { [Op.in]: ['ACTIVE', 'GRACE', 'ON_HOLD', 'PAUSED', 'PENDING_CANCEL', 'SCHEDULED'] } },
        { status: 'EXPIRED', entitlementEndedAt: { [Op.gte]: since } },
      ],
    },
    attributes: ['id', 'tenantId', 'platform', 'externalOriginalTransactionId', 'environment'],
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

/**
 * Admin list (OBS-05): newest first, filterable by tenant ('none' = not attributed), status and
 * provider. Never returns `rawPayload` (receipts, signed provider data). `stuck` is true for the
 * rows the alerts are about: RECEIVED for over 10 minutes, or FAILED past the retry threshold.
 */
const listEvents = async ({ tenantId, status, provider, limit = 20, offset = 0 } = {}) => {
  const where = {};
  if (tenantId) where.tenantId = tenantId === 'none' ? null : tenantId;
  if (status) where.status = status;
  if (provider) where.provider = provider;
  const { rows, count } = await BillingEvent.findAndCountAll({
    where,
    attributes: { exclude: ['rawPayload'] },
    order: [['receivedAt', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter(Boolean))];
  const tenants = tenantIds.length ? await Tenant.findAll({ where: { id: tenantIds }, attributes: ['id', 'gymName'] }) : [];
  const nameById = new Map(tenants.map((t) => [t.id, t.gymName]));
  const now = Date.now();
  const items = rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerEventId: r.providerEventId,
    eventType: r.eventType,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError ? redactString(r.lastError) : null,
    tenantId: r.tenantId,
    tenantName: r.tenantId ? nameById.get(r.tenantId) || null : null,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt,
    stuck:
      (r.status === 'RECEIVED' && now - new Date(r.receivedAt).getTime() > UNPROCESSED_ALERT_AFTER_MS) ||
      (r.status === 'FAILED' && r.attempts >= ALERT_AFTER_ATTEMPTS),
  }));
  return { items, total: count };
};

// Counts and ids for an alert: provider split, distinct known tenants (ids only), unattributed events.
const _eventAlertFields = (rows) => {
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter(Boolean))];
  const byProvider = (p) => rows.filter((r) => r.provider === p).length;
  return {
    eventCount: rows.length,
    tenantCount: tenantIds.length,
    tenantIds,
    unattributedEventCount: rows.filter((r) => !r.tenantId).length,
    appleCount: byProvider('APPLE'),
    googleCount: byProvider('GOOGLE'),
    stripeCount: byProvider('STRIPE'),
  };
};

/**
 * OBS-05: raise platform alerts (alert.service.js: admin notification + Sentry, one per code per hour)
 * for billing problems nobody would otherwise see. Run every minute with the inbox sweep and daily by
 * the expiry cron. Ids and counts only. Never throws: a failing alert check must not stop the job.
 *   BILLING_EVENT_UNPROCESSED   RECEIVED for over 10 minutes
 *   BILLING_EVENT_FAILED        FAILED at or past ALERT_AFTER_ATTEMPTS attempts (a retry or two is normal)
 *   BILLING_DUPLICATE_BILLING   a superseded subscription the provider still bills (BILL-09)
 * @returns {Promise<{ raised: string[] }>} the codes that actually went out
 */
const sweepBillingAlerts = async () => {
  const alertService = require('./alert.service');
  const raised = [];
  const send = async (code, fields) => {
    const res = await alertService.raise(code, fields);
    if (res.sent) raised.push(code);
  };
  try {
    const now = Date.now();
    const stuck = await BillingEvent.findAll({
      where: { status: 'RECEIVED', receivedAt: { [Op.lt]: new Date(now - UNPROCESSED_ALERT_AFTER_MS) } },
      attributes: ['provider', 'tenantId', 'receivedAt'],
      order: [['receivedAt', 'ASC']],
      limit: 5000,
    });
    if (stuck.length) {
      await send('BILLING_EVENT_UNPROCESSED', {
        ..._eventAlertFields(stuck),
        oldestAgeMinutesCount: Math.floor((now - new Date(stuck[0].receivedAt).getTime()) / 60000),
      });
    }

    const failed = await BillingEvent.findAll({
      where: { status: 'FAILED', attempts: { [Op.gte]: ALERT_AFTER_ATTEMPTS } },
      attributes: ['provider', 'tenantId', 'attempts'],
      limit: 5000,
    });
    if (failed.length) {
      await send('BILLING_EVENT_FAILED', {
        ..._eventAlertFields(failed),
        maxAttemptsCount: Math.max(...failed.map((r) => r.attempts)),
      });
    }

    const duplicates = await TenantSubscription.findAll({ where: { duplicateBilling: true }, attributes: ['tenantId'], limit: 5000 });
    if (duplicates.length) {
      const tenantIds = [...new Set(duplicates.map((r) => r.tenantId))];
      await send('BILLING_DUPLICATE_BILLING', { tenantCount: tenantIds.length, tenantIds });
    }
  } catch (err) {
    console.error('[BillingEvent] Alert sweep failed:', err.message);
  }
  return { raised };
};

module.exports = {
  UNPROCESSED_ALERT_AFTER_MS,
  resolveTenantId,
  listEvents,
  sweepBillingAlerts,
  ALERT_AFTER_ATTEMPTS,
  recordEvent,
  processEvent,
  receiveEvent,
  processPendingEvents,
  refreshStoreSubscription,
  reconcileStoreSubscriptions,
  sweepGoogleVoidedPurchases,
};
