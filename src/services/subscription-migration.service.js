/**
 * The single choke point for activating a *new* external subscription
 * (a purchase/webhook event for an externalOriginalTransactionId this
 * tenant's TenantSubscription rows have never seen before) — whether that's
 * a tenant's first-ever subscription, a same-provider upgrade that issued a
 * fresh purchase token/subscription id (Android without replacementMode
 * wired yet, or a fresh Stripe Checkout session), or a real cross-provider
 * migration (Apple → Stripe, Google → iOS, etc.). Any time a current ACTIVE
 * row already exists and this is a different external id than that row's,
 * the old row is properly superseded here — never left ACTIVE alongside
 * the new one, regardless of whether the two are the same platform or not.
 *
 * Every provider's own sync function (apple-billing.service.js,
 * google-play-billing.service.js, stripe-billing.service.js) calls
 * `requestProviderChange` exactly once, only when its own row lookup by
 * externalOriginalTransactionId came back empty — a renewal or plan-change
 * on an *already-seen* external id never reaches this file at all; it keeps
 * using that provider's own direct `existing.update(...)` path, unchanged.
 *
 * Why this all has to happen under one lock, in one function, instead of
 * each caller deciding "do I migrate or just create" for itself first: two
 * different providers' purchases can genuinely land for the same tenant at
 * nearly the same moment (a website Stripe checkout completing while a
 * pending Android purchase's RTDN fires). If each caller independently
 * checked "is there a current ACTIVE row" with a plain unlocked SELECT
 * before deciding what to do, both could see the same stale answer and
 * both take the wrong branch — either both creating a second ACTIVE row, or
 * (worse) one of them silently losing its own real, paid-for purchase
 * because by the time it acted, the tenant's active row had already changed
 * out from under it. Locking the Tenant row first — before any of that
 * branching — serializes every concurrent activation attempt for the same
 * tenant into one at a time, and each one re-reads reality fresh under that
 * lock, so this can never happen. (Lock order — Tenant, then GymListing
 * inside reconcileCapacity — matches the order already used by the locked
 * restoreBranch code in gym.service.js, so this doesn't introduce a new
 * deadlock risk against that path.)
 *
 * The rule this enforces: at most one TenantSubscription row per tenant is
 * ever ACTIVE, and a provider change must never destroy a real, paid-for
 * entitlement to get there. A host who paid Apple through October 20 and
 * buys through Stripe on October 1 keeps their Apple subscription on record
 * (never hard-deleted), the new Stripe purchase becomes authoritative for
 * capacity immediately (they already paid for it — withholding it is worse
 * than the alternative), and the old Apple row is marked so a human (the
 * host, or Super Admin) can see it needs their own attention:
 *
 *   - Old provider is Stripe (we control it server-side): mark the row
 *     SCHEDULED — the caller schedules the real cancel-at-period-end call
 *     against Stripe's API *after* this transaction commits (never inside
 *     it — see each billing service's post-commit hook).
 *   - Old provider is Apple/Google (no server-side cancellation API for a
 *     user's own store subscription exists): the row is marked
 *     PENDING_CANCEL with a note — the UI must tell the host to cancel it
 *     themselves in Settings / Play Store to avoid being charged again.
 *     GymsEra cannot and does not silently do this for them.
 */
const { URLSearchParams } = require('url');
const { Op, UniqueConstraintError } = require('sequelize');
const { Tenant, TenantSubscription } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');

const { ENTITLING_STATUSES, ENDED_STATUSES } = subscriptionQuotaService;
const _entitling = (status) => ENTITLING_STATUSES.includes(status);

