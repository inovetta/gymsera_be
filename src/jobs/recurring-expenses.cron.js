const TenantDbManager = require('../database/TenantDbManager');
const { Tenant } = require('../models/platform');
const { computeBusinessDate } = require('../services/ledger.service');
const { addPlanDuration, DEFAULT_TIMEZONE } = require('../utils/business-date.utils');

/**
 * Process recurring expenses for a single tenant.
 */
const processTenantRecurringExpenses = async (tenantId, tenantDb) => {
  const { Expense } = tenantDb.models;
  if (!Expense) return;

  // GLB-01: each template runs on its own branch's business date, not the server's UTC date.
  const { Branch } = tenantDb.models;
  const branches = Branch ? await Branch.findAll({ attributes: ['id', 'timezone'] }) : [];
  const tzByBranch = new Map(branches.map((b) => [b.id, b.timezone || DEFAULT_TIMEZONE]));

  // Find all active recurring expense templates
  const templates = await Expense.findAll({
    where: { isRecurring: true, status: 'approved' },
  });

  for (const template of templates) {
    const todayStr = computeBusinessDate(new Date(), tzByBranch.get(template.branchId));
    if (template.recurrenceEndDate && template.recurrenceEndDate < todayStr) continue;

    // Find the latest generated instance for this template (or fallback to template itself)
    const latestInstance = await Expense.findOne({
      where: { recurringTemplateId: template.id },
      order: [['expenseDate', 'DESC']],
    });

    const lastDateStr = latestInstance
      ? latestInstance.expenseDate
      : template.expenseDate;
    const freq = (template.recurrenceFrequency || 'monthly').toLowerCase();
    const nextDueDateStr = freq === 'weekly'
      ? addPlanDuration(lastDateStr, 'WEEKLY', 1)
      : addPlanDuration(lastDateStr, freq === 'yearly' ? 'YEARLY' : 'MONTHLY', 1);

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
