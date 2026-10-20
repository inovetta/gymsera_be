/**
 * Read-only price check against Google Play (BILL-15).
 *
 * Android prices are set in Play Console by hand; the admin then marks the plan "synced". Nothing checked
 * that the two agree. Once a day this job reads each active plan's subscription product from the Play
 * Developer API and compares the stored catalog prices with the base-plan prices Google holds.
 *
 * Hard rules:
 *  - It only reads. It never writes to Google, and never changes a BillingPlan, its prices or its sync
 *    statuses. The only thing it stores is its own result (BillingPlanPriceCheck).
 *  - It is inert without Google credentials (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_PACKAGE_NAME).
 *  - A mismatch raises an alert (ids and counts only). "I could not check" is not a mismatch: a plan whose
 *    product does not exist in Play Console yet (placeholder IDs) is UNVERIFIABLE and stays "admin-attested".
 *  - iOS has no check: Apple's App Store Server API cannot read product prices (that needs an App Store
 *    Connect API key). iOS prices stay "admin-attested" until one exists (decision R-38).
 *
 * What counts as a match: for each price the catalog holds in a currency, Google holds the same amount for
 * that currency in at least one region. A currency Google does not list at all is skipped for extra
 * currencies and makes the plan UNVERIFIABLE for the plan's default currency.
 */
const { BillingPlan, BillingPlanPrice, BillingPlanPriceCheck } = require('../models/platform');
const googlePlay = require('./google-play-billing.service');
const alertService = require('./alert.service');
const { minorDigits, normalizeCurrency } = require('../utils/currency.utils');

const PROVIDER = 'GOOGLE';
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const EXPECTED_PERIOD = { monthly: 'P1M', annual: 'P1Y' };

/** Google Money {currencyCode, units, nanos} -> { currency, minor } in the currency's minor units. */
const moneyToMinor = (money) => {
  if (!money || !money.currencyCode) return null;
  const currency = normalizeCurrency(money.currencyCode);
  const digits = minorDigits(currency);
  const units = Number(money.units || 0);
  const nanos = Number(money.nanos || 0);
  return { currency, minor: units * 10 ** digits + Math.round(nanos / 10 ** (9 - digits)) };
};

/** Every price a base plan holds, as { currency, minor }. */
const basePlanPrices = (basePlan) => {
  const out = [];
  for (const cfg of basePlan.regionalConfigs || []) {
    const m = moneyToMinor(cfg.price);
    if (m) out.push(m);
  }
  const other = basePlan.otherRegionsConfig || {};
  for (const key of ['usdPrice', 'eurPrice']) {
    const m = moneyToMinor(other[key]);
    if (m) out.push(m);
  }
  return out;
};

/** The catalog's price entries for one cadence: the plan's own default currency first, then BillingPlanPrice rows. */
const catalogEntries = (plan, cadence) => {
  const entries = [];
  const defaultCurrency = normalizeCurrency(plan.currency);
  const major = Number(cadence === 'monthly' ? plan.monthlyPrice : plan.annualPrice);
  entries.push({ currency: defaultCurrency, minor: Math.round(major * 10 ** minorDigits(defaultCurrency)), isDefault: true });
  for (const p of plan.prices || []) {
    const currency = normalizeCurrency(p.currency);
    if (currency === defaultCurrency) continue;
    entries.push({ currency, minor: Number(cadence === 'monthly' ? p.monthlyMinor : p.annualMinor), isDefault: false });
  }
  return entries;
};

/**
 * Pure comparison of one plan with the Google product (or a reason it cannot be compared).
 * @returns {{ status: 'VERIFIED'|'MISMATCH'|'UNVERIFIABLE', mismatchCount: number, details: object[] }}
 */
const comparePlan = (plan, product, unverifiableReason = null) => {
  const details = [];
  if (unverifiableReason) {
    return { status: 'UNVERIFIABLE', mismatchCount: 0, details: [{ result: 'UNVERIFIABLE', reason: unverifiableReason }] };
  }

  let mismatchCount = 0;
  let defaultsVerified = 0;
  for (const cadence of ['monthly', 'annual']) {
    const basePlanId = cadence === 'monthly' ? plan.androidMonthlyBasePlanId : plan.androidAnnualBasePlanId;
    const basePlan = (product.basePlans || []).find((b) => b.basePlanId === basePlanId);
    if (!basePlanId || !basePlan) {
      details.push({ cadence, result: 'UNVERIFIABLE', reason: 'base_plan_not_found' });
      continue;
    }

    const period = basePlan.autoRenewingBasePlanType?.billingPeriodDuration;
    if (period && period !== EXPECTED_PERIOD[cadence]) {
      mismatchCount += 1;
      details.push({ cadence, result: 'MISMATCH', reason: 'billing_period', expected: EXPECTED_PERIOD[cadence], actual: period });
    }

    const googlePrices = basePlanPrices(basePlan);
    for (const entry of catalogEntries(plan, cadence)) {
      const sameCurrency = googlePrices.filter((g) => g.currency === entry.currency).map((g) => g.minor);
      if (sameCurrency.length === 0) {
        details.push({ cadence, currency: entry.currency, result: 'UNVERIFIABLE', reason: 'currency_not_in_google', default: entry.isDefault });
      } else if (sameCurrency.includes(entry.minor)) {
        details.push({ cadence, currency: entry.currency, result: 'VERIFIED', default: entry.isDefault });
        if (entry.isDefault) defaultsVerified += 1;
      } else {
        mismatchCount += 1;
        details.push({ cadence, currency: entry.currency, result: 'MISMATCH', reason: 'amount', expectedMinor: entry.minor, googleMinor: [...new Set(sameCurrency)], default: entry.isDefault });
      }
    }
  }

  const status = mismatchCount > 0 ? 'MISMATCH' : defaultsVerified === 2 ? 'VERIFIED' : 'UNVERIFIABLE';
  return { status, mismatchCount, details };
};