/**
 * @param {string} tenantId
 * @param {object} params
 * @param {'IOS'|'ANDROID'|'STRIPE'} params.newPlatform
 * @param {object} params.newSubscriptionValues - the full row to create for the new provider (same shape each provider's own sync function already builds).
 * @param {object} opts
 * @param {import('sequelize').Transaction} opts.transaction - REQUIRED, the same platform-DB transaction the caller is already inside.
 * @param {object|null} opts.tenantDb - the tenant's own DB connection, for reconcileCapacity.
 * @param {string|null} opts.originListingId
 * @param {string} opts.idempotencyPrefix
 * @param {string|null} params.supersededExternalId - when the new provider's own API has already confirmed (not just claimed) that this purchase directly replaces a specific prior one — currently only Google Play's `linkedPurchaseToken` on a subscription-replacement purchase — and it matches currentActive.externalOriginalTransactionId, the old row is closed out as a confirmed, store-handled replacement instead of the uncertain "ask the host to cancel it themselves" path. Never trusted blindly: it only changes anything if it actually matches the row this function independently found to be ACTIVE.
 * @returns {Promise<{subscription: object, migratedFrom: object|null, isMigration: boolean}>} `subscription` is never null — this function always either creates or migrates.
 */
const requestProviderChange = async (
  tenantId,
  { newPlatform, newSubscriptionValues, supersededExternalId = null },
  { transaction, tenantDb, originListingId = null, idempotencyPrefix, actorUserId = null, actorType = 'SYSTEM' }
) => {
  if (!transaction) throw new Error('requestProviderChange requires a platform-DB transaction');

  // The single serialization point: every concurrent activation attempt for
  // this tenant — regardless of which provider — blocks here until whichever
  // one got there first finishes and commits. See the file header for why
  // this has to happen before the ACTIVE-row check below, not after.
  const tenant = await Tenant.findByPk(tenantId, { transaction, lock: true });
  if (!tenant) throw new Error(`Tenant ${tenantId} not found`);

  // ACTIVE or GRACE — a row in grace is still the tenant's one entitlement,
  // so a new purchase supersedes it like an ACTIVE one (BILL-04).
  const currentActive = await TenantSubscription.findOne({
    where: { tenantId, status: { [Op.in]: ENTITLING_STATUSES } },
    transaction,
    lock: true,
  });

  if (!currentActive) {
    // No entitlement to migrate away from — a fresh first-ever subscription.
    const subscription = await TenantSubscription.create(
      { ...newSubscriptionValues, tenantId, platform: newPlatform, status: 'ACTIVE' },
      { transaction }
    );

    if (tenantDb) {
      await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, newSubscriptionValues.branchCount, {
        transaction,
        previousMaxBranches: null,
        originListingId,
        idempotencyPrefix,
        actorUserId,
        actorType,
      });
    }

    return { subscription, migratedFrom: null, isMigration: false };
  }

  // currentActive exists, and — because this function is only ever called
  // once a provider's own lookup by externalOriginalTransactionId has
  // already come back empty — the row being activated here is necessarily a
  // *different* external subscription than currentActive, whether that's a
  // genuinely different provider (Apple → Stripe) or the same store having
  // issued a fresh purchase token/subscription id for what it considers a
  // continuation (e.g. an Android plan change without replacementMode
  // wired client-side yet, or a fresh Stripe Checkout session instead of an
  // in-place price update on the existing subscription). Both cases are
  // handled identically here — the old row is always properly superseded,
  // never silently left ACTIVE alongside the new one, which is what an
  // earlier version of this function got wrong for the same-platform case
  // (found during audit: neither Android's nor Stripe's "new token per
  // upgrade" behavior is naturally caught by the `existing` lookup the way
  // Apple's stable originalTransactionId is, so a same-provider upgrade
  // would have silently created a second ACTIVE row of the same platform).
  const previousMaxBranches = currentActive.branchCount;

  // Held for the duration of this transaction so a mid-flight failure below
  // rolls the whole thing back — the old row is never left stranded in a
  // state other than ACTIVE or its real terminal one.
  await currentActive.update({ status: 'PENDING_MIGRATION' }, { transaction });

  const newSubscription = await TenantSubscription.create(
    { ...newSubscriptionValues, tenantId, platform: newPlatform, status: 'ACTIVE' },
    { transaction }
  );

  if (tenantDb) {
    await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, newSubscriptionValues.branchCount, {
      transaction,
      previousMaxBranches,
      originListingId,
      idempotencyPrefix,
      actorUserId,
      actorType,
    });
  }

  const storeLabel = { IOS: 'Apple', ANDROID: 'Google Play', STRIPE: 'Stripe' };
  const today = new Date().toISOString().split('T')[0];
  // Store-confirmed, not client-claimed — only true when the provider's own
  // API response (google-play-billing.service.js reading Google's
  // linkedPurchaseToken) said this new purchase replaces exactly the row
  // this function independently locked and found ACTIVE.
  const storeConfirmedReplacement =
    !!supersededExternalId && currentActive.externalOriginalTransactionId === supersededExternalId;
  if (storeConfirmedReplacement) {
    // Google Play's own subscription-replacement flow already closed out
    // the old entitlement as part of granting the new one — there is
    // nothing left for the host to do, unlike the PENDING_CANCEL/SCHEDULED
    // cases below where GymsEra genuinely cannot confirm the old one is
    // handled.
    await currentActive.update(
      {
        status: 'CANCELLED',
        statusNote: `Replaced by an in-app plan change on ${today} — no action needed.`,
      },
      { transaction }
    );
  } else if (currentActive.platform === 'STRIPE') {
    // We control Stripe server-side — schedule its real cancellation. The
    // caller (stripe-billing.service.js, or another provider's service via
    // its own post-commit hook) is responsible for actually calling
    // stripe.subscriptions.update(..., {cancel_at_period_end: true}) using
    // currentActive.externalOriginalTransactionId once this transaction
    // commits — a Stripe API call must never happen inside a DB transaction
    // that might still roll back. We only record local state here.
    await currentActive.update(
      {
        status: 'SCHEDULED',
        statusNote: `Superseded by a new ${storeLabel[newPlatform]} subscription on ${today} — Stripe cancellation scheduled for the end of the current billing period.`,
      },
      { transaction }
    );
  } else {
    // Apple or Google — cannot be cancelled server-side. Surface guidance;
    // the row stays PENDING_CANCEL until that store's own webhook/RTDN
    // eventually reports it cancelled or expired on its own (or, for a
    // same-platform case where the store itself already invalidated the old
    // token as part of its own upgrade flow, this guidance is redundant but
    // harmless).
    await currentActive.update(
      {
        status: 'PENDING_CANCEL',
        statusNote: `Superseded by a new ${storeLabel[newPlatform]} subscription on ${today} — cancel the ${storeLabel[currentActive.platform]} subscription yourself to avoid being charged again.`,
      },
      { transaction }
    );
  }

  return { subscription: newSubscription, migratedFrom: currentActive, isMigration: true };
};

