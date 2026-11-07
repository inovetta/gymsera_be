'use strict';

/**
 * The server check the app makes before it opens an Apple or Google purchase sheet
 * (POST /billing/purchase-intent; BILL-07, Phase 7 P9d NEW-225 / NEW-224, decisions R-95 and R-96).
 *
 * The app never decides; it shows what this answers. Refusals are 409 with a code and a message
 * the app shows as is:
 *  - store_plan_active: another store's plan (Apple vs Google, or card) entitles and renews. Same
 *    first sentence as the P9c bank-transfer refusal (plan-payment.service.js storeBlock).
 *  - same_plan_active: the same catalog plan (and cycle, when sent) already renews on this store.
 *  - bank_plan_active: a PAID bank-transfer plan has days left, and the plan asked for does not
 *    have more branches than it (catalog branchCount; equal is not bigger) (R-96).
 * Allowed answers keep the BILL-07 shape (action, mechanism, appAccountToken, replacementMode) and add
 * `warning` and `requiresConfirmation`: a bigger plan over a paid bank plan replaces it today and its
 * unused paid days are lost (NEW-224); the app must show the warning and ask before the store opens.
 * A cancelled (auto-renew off) or ended plan and an unpaid pay-later plan never block.
 */

const { BillingPlan } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');
const { storeRenewsSentence, STORE_PLATFORMS, MANAGE_URLS, STORE_NAMES } = require('./plan-payment.service');

const DAY_MS = 86400000;
const isoDate = (d) => d.toISOString().split('T')[0];
const displayDate = (iso) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
const branches = (n) => `${n} ${n === 1 ? 'branch' : 'branches'}`;
// NEW-230: whole phrases with their article: "in the App Store", "an App Store plan".
const MANAGE_IN = { IOS: 'the App Store', ANDROID: 'Google Play', STRIPE: STORE_NAMES.STRIPE };
const A_PLAN_ON = { IOS: 'an App Store plan', ANDROID: 'a Google Play plan', STRIPE: `a ${STORE_NAMES.STRIPE} plan` };

const refuse = (status, code, message, data) => {
  const e = createError(message, status);
  e.code = code;
  if (data) e.data = data;
  return e;
};

/** Paid days left on a PAID bank-transfer (MANUAL) plan, or 0. A plan ending today has none left. */
const paidBankDaysLeft = (current, today) => {
  if (!current || current.platform !== 'MANUAL' || current.paymentStatus !== 'PAID' || !current.endDate) return 0;
  const end = String(current.endDate);
  if (end <= today) return 0;
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
};

/** The branch limit the current plan grants: the snapshotted catalog count, or a legacy package's. */
const currentLimit = (current) => current.branchCount ?? current.package?.maxBranches ?? 0;

const evaluate = async ({ tenantId, planId = null, platform, billingCycle = null, today = isoDate(new Date()) }) => {
  const target = String(platform).toUpperCase();
  const targetPlan = planId ? await BillingPlan.findByPk(planId) : null;
  if (planId && !targetPlan) throw refuse(404, 'plan_not_found', 'This plan is no longer offered. Close this screen and choose again.');

  const base = { appAccountToken: tenantId, replacementMode: null, blocker: null, warning: null, requiresConfirmation: false };
  const current = await subscriptionQuotaService.getActiveSubscription(tenantId);
  if (!current) return { ...base, action: 'new', mechanism: 'new' };

  const renews = current.autoRenew !== false;

  // 1. Another store's plan still renews: a second store would bill the host twice (NEW-225).
  if (STORE_PLATFORMS.includes(current.platform) && current.platform !== target && renews) {
    const manageUrl = MANAGE_URLS[current.platform];
    throw refuse(
      409,
      'store_plan_active',
      `${storeRenewsSentence(current.platform)} Change or cancel it in ${MANAGE_IN[current.platform]} first; ` +
        `${A_PLAN_ON[target] || 'a new plan'} can be bought once that plan is cancelled or has ended.`,
      {
        action: 'blocked',
        mechanism: 'blocked',
        reason: 'active_subscription_other_provider',
        platform: current.platform,
        currentPlatform: current.platform,
        manageUrl,
        blocker: { provider: current.platform, manageUrl },
        appAccountToken: tenantId,
      }
    );
  }

  // 2. The same plan already renews on this store.
  const sameCycle = !billingCycle || String(billingCycle).toUpperCase() === current.billingCycle;
  if (current.platform === target && renews && targetPlan && current.billingPlanId === targetPlan.id && sameCycle) {
    throw refuse(409, 'same_plan_active', 'You already have this plan and it renews automatically. There is nothing to buy.', {
      action: 'blocked',
      mechanism: 'blocked',
      reason: 'same_plan_active',
      platform: current.platform,
      appAccountToken: tenantId,
    });
  }

  // 3. A paid bank-transfer plan with days left: only a plan with more branches, after a warning (R-96).
  const unusedDays = paidBankDaysLeft(current, today);
  let warning = null;
  if (unusedDays > 0) {
    if (!targetPlan) throw refuse(400, 'plan_required', 'Choose a plan first.');
    const limit = currentLimit(current);
    const endDate = String(current.endDate);
    if (targetPlan.branchCount <= limit) {
      throw refuse(
        409,
        'bank_plan_active',
        `Your plan is paid by bank transfer until ${displayDate(endDate)} (${unusedDays} paid ${unusedDays === 1 ? 'day' : 'days'} left). ` +
          `In the app you can only move to a plan with more than ${branches(limit)}. ` +
          'To renew or keep this plan, pay by bank transfer in the GymsEra CMS.',
        {
          action: 'blocked',
          mechanism: 'blocked',
          reason: 'bank_plan_active',
          unusedDays,
          endDate,
          currentBranchCount: limit,
          appAccountToken: tenantId,
        }
      );
    }
    warning = {
      code: 'bank_days_lost',
      unusedDays,
      endDate,
      title: 'Unused bank-transfer days will be lost',
      message:
        `Your bank-transfer plan has ${unusedDays} unused paid ${unusedDays === 1 ? 'day' : 'days'} left (until ${displayDate(endDate)}). ` +
        `Buying this plan in the app replaces it today, and those ${days(unusedDays)} are not refunded or carried over.`,
    };
  }

  // Same-store tier change (BILL-03), unchanged.
  let mechanism = 'upgrade';
  let replacementMode = null;
  if (targetPlan && current.branchCount) {
    if (targetPlan.branchCount > current.branchCount) {
      replacementMode = target === 'ANDROID' ? 'IMMEDIATE_WITH_TIME_PRORATION' : null;
    } else if (targetPlan.branchCount < current.branchCount) {
      mechanism = 'downgrade';
      replacementMode = target === 'ANDROID' ? 'DEFERRED' : null;
    } else {
      mechanism = 'same_tier';
    }
  }
  return { ...base, action: mechanism, mechanism, replacementMode, warning, requiresConfirmation: !!warning };
};

module.exports = { evaluate, paidBankDaysLeft };
