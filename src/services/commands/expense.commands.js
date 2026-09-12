/**
 * Approvable commands for the Expenses module.
 */
const { register } = require('./index');
const { createError } = require('../../utils/response.utils');

/**
 * expenses.create.
 *
 * The row is only written once the expense is permitted — either because the actor
 * holds `expenses.create.direct`, or because an approver decided it. Nothing is
 * persisted to `expenses` while a request is pending, so reports never count money
 * that has not been agreed.
 */
register({
  actionKey: 'expenses.create',

  summarize: (p) => {
    const amount = p.amount != null ? `Rs ${Number(p.amount).toLocaleString('en-PK')}` : '';
    return [p.title || 'Expense', amount].filter(Boolean).join(' — ');
  },

  validate: async (ctx, payload) => {
    if (!payload || !payload.title) throw createError('An expense needs a title', 400);
    if (payload.amount == null || Number(payload.amount) <= 0) {
      throw createError('An expense needs a positive amount', 400);
    }
    if (!ctx.branchId) throw createError('A branch is required to record an expense', 400);

    if (payload.categoryId) {
      const { ExpenseCategory } = ctx.tenantDb.models;
      const category = await ExpenseCategory.findByPk(payload.categoryId);
      if (!category) throw createError('That expense category no longer exists', 409);
    }
  },

  execute: async (ctx, payload) => {
    const { Expense } = ctx.tenantDb.models;
    return Expense.create({
      branchId: ctx.branchId,
      categoryId: payload.categoryId || null,
      title: payload.title,
      amount: payload.amount,
      expenseDate: payload.expenseDate || new Date(),
      paymentMethod: payload.paymentMethod || 'cash',
      vendorName: payload.vendorName || null,
      notes: payload.notes || null,
      receiptUrl: payload.receiptUrl || null,
      isRecurring: Boolean(payload.isRecurring),
      recurrenceFrequency: payload.recurrenceFrequency || null,
      recurrenceEndDate: payload.recurrenceEndDate || null,
      status: 'approved',
      // The requester owns the expense even when someone else approved it.
      createdBy: ctx.requestedBy || ctx.userId,
      reviewedBy: ctx.userId,
    });
  },
});
