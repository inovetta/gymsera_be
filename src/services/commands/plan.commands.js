/**
 * Approvable commands for the Plans module.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/**
 * plans.create.
 *
 * Mirrors the host's own POST /membership-plans exactly — same service call —
 * so a plan created through an approval has no way to diverge from one an
 * Org Admin creates directly.
 */
register({
  actionKey: 'plans.create',

  summarize: (payload) => {
    const price = payload.price != null ? `Rs ${payload.price}` : '';
    return [payload.name || 'Plan', price].filter(Boolean).join(' — ');
  },

  validate: async (ctx, payload) => {
    if (!payload || !payload.name || !payload.durationType || !payload.durationValue) {
      throw createError('A plan needs a name, a duration type and a duration value', 400);
    }
    if (payload.price == null || Number(payload.price) < 0) {
      throw createError('A plan needs a non-negative price', 400);
    }
    if (payload.branchId) {
      const { Branch } = ctx.tenantDb.models;
      const branch = await Branch.findOne({ where: { id: payload.branchId, status: 'ACTIVE' } });
      if (!branch) throw createError('That branch no longer exists or is inactive', 409);
    }
  },

  execute: async (ctx, payload) => {
    const membershipPlanService = require('../membership-plan.service');
    return membershipPlanService.createPlan(ctx.tenantDb, {
      ...payload,
      branchId: payload.branchId || ctx.branchId,
    });
  },
});
