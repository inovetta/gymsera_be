/**
 * Approvable commands for the Announcements module.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/**
 * announcements.create.
 *
 * v1 collapses "draft" and "publish" into one gated action, matching the one
 * screen the app actually has: there is no draft-list-then-publish flow today, so
 * modelling that distinction here would gate a UI that doesn't exist. A Front
 * Desk clerk holding only `announcements.create` sends a message for someone
 * else to approve before members see it; a Branch Admin holding `.direct` posts
 * immediately. `announcements.publish` stays in the catalogue, unwired, for the
 * day a real draft workflow is built — the same deliberate deferral as the
 * constraints engine.
 */
register({
  actionKey: 'announcements.create',

  summarize: (payload) => payload.title || 'Announcement',

  validate: async (ctx, payload) => {
    if (!payload || !payload.title || !payload.message) {
      throw createError('An announcement needs a title and a message', 400);
    }
    if (!ctx.branchId) {
      throw createError('A branch is required to post an announcement', 400);
    }
  },

  execute: async (ctx, payload) => {
    const { Announcement } = ctx.tenantDb.models;
    return Announcement.create({
      branchId: ctx.branchId,
      title: payload.title,
      message: payload.message,
      tag: payload.tag || 'SENT TO ALL MEMBERS',
      status: 'sent',
      createdBy: ctx.requestedBy || ctx.userId,
    });
  },
});
