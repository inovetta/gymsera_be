/**
 * Payout accounts (P7b, R-73, R-94): where a host's money goes, and the bank / wallet details a
 * traveller is shown at checkout. One store, platform table payout_accounts (PayoutAccount).
 *
 * Ownership: the TENANT (the business). A row with organizationId null is the tenant default; a
 * row with an organizationId is an override for that organization. Resolution for a branch:
 * the ACTIVE override of the branch's organization, else the ACTIVE tenant default, else null.
 * No per-branch accounts. The launch API reads and writes only the tenant default; overrides
 * exist in the schema and the resolver (tested) for a later screen.
 *
 * Provider: BANK_TRANSFER only (R-73: Stripe does not support Pakistan; a card provider is
 * added as a new provider value, never as card fields of our own, SEC-09).
 */
const { PayoutAccount, Tenant, User } = require('../models/platform');

const PROVIDER = PayoutAccount.PROVIDERS.BANK_TRANSFER;

/** The bank / wallet fields a BANK_TRANSFER account holds (same keys travellers are shown). */
const BANK_DETAIL_FIELDS = Object.freeze([
  'bankName', 'accountTitle', 'accountNumber', 'iban', 'branchCode',
  'jazzCashNumber', 'easyPaisaNumber', 'additionalInstructions',
]);

const toView = (row) =>
  row
    ? {
      id: row.id,
      scope: row.organizationId ? 'ORGANIZATION' : 'TENANT',
      organizationId: row.organizationId || null,
      provider: row.provider,
      status: row.status,
      details: row.detailsJson || null,
      detailsUpdatedAt: row.detailsUpdatedAt || null,
    }
    : null;

const _find = (tenantId, organizationId, { transaction } = {}) =>
  PayoutAccount.findOne({
    where: {
      tenantId,
      scopeKey: PayoutAccount.scopeKeyFor(organizationId),
      provider: PROVIDER,
      status: PayoutAccount.STATUSES.ACTIVE,
    },
    transaction,
  });

/** The tenant default (organizationId null), or null. */
const getTenantDefault = async (tenantId) => toView(await _find(tenantId, null));

/**
 * The account for an organization: its own ACTIVE override, else the tenant default.
 * `organizationId` null → the tenant default. Rows are always looked up under `tenantId`, so an
 * organization id of another tenant can never select that tenant's account.
 */
const resolve = async ({ tenantId, organizationId = null }) => {
  if (!tenantId) return null;
  if (organizationId) {
    const override = await _find(tenantId, organizationId);
    if (override) return toView(override);
  }
  return toView(await _find(tenantId, null));
};

/** The account for a branch (through its organization); branchId null → the tenant default. */
const resolveForBranch = async (tenantDb, tenantId, branchId) => {
  if (!branchId) return resolve({ tenantId });
  const branch = await tenantDb.models.Branch.findByPk(branchId, { attributes: ['id', 'gymListingId'] });
  return resolve({ tenantId, organizationId: branch ? branch.gymListingId : null });
};

/** SEC-13: alert the owner (in-app, push, e-mail) that payout details changed. Never throws. */
const _notifyOwner = async (tenantId) => {
  try {
    const tenantRecord = await Tenant.findByPk(tenantId, { attributes: ['ownerUserId', 'gymName'] });
    if (!tenantRecord || !tenantRecord.ownerUserId) return;
    const ownerUser = await User.findByPk(tenantRecord.ownerUserId, { attributes: ['id', 'email', 'fullName'] });
    if (!ownerUser) return;
    const pushService = require('./push.service');
    const notificationsService = require('./notifications.service');
    const emailService = require('./email.service');

    const alertTitle = 'Security Alert: Payout Account Changed';
    const alertMsg = `Bank payout details for ${tenantRecord.gymName || 'your gym'} were updated. A 24-hour cooling period is in effect. If this wasn't you, contact support immediately.`;

    await notificationsService.createNotification({
      userId: ownerUser.id,
      tenantId,
      title: alertTitle,
      body: alertMsg,
      type: 'SECURITY_ALERT',
      data: { event: 'payout_details_changed' },
    }).catch((e) => console.warn('[SEC-13] Notification error:', e.message));

    await pushService.sendToUser(ownerUser.id, alertTitle, alertMsg, { type: 'SECURITY_ALERT' })
      .catch((e) => console.warn('[SEC-13] Push error:', e.message));

    if (ownerUser.email) {
      await emailService.sendMail({
        to: ownerUser.email,
        subject: 'GymsEra Security Alert: Payout Bank Details Updated',
        text: `Hi ${ownerUser.fullName || 'Gym Owner'},\n\n${alertMsg}\n\nGymsEra Security Team`,
        html: `<p>Hi <strong>${ownerUser.fullName || 'Gym Owner'}</strong>,</p><p>${alertMsg}</p><p>GymsEra Security Team</p>`,
      }).catch((e) => console.warn('[SEC-13] Email error:', e.message));
    }
  } catch (notifErr) {
    console.warn('[SEC-13] Failed to notify owner about bank details update:', notifErr.message);
  }
};

/**
 * Saves the tenant default (insert or replace; one row per tenant), stamps detailsUpdatedAt (the
 * SEC-13 cooling period starts) and alerts the owner. The caller has already checked the
 * permission and the re-authentication.
 */
const saveTenantDefault = async (tenantId, details) => {
  const now = new Date();
  const existing = await PayoutAccount.findOne({
    where: { tenantId, scopeKey: PayoutAccount.scopeKeyFor(null), provider: PROVIDER },
  });
  let row;
  if (existing) {
    row = await existing.update({ detailsJson: details, detailsUpdatedAt: now, status: PayoutAccount.STATUSES.ACTIVE });
  } else {
    row = await PayoutAccount.create({ tenantId, organizationId: null, provider: PROVIDER, detailsJson: details, detailsUpdatedAt: now });
  }
  await _notifyOwner(tenantId);
  return toView(row);
};

/** Account deletion (AUTH-07): every payout account of the tenant goes with it. */
const deleteAllForTenant = (tenantId, { transaction } = {}) =>
  PayoutAccount.destroy({ where: { tenantId }, transaction });

module.exports = {
  BANK_DETAIL_FIELDS,
  getTenantDefault,
  resolve,
  resolveForBranch,
  saveTenantDefault,
  deleteAllForTenant,
};