/**
 * Guards the *renewal* path — an already-known row's own status being
 * refreshed from what its provider reports right now — against resurrecting
 * a row that a prior requestProviderChange call already superseded.
 *
 * requestProviderChange enforces "at most one ACTIVE row per tenant" only
 * at the moment a NEW external subscription id is first activated. It has
 * no say over what happens afterwards, when that same external
 * subscription's own provider reports its live status again — a renewal, an
 * RTDN, a resync — and every provider's own sync function (apple-
 * billing.service.js, google-play-billing.service.js) writes that status to
 * an already-known row directly, with no invariant check at all, because
 * bypassing requestProviderChange there is deliberate: a plain renewal on
 * the tenant's own current entitlement must not re-run migration logic.
 *
 * The gap: a row requestProviderChange demoted to PENDING_CANCEL/CANCELLED/
 * SCHEDULED can still be a real, live, billing subscription at the store —
 * this happens whenever the "supersession" wasn't an actual store-confirmed
 * replacement (e.g. two independent purchases rather than a true in-app
 * plan change), so the store never really cancelled the old one. Without
 * this guard, the very next renewal notification for that still-billing old
 * subscription flips it straight back to ACTIVE, producing two ACTIVE rows
 * for the same tenant — silently reintroducing the exact bug
 * requestProviderChange exists to prevent, just on a delay. (Found during
 * live Android testing: a tenant who bought two branch tiers as separate
 * purchases, rather than through in-app plan-change, ended up with both
 * subscriptions genuinely billing at Google, and the older one's renewal
 * RTDN silently resurrected it to ACTIVE alongside the newer one.)
 *
 * The one legitimate case where a demoted row SHOULD become ACTIVE again is
 * when it is no longer actually superseded — whatever replaced it has
 * itself since left ACTIVE, and this row is, in fact, the only live
 * entitlement left. That case is let through untouched; refusing it would
 * leave a tenant who is genuinely paying with no active entitlement at all.
 *
 * @param {string} tenantId
 * @param {object} existingRow - the TenantSubscription row about to be updated (Sequelize instance, already locked by the caller).
 * @param {object} incomingValues - the values object the caller is about to pass to existingRow.update(...).
 * @param {object} opts
 * @param {import('sequelize').Transaction} opts.transaction - REQUIRED, the same transaction existingRow was locked and will be updated under.
 * @returns {Promise<object>} incomingValues, unmodified — or with status/statusNote overridden to keep this row in its superseded state.
 */
