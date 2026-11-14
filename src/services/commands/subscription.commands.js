/**
 * Approvable commands for the Subscriptions module.
 *
 * Each maps onto an existing subscription.service call, so the approval engine
 * gains nothing to maintain and loses no behaviour.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

const requireSubscription = async (ctx, payload) => {
  if (!payload || !payload.subscriptionId) {
    throw createError('A subscription is required', 400);
  }
  const { MemberSubscription } = ctx.tenantDb.models;
  const sub = await MemberSubscription.findByPk(payload.subscriptionId);
  if (!sub) throw createError('That subscription no longer exists', 409);
  return sub;
};

const requireLivePlan = async (ctx, planId) => {
  if (!planId) throw createError('A plan is required', 400);
  const { MembershipPlan } = ctx.tenantDb.models;
  const plan = await MembershipPlan.findByPk(planId);
  if (!plan) throw createError('That plan no longer exists', 409);
  if (plan.isDeactivated) throw createError('That plan has been archived', 409);
  return plan;
};

register({
  actionKey: 'subscriptions.create',
  summarize: (p) => `Renew — ${p.memberName || p.memberUserId || 'member'}`,
  validate: async (ctx, payload) => {
    await requireSubscription(ctx, payload);
  },
  execute: async (_ctx, payload) => {
    const subscriptionService = require('../subscription.service');
    // planId/startDate are optional — omitted, renew() extends the current plan
    // from the current end date, which is what a plain "Renew" action means.
    // Passed, it doubles as a renew-with-a-different-plan action, matching what
    // subscriptionService.renew already supports.
    // Approved (or DIRECT-tier) staff action: applies at once (NEW-40). Only a
    // member's own renewal waits for its payment.
    return subscriptionService.renew(payload.memberUserId, payload.subscriptionId, payload.planId || null, payload.startDate || null, { approvedByHost: true });
  },
});

register({
  actionKey: 'subscriptions.plan.change',
  summarize: (p) => `Change plan — ${p.memberName || p.memberUserId || 'member'}${p.newPlanName ? ` → ${p.newPlanName}` : ''}`,
  validate: async (ctx, payload) => {
    await requireSubscription(ctx, payload);
    await requireLivePlan(ctx, payload.newPlanId);
  },
  execute: async (_ctx, payload) => {
    const subscriptionService = require('../subscription.service');
    // `upgrade` is a plan change with proration; the caller says which it wants.
    return payload.isUpgrade
      // Approved (or DIRECT-tier) staff action: applies at once, like a
      // host-approved staff upgrade (FLOW-08). Only a member's own upgrade waits.
      ? subscriptionService.upgradeSubscription(payload.memberUserId, payload.subscriptionId, payload.newPlanId, { approvedByHost: true })
      : subscriptionService.changePlan(payload.memberUserId, payload.subscriptionId, payload.newPlanId);
  },
});

// NEW-250: staff freeze and cancel. Before these, the CMS and the app sent staff to the member
// routes /subscriptions/:id/freeze|cancel, which only find the caller's own subscription (NEW-08),
// so every staff Freeze / Cancel answered 404. The rules are the member routes' rules
// (assertFreezable / assertCancellable), checked here and again under the row lock.
const requireSubscriptionAtBranch = async (ctx, payload) => {
  const sub = await requireSubscription(ctx, payload);
  // The grants were resolved for ctx.branchId: the row must be at that branch.
  if (ctx.branchId && sub.branchId && sub.branchId !== ctx.branchId) {
    throw createError('That subscription belongs to another branch', 409);
  }
  return sub;
};

register({
  actionKey: 'subscriptions.pause',
  summarize: (p) => `Freeze — ${p.memberName || 'member'} (${p.freezeFrom} to ${p.freezeTo})`,
  validate: async (ctx, payload) => {
    if (!payload.freezeFrom || !payload.freezeTo) throw createError('freezeFrom and freezeTo are required', 400);
    const sub = await requireSubscriptionAtBranch(ctx, payload);
    const subscriptionService = require('../subscription.service');
    await subscriptionService.assertFreezable(ctx.tenantDb.models, sub, payload.freezeFrom, payload.freezeTo);
  },
  execute: async (ctx, payload) => {
    const subscriptionService = require('../subscription.service');
    return subscriptionService.staffFreeze(ctx.tenantDb, payload.subscriptionId, payload);
  },
});

register({
  actionKey: 'subscriptions.cancel',
  summarize: (p) => `Cancel subscription — ${p.memberName || 'member'}`,
  validate: async (ctx, payload) => {
    const sub = await requireSubscriptionAtBranch(ctx, payload);
    require('../subscription.service').assertCancellable(sub);
  },
  execute: async (ctx, payload) => {
    const subscriptionService = require('../subscription.service');
    return subscriptionService.staffCancel(ctx.tenantDb, payload.subscriptionId);
  },
});
