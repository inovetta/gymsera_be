/**
 * Approvable commands for the Members module.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/**
 * members.create — walk-in enrolment.
 *
 * The action behind your "add member directly, or it goes to the host" toggle.
 * Front Desk holds `members.create` only, so this runs on approval; a Branch Admin
 * also holds `members.create.direct`, so it runs immediately. Identical code path.
 */
register({
  actionKey: 'members.create',

  summarize: (payload) => {
    const name = payload.fullName || payload.name || payload.email || 'New member';
    return payload.planName ? `${name} — ${payload.planName}` : String(name);
  },

  validate: async (ctx, payload) => {
    if (!payload || (!payload.email && !payload.phone)) {
      throw createError('A member needs at least an email address or a phone number', 400);
    }
    if (!ctx.branchId) {
      throw createError('A branch is required to enrol a member', 400);
    }

    // Re-checked at approval time: the plan may have been archived between the
    // request and the decision.
    if (payload.membershipPlanId) {
      const { MembershipPlan } = ctx.tenantDb.models;
      const plan = await MembershipPlan.findByPk(payload.membershipPlanId);
      if (!plan) throw createError('That membership plan no longer exists', 409);
      if (plan.isDeactivated) throw createError('That membership plan has been archived', 409);
    }
  },

  execute: async (ctx, payload) => {
    const gymService = require('../gym.service');
    // The enrolling identity is the approver on the approval path and the actor on
    // the direct path; either way it is someone who holds the permission.
    return gymService.enrollMember(ctx.tenantDb, ctx.tenantId, payload, {
      role: 'GYM_HOST',
      id: ctx.userId,
    });
  },
});