const reconcileRenewalStatus = async (tenantId, existingRow, incomingValues, { transaction }) => {
  if (!transaction) throw new Error('reconcileRenewalStatus requires a platform-DB transaction');

  // "ACTIVE" here means the entitling set (ACTIVE or GRACE, BILL-04).
  if (!_entitling(incomingValues.status) || _entitling(existingRow.status)) {
    // Not a resurrection attempt: either the provider itself says this
    // subscription is no longer active (always safe to record as-is — a
    // terminal status can never violate the one-ACTIVE-row invariant), or
    // this row was already ACTIVE and is just renewing normally.
    return incomingValues;
  }

  // Same serialization point every other activation decision in this file
  // uses, and for the identical reason: two renewal events for two
  // different superseded rows of the same tenant must not both
  // independently conclude "no other ACTIVE row exists" and both resurrect.
  await Tenant.findByPk(tenantId, { transaction, lock: true });

  const otherActive = await TenantSubscription.findOne({
    where: { tenantId, status: { [Op.in]: ENTITLING_STATUSES }, id: { [Op.ne]: existingRow.id } },
    transaction,
    lock: true,
  });

  if (!otherActive) {
    // Nothing else is claiming to be this tenant's active entitlement, so
    // this one legitimately is — let the normal write proceed.
    return incomingValues;
  }

  // A different row is this tenant's one authoritative entitlement. Refuse
  // to resurrect this one to ACTIVE regardless of what the provider says —
  // and log loudly, because this means the store still considers BOTH
  // subscriptions live (real money on both), which the app cannot fix on
  // its own; it needs a human to cancel one at the store.
  console.warn(
    `[subscription-migration] Refused to resurrect superseded TenantSubscription ${existingRow.id} ` +
    `(tenant ${tenantId}, platform ${existingRow.platform}) to ACTIVE — TenantSubscription ${otherActive.id} ` +
    `is already this tenant's active entitlement. The provider still reports this subscription as live, ` +
    `which likely means both are genuinely billing at the store and a human needs to cancel one.`
  );

  return {
    ...incomingValues,
    status: existingRow.status,
    statusNote:
      existingRow.statusNote ||
      `Still billing at the store, but superseded by another active GymsEra subscription — cancel this one at the store if you don't need both.`,
  };
};

