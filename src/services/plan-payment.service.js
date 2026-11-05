'use strict';

/**
 * Host plan payments outside the stores (Phase 7 P9c item D, decision R-95).
 *
 * The host (owner only) chooses a catalog plan and a cycle, sees how to pay (bank transfer: the
 * platform account, R-86), pays, uploads the receipt and submits. A platform admin checks the
 * money and approves — the plan is granted through applyVerifiedSubscription as a MANUAL row,
 * the one write path every plan uses, so the previous entitlement is superseded in the same
 * transaction and there is never a second active one — or rejects with a reason.
 *
 * Rules (R-95):
 *  - the server takes the amount, currency and duration from the catalog (cycleTerms);
 *  - while an Apple / Google (or card) plan entitles AND renews, the form is refused
 *    (409 store_plan_active): paying twice must not be possible. A store plan that ended, or was
 *    cancelled (auto-renew off), does not block;
 *  - one PENDING request at a time (409 plan_payment_pending);
 *  - on approval the new period starts at the end of a running PAID plan (no paid day lost),
 *    otherwise on the approval day; an unpaid plan (pay-later grace, an unpaid legacy package
 *    row) is not extended.
 */

const { Op } = require('sequelize');
const crypto = require('crypto');
const { PlanPaymentRequest, BillingPlan, Tenant, User, PlatformAuditLog } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');
const catalog = require('./billing-plan-catalog.service');
const methods = require('./plan-payment-methods');
const privateStore = require('./kyc-storage.service');

const STORE_PLATFORMS = ['IOS', 'ANDROID', 'STRIPE'];
const MANAGE_URLS = {
  IOS: 'https://apps.apple.com/account/subscriptions',
  ANDROID: 'https://play.google.com/store/account/subscriptions',
  STRIPE: 'https://gymsera.com/billing',
};
const STORE_NAMES = { IOS: 'Apple', ANDROID: 'Google Play', STRIPE: 'card' };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const err = (status, code, message, data) => {
  const e = createError(message, status);
  e.code = code;
  if (data) e.data = data;
  return e;
};

const isoDate = (d) => d.toISOString().split('T')[0];
const addMonths = (dateStr, months) => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); // 31 Jan + 1 month = 28/29 Feb, never 3 March
  return isoDate(d);
};

/** Why the bank-transfer form is refused now, or null. */
const storeBlock = async (tenantId) => {
  const current = await subscriptionQuotaService.getActiveSubscription(tenantId);
  if (current && STORE_PLATFORMS.includes(current.platform) && current.autoRenew !== false) {
    return {
      code: 'store_plan_active',
      platform: current.platform,
      manageUrl: MANAGE_URLS[current.platform],
      message:
        `Your plan is billed by ${STORE_NAMES[current.platform]} and renews automatically. ` +
        'Change or cancel it in the GymsEra app; bank transfer opens once that plan is cancelled or has ended.',
    };
  }
  return null;
};

const _plans = async () =>
  BillingPlan.findAll({ where: { isActive: true }, order: [['sortOrder', 'ASC'], ['branchCount', 'ASC']] });

/** What the host's Subscription & Billing page needs to offer the flow. */
const getOverview = async (tenantId) => {
  const [plans, requests, block] = await Promise.all([
    _plans(),
    PlanPaymentRequest.findAll({ where: { tenantId }, order: [['createdAt', 'DESC']], limit: 20 }),
    storeBlock(tenantId),
  ]);
  const pending = requests.find((r) => r.status === PlanPaymentRequest.STATUSES.PENDING) || null;
  const methodList = methods.listMethods().map((m) => {
    const instructions = m.instructions();
    return { key: m.key, label: m.label, requiresProof: m.requiresProof, available: !!instructions, instructions };
  });
  return {
    plans: plans.map((p) => ({
      id: p.id,
      branchCount: p.branchCount,
      currency: p.currency,
      cycles: Object.keys(catalog.CYCLE_TERMS).map((c) => catalog.cycleTerms(p, c)),
    })),
    methods: methodList,
    requests: requests.map((r) => r.toJSON()),
    pending: pending ? pending.toJSON() : null,
    blocked: block,
    canSubmit: !block && !pending && methodList.some((m) => m.available),
  };
};

const _ownerTenant = async (tenantId, userId) => {
  const tenant = tenantId ? await Tenant.findByPk(tenantId) : null;
  if (!tenant) throw err(404, 'tenant_not_found', 'Tenant not found');
  if (tenant.ownerUserId !== userId) throw err(403, 'owner_only', 'Only the owner of this business can pay for its plan.');
  return tenant;
};

