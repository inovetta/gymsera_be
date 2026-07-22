const { Op } = require('sequelize');
const { createError, sendSuccess } = require('../utils/response.utils');
const { ensureDefaultCategories } = require('../services/expense-category.service');
const notificationsService = require('../services/notifications.service');
const { Tenant, User } = require('../models/platform');

/**
 * GET /host/expense-categories
 * Global system categories + host custom categories
 */
const listExpenseCategories = async (req, res, next) => {
  try {
    await ensureDefaultCategories(req.tenantDb);
    const { ExpenseCategory } = req.tenantDb.models;

    const categories = await ExpenseCategory.findAll({
      order: [['isSystem', 'DESC'], ['name', 'ASC']],
    });

    return sendSuccess(res, categories, 'Expense categories retrieved');
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/expense-categories
 * Create custom category for host's organization
 */
const createExpenseCategory = async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      throw createError('Category name is required', 400);
    }

    await ensureDefaultCategories(req.tenantDb);
    const { ExpenseCategory } = req.tenantDb.models;

    // Check if category already exists
    const existing = await ExpenseCategory.findOne({
      where: { name: name.trim() },
    });
    if (existing) {
      return sendSuccess(res, existing, 'Category already exists', 200);
    }

    const category = await ExpenseCategory.create({
      name: name.trim(),
      isSystem: false,
      gymId: req.user.gymId || null,
    });

    return sendSuccess(res, category, 'Expense category created', 201);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /host/branches/:branchId/expenses
 */
const listExpenses = async (req, res, next) => {
  try {
    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;
    if (!isHost) {
      throw createError('Access denied: Expense list and financial data are host-only.', 403);
    }

    const { branchId } = req.params;
    const { category, from, to, status, page = 1, limit = 20 } = req.query;
    const { Expense, ExpenseCategory } = req.tenantDb.models;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const offset = (pageNum - 1) * limitNum;

    const where = { branchId };

    if (category) {
      where.categoryId = category;
    }

    if (status) {
      where.status = status;
    }

    if (from && to) {
      where.expenseDate = { [Op.between]: [from, to] };
    } else if (from) {
      where.expenseDate = { [Op.gte]: from };
    } else if (to) {
      where.expenseDate = { [Op.lte]: to };
    }

    const { count, rows } = await Expense.findAndCountAll({
      where,
      include: [
        {
          model: ExpenseCategory,
          as: 'category',
          attributes: ['id', 'name', 'isSystem'],
        },
      ],
      order: [
        ['expenseDate', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      limit: limitNum,
      offset,
    });

    return sendSuccess(
      res,
      {
        expenses: rows,
        total: count,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(count / limitNum),
      },
      'Expenses retrieved successfully'
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /host/branches/:branchId/expenses
 */
const createExpense = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const {
      categoryId,
      title,
      amount,
      expenseDate,
      paymentMethod = 'cash',
      vendorName,
      notes,
      receiptUrl,
      isRecurring = false,
      recurrenceFrequency,
      recurrenceEndDate,
    } = req.body;

    if (!categoryId || !title || !amount || !expenseDate) {
      throw createError('Category, title, amount, and date are required', 400);
    }

    const { Branch, Expense, ExpenseCategory, GymStaff, StaffActionRequest } =
      req.tenantDb.models;

    const branch = await Branch.findByPk(branchId);
    if (!branch) {
      throw createError('Branch not found', 404);
    }

    const category = await ExpenseCategory.findByPk(categoryId);
    if (!category) {
      throw createError('Expense category not found', 404);
    }

    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;

    // If caller is HOST: Create direct Expense row in DB
    if (isHost) {
      const expense = await Expense.create({
        branchId,
        categoryId,
        title: title.trim(),
        amount: parseFloat(amount),
        expenseDate,
        paymentMethod,
        vendorName: vendorName ? vendorName.trim() : null,
        notes: notes ? notes.trim() : null,
        receiptUrl: receiptUrl || null,
        isRecurring: Boolean(isRecurring),
        recurrenceFrequency: isRecurring ? recurrenceFrequency : null,
        recurrenceEndDate: isRecurring ? recurrenceEndDate || null : null,
        status: 'approved',
        createdBy: req.user.id,
        reviewedBy: req.user.id,
      });

      const reloaded = await Expense.findByPk(expense.id, {
        include: [{ model: ExpenseCategory, as: 'category' }],
      });

      return sendSuccess(res, reloaded, 'Expense created successfully', 201);
    }

    // If caller is STAFF: Create StaffActionRequest ONLY (No Expense row created yet!)
    const staffMember = await GymStaff.findOne({
      where: { branchId, userId: req.user.id, status: 'active' },
    });

    if (!staffMember) {
      throw createError('Access denied: You are not active staff at this branch', 403);
    }

    const payload = {
      branchId,
      categoryId,
      categoryName: category.name,
      title: title.trim(),
      amount: parseFloat(amount),
      expenseDate,
      paymentMethod,
      vendorName: vendorName ? vendorName.trim() : null,
      notes: notes ? notes.trim() : null,
      receiptUrl: receiptUrl || null,
      isRecurring: Boolean(isRecurring),
      recurrenceFrequency: isRecurring ? recurrenceFrequency : null,
      recurrenceEndDate: isRecurring ? recurrenceEndDate || null : null,
    };

    const staffAction = await StaffActionRequest.create({
      staffId: staffMember.id,
      branchId,
      actionType: 'submit_expense',
      payloadJson: payload,
      status: 'pending',
      requestedAt: new Date(),
    });

    // Notify Host owner
    try {
      const { Tenant } = require('../models/platform');
      const notificationsService = require('../services/notifications.service');
      const tenant = await Tenant.findByPk(branch.tenantId || req.user.tenantId);
      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'staff_action_requested',
          title: 'Pending Staff Expense Approval',
          message: `${req.user.fullName || 'Staff'} submitted an expense: ${title.trim()} — Rs ${parseFloat(amount)} — needs your approval.`,
          priority: 'normal',
          deepLink: `/host/gyms/${branchId}/staff-requests`,
          metadataJson: {
            requestId: staffAction.id,
            branchId,
            tenantId: tenant.id,
          },
        });
      }
    } catch (notifErr) {
      console.warn('[CreateExpense Notification Warning]', notifErr.message);
    }

    return sendSuccess(
      res,
      { request: staffAction, pending: true },
      'Expense submitted for host approval',
      201
    );
  } catch (err) {
    next(err);
  }
};

/**
 * GET /host/branches/:branchId/expenses/:expenseId
 */
const getExpenseDetail = async (req, res, next) => {
  try {
    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;
    if (!isHost) {
      throw createError('Access denied: Expense details are host-only.', 403);
    }

    const { branchId, expenseId } = req.params;
    const { Expense, ExpenseCategory } = req.tenantDb.models;

    const expense = await Expense.findOne({
      where: { id: expenseId, branchId },
      include: [
        { model: ExpenseCategory, as: 'category' },
        { model: Expense, as: 'generatedInstances' },
      ],
    });

    if (!expense) {
      throw createError('Expense not found', 404);
    }

    return sendSuccess(res, expense, 'Expense details retrieved');
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /host/branches/:branchId/expenses/:expenseId
 */
const updateExpense = async (req, res, next) => {
  try {
    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;
    if (!isHost) {
      throw createError('Access denied: Modifying expenses is host-only.', 403);
    }

    const { branchId, expenseId } = req.params;
    const { updateSeries = false } = req.query;
    const {
      categoryId,
      title,
      amount,
      expenseDate,
      paymentMethod,
      vendorName,
      notes,
      receiptUrl,
      isRecurring,
      recurrenceFrequency,
      recurrenceEndDate,
    } = req.body;

    const { Expense, ExpenseCategory } = req.tenantDb.models;

    const expense = await Expense.findOne({
      where: { id: expenseId, branchId },
    });

    if (!expense) {
      throw createError('Expense not found', 404);
    }

    const updates = {};
    if (categoryId !== undefined) updates.categoryId = categoryId;
    if (title !== undefined) updates.title = title.trim();
    if (amount !== undefined) updates.amount = parseFloat(amount);
    if (expenseDate !== undefined) updates.expenseDate = expenseDate;
    if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
    if (vendorName !== undefined) updates.vendorName = vendorName ? vendorName.trim() : null;
    if (notes !== undefined) updates.notes = notes ? notes.trim() : null;
    if (receiptUrl !== undefined) updates.receiptUrl = receiptUrl;
    if (isRecurring !== undefined) updates.isRecurring = Boolean(isRecurring);
    if (recurrenceFrequency !== undefined) updates.recurrenceFrequency = recurrenceFrequency;
    if (recurrenceEndDate !== undefined) updates.recurrenceEndDate = recurrenceEndDate;

    await expense.update(updates);

    // If updateSeries is true, update the template and all linked generated rows
    const shouldUpdateSeries =
      updateSeries === true ||
      updateSeries === 'true' ||
      updateSeries === '1';

    if (shouldUpdateSeries) {
      const templateId = expense.recurringTemplateId || expense.id;
      const seriesUpdates = {};
      if (categoryId !== undefined) seriesUpdates.categoryId = categoryId;
      if (title !== undefined) seriesUpdates.title = title.trim();
      if (amount !== undefined) seriesUpdates.amount = parseFloat(amount);
      if (paymentMethod !== undefined) seriesUpdates.paymentMethod = paymentMethod;
      if (vendorName !== undefined) seriesUpdates.vendorName = vendorName ? vendorName.trim() : null;

      await Expense.update(seriesUpdates, {
        where: {
          [Op.or]: [
            { id: templateId },
            { recurringTemplateId: templateId },
          ],
          branchId,
        },
      });
    }

    const reloaded = await Expense.findByPk(expense.id, {
      include: [{ model: ExpenseCategory, as: 'category' }],
    });

    return sendSuccess(res, reloaded, 'Expense updated successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /host/branches/:branchId/expenses/:expenseId
 */
const deleteExpense = async (req, res, next) => {
  try {
    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;
    if (!isHost) {
      throw createError('Access denied: Deleting expenses is host-only.', 403);
    }

    const { branchId, expenseId } = req.params;
    const { deleteSeries = false } = req.query;
    const { Expense } = req.tenantDb.models;

    const expense = await Expense.findOne({
      where: { id: expenseId, branchId },
    });

    if (!expense) {
      throw createError('Expense not found', 404);
    }

    const shouldDeleteSeries =
      deleteSeries === true ||
      deleteSeries === 'true' ||
      deleteSeries === '1';

    if (shouldDeleteSeries && (expense.isRecurring || expense.recurringTemplateId)) {
      const templateId = expense.recurringTemplateId || expense.id;
      await Expense.destroy({
        where: {
          [Op.or]: [
            { id: templateId },
            { recurringTemplateId: templateId },
          ],
          branchId,
        },
      });
    } else {
      await expense.destroy();
    }

    return sendSuccess(res, null, 'Expense deleted successfully');
  } catch (err) {
    next(err);
  }
};

/**
 * GET /host/branches/:branchId/expenses/summary
 */
const getExpenseSummary = async (req, res, next) => {
  try {
    const isHost = req.user.role === 'GYM_HOST' || req.user.isHost === true;
    if (!isHost) {
      throw createError('Access denied: Financial totals and summaries are host-only.', 403);
    }
    const { branchId } = req.params;
    const { from, to, period = 'month' } = req.query;
    const { Expense, ExpenseCategory, Payment } = req.tenantDb.models;

    let startDate, endDate;
    if (from && to) {
      startDate = new Date(from);
      endDate = new Date(to);
    } else {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const fromDateStr = startDate.toISOString().split('T')[0];
    const toDateStr = endDate.toISOString().split('T')[0];

    // Approved Total Expenses
    const expenseSum = await Expense.sum('amount', {
      where: {
        branchId,
        status: 'approved',
        expenseDate: { [Op.between]: [fromDateStr, toDateStr] },
      },
    });
    const totalExpenses = parseFloat(expenseSum || 0);

    // Gross Revenue for period
    const revenueSum = await Payment.sum('amount', {
      where: {
        branchId,
        status: 'COMPLETED',
        paidAt: { [Op.between]: [startDate, endDate] },
      },
    });
    const grossRevenue = parseFloat(revenueSum || 0);
    const netProfit = grossRevenue - totalExpenses;

    // Expenses breakdown by Category
    const categoryTotals = await Expense.findAll({
      attributes: [
        'categoryId',
        [Expense.sequelize.fn('SUM', Expense.sequelize.col('amount')), 'totalAmount'],
      ],
      where: {
        branchId,
        status: 'approved',
        expenseDate: { [Op.between]: [fromDateStr, toDateStr] },
      },
      group: ['categoryId'],
      include: [{ model: ExpenseCategory, as: 'category', attributes: ['name'] }],
    });

    const byCategory = categoryTotals.map((item) => ({
      categoryId: item.categoryId,
      categoryName: item.category ? item.category.name : 'Uncategorized',
      total: parseFloat(item.getDataValue('totalAmount') || 0),
    }));

    // Recurring templates
    const recurringUpcoming = await Expense.findAll({
      where: {
        branchId,
        isRecurring: true,
        status: 'approved',
      },
      include: [{ model: ExpenseCategory, as: 'category', attributes: ['name'] }],
    });

    return sendSuccess(res, {
      totalExpenses,
      grossRevenue,
      netProfit,
      byCategory,
      recurringUpcoming,
    }, 'Expense summary retrieved');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listExpenseCategories,
  createExpenseCategory,
  listExpenses,
  createExpense,
  getExpenseDetail,
  updateExpense,
  deleteExpense,
  getExpenseSummary,
};