/**
 * The ONE code path that writes a store-verified subscription state to
 * TenantSubscription (BILL-12, spec §7.6). Every provider's sync function
 * (apple-billing / google-play-billing / stripe-billing) builds `values` from
 * its own provider API response and hands them here — whether the sync was
 * triggered by the app's POST /billing/{ios|android}/sync or by a webhook
 * processed from the billing_events inbox. Before this existed, the three
 * providers each carried an identical copy of this block.
 *
 * Known external id → direct update through reconcileRenewalStatus (renewal,
 * plan change, cancel). Unknown external id → requestProviderChange (first
 * purchase or migration). Either way capacity is reconciled inside the same
 * transaction as the row write, and the Stripe cancel-at-period-end call for a
 * migration away from Stripe happens only after commit.
 *
 * @param {string} tenantId - the tenant the subscription belongs to.
 * @param {object} values - the row as the provider reports it. `chargedAmount`
 *   / `chargedCurrency` (the provider's actual price, when it reports one) are
 *   written as amount/currency on every sync (BILL-05). Otherwise the catalog
 *   `amount`/`currency` — and `billingCycle` always — are only written for a
 *   new row or a real plan change, never on a plain renewal.
 * @param {object} [opts]
 * @param {string|null} [opts.originListingId]
 * @param {string} opts.idempotencyPrefix - capacity-event key prefix (a per-transaction or per-event id).
 * @param {string|null} [opts.supersededExternalId] - see requestProviderChange.
 * @param {string|null} [opts.boundTenantId] - the tenant the store says made the purchase (BILL-01).
 * @param {string} [opts.logLabel]
 * @returns {Promise<object>} the persisted TenantSubscription.
 */
const applyVerifiedSubscription = async (tenantId, values, opts = {}) => {
  // Two tenants verifying the same brand-new transaction at the same moment
  // both find no row; the UNIQUE (platform, external id) index (or InnoDB's
  // deadlock detection on the gap lock) stops the second. One retry then
  // finds the winner's row and answers with the ownership check below.
  for (let attempt = 1; ; attempt++) {
    try {
      return await _applyVerifiedSubscriptionOnce(tenantId, values, opts);
    } catch (err) {
      const raced = err instanceof UniqueConstraintError || err.original?.code === 'ER_LOCK_DEADLOCK';
      if (!raced || attempt >= 2) throw err;
    }
  }
};

const _ownedByOtherAccount = () => {
  const err = createError('This subscription belongs to a different GymsEra account.', 409);
  err.code = 'subscription_owned_by_other_account';
  return err;
};