const submit = async ({ tenantId, userId, billingPlanId, billingCycle, method = 'BANK_TRANSFER', payerReference = null, file = null }) => {
  const tenant = await _ownerTenant(tenantId, userId);
  if (tenant.status !== 'ACTIVE') throw err(409, 'tenant_not_active', 'Your business must be approved and active to pay for a plan here.');

  const m = methods.getMethod(method);
  if (!m) throw err(422, 'invalid_method', 'This payment method is not available.');
  const instructions = m.instructions();
  if (!instructions) throw err(409, 'method_unavailable', 'Bank transfer details are not available yet. Contact support.');

  const plan = billingPlanId ? await BillingPlan.findOne({ where: { id: billingPlanId, isActive: true } }) : null;
  if (!plan) throw err(422, 'invalid_plan', 'Choose a plan from the catalog.');
  const terms = catalog.cycleTerms(plan, billingCycle);
  if (!terms) throw err(422, 'invalid_cycle', 'Choose monthly or annual.');

  const block = await storeBlock(tenant.id);
  if (block) throw err(409, block.code, block.message, { platform: block.platform, manageUrl: block.manageUrl });

  const pending = await PlanPaymentRequest.findOne({ where: { tenantId: tenant.id, status: PlanPaymentRequest.STATUSES.PENDING } });
  if (pending) throw err(409, 'plan_payment_pending', 'A payment is already waiting for review.', { requestId: pending.id });

  if (m.requiresProof && !file) throw err(422, 'proof_required', 'Upload the transfer receipt.');

  const id = crypto.randomUUID();
  let proofKey = null;
  if (file) {
    proofKey = `tenants/${tenant.id}/plan-payment-proofs/${id}-${Date.now()}.${EXT[file.mimetype] || 'jpg'}`;
    await privateStore.putPrivateObject({ buffer: file.buffer, mimetype: file.mimetype, key: proofKey });
  }

  const request = await PlanPaymentRequest.create({
    id,
    tenantId: tenant.id,
    requestedByUserId: userId,
    billingPlanId: plan.id,
    branchCount: plan.branchCount,
    billingCycle,
    amount: terms.amount,
    currency: terms.currency,
    method: m.key,
    proofKey,
    payerReference: payerReference ? String(payerReference).slice(0, 100) : null,
  });
  await request.reload();

  // Platform admins are told there is a payment to check (same feed as new applications).
  try {
    const notificationsService = require('./notifications.service');
    const admins = await User.findAll({ where: { role: 'PLATFORM_ADMIN' }, attributes: ['id'] });
    for (const admin of admins) {
      await notificationsService.createNotification({
        userId: admin.id,
        role: 'admin',
        type: 'plan_payment_submitted',
        title: 'Plan payment to check',
        message: `${tenant.businessName || 'A host'} sent a bank transfer for a ${plan.branchCount}-branch plan (${billingCycle.toLowerCase()}).`,
        deepLink: '/admin/plan-payments',
        metadataJson: { tenantId: tenant.id, requestId: request.id },
      });
    }
  } catch (notifyErr) {
    console.warn('[PlanPayment] admin notification failed:', notifyErr.message);
  }
  return request;
};

const listForAdmin = async ({ status = null, tenantId = null } = {}) => {
  const where = {};
  if (status) where.status = status;
  if (tenantId) where.tenantId = tenantId;
  const rows = await PlanPaymentRequest.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  const tenants = await Tenant.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map((r) => r.tenantId))] } },
    attributes: ['id', 'businessName', 'gymName'],
  });
  const names = new Map(tenants.map((t) => [t.id, t.businessName || t.gymName || null]));
  return rows.map((r) => ({ ...r.toJSON(), tenantName: names.get(r.tenantId) || null }));
};

const _pendingOr409 = async (requestId) => {
  const request = await PlanPaymentRequest.findByPk(requestId);
  if (!request) throw err(404, 'not_found', 'Payment request not found');
  if (request.status !== PlanPaymentRequest.STATUSES.PENDING) {
    throw err(409, 'plan_payment_not_pending', `This payment was already ${request.status.toLowerCase()}.`);
  }
  return request;
};

/** The period an approval grants (R-95): from the end of a running PAID plan, else from today. */
const periodFor = async (tenantId, months, today = isoDate(new Date())) => {
  const current = await subscriptionQuotaService.getActiveSubscription(tenantId);
  const paid = current && (current.paymentStatus === 'PAID' || STORE_PLATFORMS.includes(current.platform));
  const runningEnd = current?.endDate && String(current.endDate) > today ? String(current.endDate) : null;
  const base = paid && runningEnd ? runningEnd : today;
  return { start: today, extendedFrom: base === today ? null : base, end: addMonths(base, months) };
};

