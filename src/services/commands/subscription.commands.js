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
    return subscriptionService.renew(payload.memberUserId, payload.subscriptionId, payload.planId || null, payload.startDate || null);
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
      ? subscriptionService.upgradeSubscription(payload.memberUserId, payload.subscriptionId, payload.newPlanId)
      : subscriptionService.changePlan(payload.memberUserId, payload.subscriptionId, payload.newPlanId);
  },
});