const _applyVerifiedSubscriptionOnce = async (
  tenantId,
  values,
  { originListingId = null, idempotencyPrefix, supersededExternalId = null, boundTenantId = null, logLabel = 'Billing' } = {}
) => {
  const { sequelize } = require('../database/platform');
  const TenantDbManager = require('../database/TenantDbManager');

  const platformTx = await sequelize.transaction();
  try {
    const existing = await TenantSubscription.findOne({
      where: { platform: values.platform, externalOriginalTransactionId: values.externalOriginalTransactionId },
      transaction: platformTx,
      lock: true,
    });

    // BILL-01: a store purchase belongs to exactly one tenant. Once a row
    // exists, its tenant owns it — a restore/verify from any other account is
    // refused and changes nothing (moving a plan between accounts needs an
    // explicit, audited transfer, not a side effect of Restore). Before any
    // row exists, the tenant id the app sent with the purchase — echoed back
    // by the store (Apple appAccountToken / Google obfuscatedExternalAccountId
    // / our own Stripe metadata) — decides.
    const bound = boundTenantId ? String(boundTenantId).toLowerCase() : null;
    if (existing) {
      if (existing.tenantId !== tenantId) throw _ownedByOtherAccount();
      if (bound && bound !== String(existing.tenantId).toLowerCase()) {
        console.warn(
          `[${logLabel}] TenantSubscription ${existing.id} is owned by tenant ${existing.tenantId}, but the store says ` +
            `tenant ${bound} made the purchase — left with its current owner; needs a human look.`
        );
      }
    } else if (bound && bound !== String(tenantId).toLowerCase()) {
      throw _ownedByOtherAccount();
    }

    const previousMaxBranches = existing ? existing.branchCount : null;
    // A genuinely new row, or a real plan change (upgrade/downgrade) — as
    // opposed to a plain renewal of the same plan, which must NOT recompute
    // billingCycle or fall back to the catalog price.
    const planChanged = !existing || existing.billingPlanId !== values.billingPlanId;
    const { chargedAmount = null, chargedCurrency = null, ...providerValues } = values;
    const rowValues = { ...providerValues, tenantId };
    // The owner of an existing row is never rewritten by a sync.
    if (existing) delete rowValues.tenantId;
    // Subscriber price (BILL-05, spec §7.2): what the provider actually charges
    // — a store price increase, another storefront's price, a Stripe price
    // migration — on every verified sync. Only when the provider reports no
    // price does the catalog price (and its currency) stand in, and then only
    // for a new row or a real plan change; a catalog edit never reaches here.
    if (chargedAmount != null) {
      rowValues.amount = chargedAmount;
      if (chargedCurrency) rowValues.currency = String(chargedCurrency).toUpperCase();
    } else if (!planChanged) {
      delete rowValues.amount;
      delete rowValues.currency;
    }
    if (!planChanged) delete rowValues.billingCycle;

    const tenantDbFor = async () => {
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (!tenant?.connectionStringEncrypted) return null;
      return TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
    };

    let subscription;
    // True whenever requestProviderChange handled this row (fresh signup or a
    // real cross-provider migration) — it already reconciled capacity itself.
    let reconciledByActivation = false;
    let migratedFrom = null;
    const previousStatus = existing ? existing.status : null;
    if (existing) {
      // A refund/chargeback is not always visible in the provider's
      // subscription object (a Stripe refund, or a Play refund without
      // revoke, still reads "active"), so a later resync of the SAME paid
      // period must not undo a revocation. Only a newer paid period — the
      // host paid again — makes a REVOKED row entitled again (BILL-02).
      if (existing.status === 'REVOKED' && _entitling(rowValues.status) && !(rowValues.endDate > existing.endDate)) {
        rowValues.status = 'REVOKED';
      }
      // A renewal/resync for an external id already on file — never a
      // migration decision. reconcileRenewalStatus refuses to resurrect a
      // superseded row to ACTIVE while another row is this tenant's entitlement.
      const reconciledValues = await reconcileRenewalStatus(tenantId, existing, rowValues, { transaction: platformTx });
      await existing.update(reconciledValues, { transaction: platformTx });
      subscription = existing;
    } else if (!_entitling(rowValues.status)) {
      // First sight of a subscription the provider already reports as not
      // entitling (on hold, paused, expired, revoked — e.g. a restore of an old
      // purchase): record it as it is. It activates nothing and supersedes
      // nothing, so it never goes through requestProviderChange, which always
      // creates an ACTIVE row (BILL-04).
      subscription = await TenantSubscription.create(rowValues, { transaction: platformTx });
    } else {
      const activation = await requestProviderChange(
        tenantId,
        { newPlatform: values.platform, newSubscriptionValues: rowValues, supersededExternalId },
        {
          transaction: platformTx,
          tenantDb: await tenantDbFor(),
          originListingId,
          idempotencyPrefix,
          actorType: 'SYSTEM',
        }
      );
      subscription = activation.subscription;
      reconciledByActivation = true;
      migratedFrom = activation.migratedFrom;
    }

    // subscription.status, not values.status — reconcileRenewalStatus above can
    // override what was about to be written. Reading values.status would
    // reconcile capacity for a row that was just refused ACTIVE status.
    if (!reconciledByActivation && _entitling(subscription.status) && values.branchCount != null) {
      const tenantDb = await tenantDbFor();
      if (tenantDb) {
        await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, values.branchCount, {
          transaction: platformTx,
          previousMaxBranches,
          originListingId,
          idempotencyPrefix,
          actorType: 'SYSTEM',
        });
      }
    }

    // Entitlement ended by a refund/chargeback/revoke (BILL-02, spec §7.5.7),
    // or put on hold / paused by the provider (BILL-04, §7.4): shrink capacity
    // to what the tenant is still entitled to, in the same transaction. Runs
    // once per transition — a replay finds the row already ended.
    if (_entitling(previousStatus) && ENDED_STATUSES.includes(subscription.status)) {
      const tenantDb = await tenantDbFor();
      if (tenantDb) {
        const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
        const stillActive = await subscriptionQuotaService.getActiveSubscription(tenantId, { transaction: platformTx });
        const entitled = await subscriptionQuotaService.resolveMaxBranches(tenant, stillActive, { transaction: platformTx });
        await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, entitled, {
          transaction: platformTx,
          previousMaxBranches,
          // A revoke happens once per subscription. A hold/pause can recur
          // after a recovery, so its key carries the verified transaction id.
          idempotencyPrefix:
            subscription.status === 'REVOKED'
              ? `revoke:${values.platform}:${values.externalOriginalTransactionId}`
              : `${subscription.status.toLowerCase()}:${values.platform}:${idempotencyPrefix}`,
          actorType: 'SYSTEM',
        });
      }
    }

    await platformTx.commit();

    // A real Stripe API call must never happen inside a DB transaction that
    // might still roll back — done here, only after commit, only when this
    // sync just migrated the tenant away from a Stripe subscription.
    if (migratedFrom?.platform === 'STRIPE' && migratedFrom.externalOriginalTransactionId) {
      try {
        const stripeBilling = require('./stripe-billing.service');
        await stripeBilling.cancelAtPeriodEnd(migratedFrom.externalOriginalTransactionId);
      } catch (err) {
        console.warn(`[${logLabel}] Failed to schedule Stripe cancellation after migration:`, err.message);
      }
    }

    return subscription;
  } catch (err) {
    // MySQL already rolled back a deadlock victim; rolling back again would
    // throw and hide the original error.
    if (!platformTx.finished) await platformTx.rollback();
    throw err;
  }
};