const isNotFound = (err) => (err?.response?.status || err?.code) === 404;

/**
 * Checks every active plan that has an Android product. Never throws for one plan's failure.
 * @param {{ play?: object, now?: Date }} [options]  `play` is injectable for tests
 */
const runPriceVerification = async ({ play = googlePlay.playApi, now = new Date() } = {}) => {
  if (!googlePlay.isConfigured()) return { skipped: true, reason: 'not_configured' };

  const plans = await BillingPlan.findAll({
    where: { isActive: true },
    include: [{ model: BillingPlanPrice, as: 'prices' }],
    order: [['sortOrder', 'ASC']],
  });

  const result = { skipped: false, checkedCount: 0, verifiedCount: 0, mismatchCount: 0, unverifiableCount: 0, failureCount: 0, mismatchPlanIds: [] };

  for (const plan of plans) {
    if (!plan.androidProductId) continue;
    let comparison;
    try {
      const product = await play.getSubscriptionProduct(plan.androidProductId);
      comparison = comparePlan(plan, product);
    } catch (err) {
      if (isNotFound(err)) {
        comparison = comparePlan(plan, null, 'product_not_found');
      } else {
        result.failureCount += 1;
        console.error(`[PriceVerification] Google read failed for plan ${plan.id}: ${err.message}`);
        continue;
      }
    }

    await BillingPlanPriceCheck.upsert({
      billingPlanId: plan.id,
      provider: PROVIDER,
      status: comparison.status,
      mismatchCount: comparison.mismatchCount,
      detailsJson: comparison.details,
      checkedAt: now,
    });

    result.checkedCount += 1;
    if (comparison.status === 'VERIFIED') result.verifiedCount += 1;
    else if (comparison.status === 'UNVERIFIABLE') result.unverifiableCount += 1;
    else {
      result.mismatchCount += 1;
      result.mismatchPlanIds.push(plan.id);
    }
  }

  if (result.mismatchCount > 0) {
    await alertService.raise('BILLING_PRICE_MISMATCH', { mismatchCount: result.mismatchCount, planIds: result.mismatchPlanIds });
  }
  if (result.failureCount > 0) {
    await alertService.raise('BILLING_PRICE_CHECK_FAILED', { failureCount: result.failureCount });
  }
  console.log(`[PriceVerification] checked ${result.checkedCount}: ${result.verifiedCount} verified, ${result.mismatchCount} mismatch, ${result.unverifiableCount} unverifiable, ${result.failureCount} failed`);
  return result;
};

/**
 * What the admin screen shows for a plan. "ADMIN_ATTESTED" means the admin says the store matches and
 * nothing has proved it: no check yet, the product is not in Play Console, the check is older than 48 hours,
 * or the provider is iOS.
 */
const describeVerification = (checks = [], now = new Date()) => {
  const google = checks.find((c) => c.provider === PROVIDER);
  let android = { status: 'ADMIN_ATTESTED', checkedAt: null };
  if (google) {
    const fresh = now.getTime() - new Date(google.checkedAt).getTime() <= STALE_AFTER_MS;
    if (fresh && google.status === 'VERIFIED') android = { status: 'VERIFIED', checkedAt: google.checkedAt };
    else if (fresh && google.status === 'MISMATCH') {
      android = { status: 'MISMATCH', checkedAt: google.checkedAt, mismatchCount: google.mismatchCount };
    } else {
      android = { status: 'ADMIN_ATTESTED', checkedAt: google.checkedAt };
    }
  }
  return { android, ios: { status: 'ADMIN_ATTESTED', checkedAt: null } };
};

/** Plans as plain objects with `priceVerification` added. Read-only. */
const listPlansWithVerification = async (planRows, now = new Date()) => {
  const ids = planRows.map((p) => p.id);
  const checks = ids.length ? await BillingPlanPriceCheck.findAll({ where: { billingPlanId: ids } }) : [];
  return planRows.map((p) => ({
    ...p.toJSON(),
    priceVerification: describeVerification(checks.filter((c) => c.billingPlanId === p.id), now),
  }));
};

module.exports = { runPriceVerification, comparePlan, describeVerification, listPlansWithVerification, moneyToMinor, STALE_AFTER_MS };
