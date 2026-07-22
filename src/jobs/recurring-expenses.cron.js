const { Op } = require('sequelize');
const TenantDbManager = require('../database/TenantDbManager');
const { Tenant } = require('../models/platform');

/**
 * Process recurring expenses for a single tenant.
 */
const processTenantRecurringExpenses = async (tenantId, tenantDb) => {
  const { Expense } = tenantDb.models;
  if (!Expense) return;

  const todayStr = new Date().toISOString().split('T')[0];
  const today = new Date(todayStr);

  // Find all active recurring expense templates
  const templates = await Expense.findAll({
    where: {
      isRecurring: true,
      status: 'approved',
      [Op.or]: [
        { recurrenceEndDate: null },
        { recurrenceEndDate: { [Op.gte]: todayStr } },
      ],
    },
  });

  for (const template of templates) {
    // Find the latest generated instance for this template (or fallback to template itself)
    const latestInstance = await Expense.findOne({
      where: { recurringTemplateId: template.id },
      order: [['expenseDate', 'DESC']],
    });

    const lastDateStr = latestInstance
      ? latestInstance.expenseDate
      : template.expenseDate;
    const lastDate = new Date(lastDateStr);

    let nextDueDate = new Date(lastDate);
    const freq = (template.recurrenceFrequency || 'monthly').toLowerCase();

    if (freq === 'weekly') {
      nextDueDate.setDate(nextDueDate.getDate() + 7);
    } else if (freq === 'yearly') {
      nextDueDate.setFullYear(nextDueDate.getFullYear() + 1);
    } else {
      // Monthly default
      nextDueDate.setMonth(nextDueDate.getMonth() + 1);
    }

    const nextDueDateStr = nextDueDate.toISOString().split('T')[0];

    // If today is on or past the next due date, generate the new expense instance
    if (todayStr >= nextDueDateStr) {
      await Expense.create({
        branchId: template.branchId,
        categoryId: template.categoryId,
        title: template.title,
        amount: template.amount,
        expenseDate: todayStr,
        paymentMethod: template.paymentMethod,
        vendorName: template.vendorName,
        notes: template.notes,
        receiptUrl: template.receiptUrl,
        isRecurring: false,
        recurringTemplateId: template.id,
        status: 'approved',
        createdBy: template.createdBy,
        reviewedBy: template.reviewedBy,
      });

      console.log(
        `[Recurring Expenses Cron] Generated instance for template "${template.title}" (${template.id}) in tenant ${tenantId}`
      );
    }
  }
};

/**
 * Process all active tenants.
 */
const runRecurringExpensesJob = async () => {
  try {
    const activeTenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
    });

    for (const tenant of activeTenants) {
      try {
        const tenantDb = await TenantDbManager.getConnection(
          tenant.id,
          tenant.connectionStringEncrypted
        );
        await processTenantRecurringExpenses(tenant.id, tenantDb);
      } catch (err) {
        console.error(
          `[Recurring Expenses Cron Error] Tenant ${tenant.id}:`,
          err.message
        );
      }
    }
  } catch (err) {
    console.error('[Recurring Expenses Cron Root Error]:', err.message);
  }
};

module.exports = {
  runRecurringExpensesJob,
  processTenantRecurringExpenses,
};