/**
 * Who owns a store subscription, for a sync with no caller tenant (a webhook
 * or the daily sweep): the tenant already holding its row, else the tenant the
 * store says bought it (binding token) — only if that tenant really exists.
 * @returns {Promise<string|null>}
 */
const resolveSubscriptionOwner = async (platform, externalId, boundTenantId = null) => {
  const row = await TenantSubscription.findOne({
    where: { platform, externalOriginalTransactionId: String(externalId) },
    attributes: ['tenantId'],
  });
  if (row) return row.tenantId;
  if (!boundTenantId) return null;
  const tenant = await Tenant.findByPk(String(boundTenantId).toLowerCase(), { attributes: ['id'] });
  return tenant ? tenant.id : null;
};

/**
 * Where the host fixes a failed payment while the row is in GRACE (BILL-04,
 * spec §7.4): always the provider's own subscription-management page, built
 * here from fixed addresses and the verified row — never a URL taken from a
 * request or a notification. Stripe has no fixed page per customer: the host
 * opens one through our own POST /billing/stripe/portal-session.
 * @returns {object|null} null unless the row is in GRACE.
 */
const APPLE_MANAGE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
const GOOGLE_MANAGE_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';
const paymentIssueFor = (subscription) => {
  if (!subscription || subscription.status !== 'GRACE') return null;
  switch (subscription.platform) {
    case 'IOS':
      return { provider: 'IOS', manageUrl: APPLE_MANAGE_SUBSCRIPTIONS_URL };
    case 'ANDROID': {
      const pkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
      if (!pkg || !subscription.productId) return { provider: 'ANDROID', manageUrl: GOOGLE_MANAGE_SUBSCRIPTIONS_URL };
      const params = new URLSearchParams({ sku: subscription.productId, package: pkg });
      return { provider: 'ANDROID', manageUrl: `${GOOGLE_MANAGE_SUBSCRIPTIONS_URL}?${params}` };
    }
    case 'STRIPE':
      return { provider: 'STRIPE', manageUrl: null, portalSessionPath: '/api/v1/billing/stripe/portal-session' };
    default:
      return { provider: subscription.platform, manageUrl: null };
  }
};

module.exports = {
  requestProviderChange,
  reconcileRenewalStatus,
  applyVerifiedSubscription,
  resolveSubscriptionOwner,
  paymentIssueFor,
};
