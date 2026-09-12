/**
 * Approvable commands for the Schedule module.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/**
 * schedule.class.create.
 */
register({
  actionKey: 'schedule.class.create',

  summarize: (payload) => {
    const parts = [payload.name || 'Class'];
    if (payload.day) parts.push(payload.day);
    if (payload.time) parts.push(payload.time);
    return parts.join(' — ');
  },

  validate: async (ctx, payload) => {
    if (!payload || !payload.name || !payload.instructor || !payload.time || !payload.day) {
      throw createError('A class needs a name, an instructor, a time and a day', 400);
    }
    if (!ctx.branchId) {
      throw createError('A branch is required to schedule a class', 400);
    }
  },

  execute: async (ctx, payload) => {
    const { ClassSchedule } = ctx.tenantDb.models;
    return ClassSchedule.create({
      branchId: ctx.branchId,
      name: payload.name,
      instructor: payload.instructor,
      time: payload.time,
      day: payload.day,
      maxCapacity: payload.maxCapacity || 20,
      currentCapacity: 0,
    });
  },
});