const approve = async ({ requestId, adminUserId }) => {
  const request = await _pendingOr409(requestId);
  const block = await storeBlock(request.tenantId);
  if (block) throw err(409, block.code, block.message, { platform: block.platform });

  const plan = await BillingPlan.findByPk(request.billingPlanId);
  const months = catalog.CYCLE_TERMS[request.billingCycle]?.months;
  if (!plan || !months) throw err(409, 'invalid_plan', 'The plan of this request no longer exists in the catalog.');
  const period = await periodFor(request.tenantId, months);

  // Claim the request first: a second admin approving at the same moment gets 409.
  const [claimed] = await PlanPaymentRequest.update(
    { status: PlanPaymentRequest.STATUSES.APPROVED, reviewedByUserId: adminUserId, reviewedAt: new Date(), periodStart: period.start, periodEnd: period.end },
    { where: { id: request.id, status: PlanPaymentRequest.STATUSES.PENDING } }
  );
  if (!claimed) throw err(409, 'plan_payment_not_pending', 'This payment was already reviewed.');

  try {
    const externalId = `plan-payment:${request.id}`;
    const subscription = await require('./subscription-migration.service').applyVerifiedSubscription(
      request.tenantId,
      {
        platform: 'MANUAL',
        externalOriginalTransactionId: externalId,
        externalTransactionId: externalId,
        billingPlanId: request.billingPlanId,
        branchCount: request.branchCount,
        productId: null,
        startDate: period.start,
        endDate: period.end,
        amount: request.amount,
        currency: request.currency,
        billingCycle: request.billingCycle,
        status: 'ACTIVE',
        autoRenew: false,
        paymentStatus: 'PAID',
        bankTransferRef: request.payerReference || null,
        lastVerifiedAt: new Date(),
      },
      { idempotencyPrefix: `${externalId}:approve`, logLabel: 'Plan payment' }
    );
    await PlanPaymentRequest.update({ tenantSubscriptionId: subscription.id }, { where: { id: request.id } });
    await PlatformAuditLog.create({
      actorUserId: adminUserId,
      action: 'PLAN_PAYMENT_APPROVED',
      targetType: 'PlanPaymentRequest',
      targetId: request.id,
      details: {
        tenantId: request.tenantId, tenantSubscriptionId: subscription.id, billingPlanId: request.billingPlanId,
        billingCycle: request.billingCycle, amount: String(request.amount), currency: request.currency,
        periodStart: period.start, periodEnd: period.end, extendedFrom: period.extendedFrom,
      },
      createdAt: new Date(),
    });
    return { request: await PlanPaymentRequest.findByPk(request.id), subscription };
  } catch (grantErr) {
    // Nothing was granted: the request goes back to PENDING so it can be approved again.
    await PlanPaymentRequest.update(
      { status: PlanPaymentRequest.STATUSES.PENDING, reviewedByUserId: null, reviewedAt: null, periodStart: null, periodEnd: null },
      { where: { id: request.id } }
    );
    throw grantErr;
  }
};

const reject = async ({ requestId, adminUserId, reason }) => {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3) throw err(422, 'reason_required', 'Tell the host why the payment was rejected.');
  const request = await _pendingOr409(requestId);
  const [done] = await PlanPaymentRequest.update(
    { status: PlanPaymentRequest.STATUSES.REJECTED, reviewedByUserId: adminUserId, reviewedAt: new Date(), rejectionReason: text.slice(0, 500) },
    { where: { id: request.id, status: PlanPaymentRequest.STATUSES.PENDING } }
  );
  if (!done) throw err(409, 'plan_payment_not_pending', 'This payment was already reviewed.');
  await PlatformAuditLog.create({
    actorUserId: adminUserId,
    action: 'PLAN_PAYMENT_REJECTED',
    targetType: 'PlanPaymentRequest',
    targetId: request.id,
    details: { tenantId: request.tenantId, reason: text.slice(0, 500) },
    createdAt: new Date(),
  });
  return PlanPaymentRequest.findByPk(request.id);
};

/** The receipt, for a platform admin (audited). */
const openProof = async ({ requestId, adminUserId }) => {
  const request = await PlanPaymentRequest.findByPk(requestId);
  if (!request) throw err(404, 'not_found', 'Payment request not found');
  if (!request.proofKey) throw err(404, 'proof_not_found', 'This payment has no receipt');
  await PlatformAuditLog.create({
    actorUserId: adminUserId,
    action: 'PLAN_PAYMENT_PROOF_ACCESSED',
    targetType: 'PlanPaymentRequest',
    targetId: request.id,
    details: { tenantId: request.tenantId },
    createdAt: new Date(),
  });
  const { stream } = await privateStore.getKycStream(request.proofKey);
  const ext = request.proofKey.split('.').pop();
  const contentType = Object.keys(EXT).find((k) => EXT[k] === ext) || 'application/octet-stream';
  return { stream, contentType };
};

module.exports = { getOverview, submit, listForAdmin, approve, reject, openProof, storeBlock, periodFor, addMonths };
