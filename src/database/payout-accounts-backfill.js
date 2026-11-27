/**
 * P7b (R-94): the data move of platform migration p027. Bank details saved before P7b live in
 * tenants.payment_details_json (one value per tenant; the API saved them there for whichever
 * organization the host was editing). They become that tenant's DEFAULT payout account
 * (payout_accounts row, business_id NULL (R-120: organization_id until p033), provider BANK_TRANSFER), keeping the old
 * payment_details_updated_at so a SEC-13 cooling period in progress is not restarted or lost. The
 * timestamp is copied as text ('YYYY-MM-DD HH:MM:SS'), never through a JS Date, so the server's
 * time zone cannot shift it.
 *
 * planPayoutAccountBackfill is read-only (SELECTs only): the preview script prints it, and p027
 * applies exactly that plan. A tenant that already has a default row is never overwritten, so a
 * re-run copies nothing twice. tenants.payment_details_json is left in place (not cleared) for
 * rollback; the code no longer reads or writes it.
 */
const crypto = require('crypto');
const { QueryTypes } = require('sequelize');

// R-120 NEW-307 (p034): `tenants` was renamed `organizations`; this runs inside p027, before p034, on a database that may have either.
const ORG_TABLE_CANDIDATES = ['organizations', 'tenants'];
const TENANT_SCOPE = 'ORGANIZATION'; // R-120 NEW-307 (p034): was 'TENANT'
const PROVIDER = 'BANK_TRANSFER';

const _hasTable = async (sequelize, table) =>
  (
    await sequelize.query(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
      { replacements: [table], type: QueryTypes.SELECT }
    )
  ).length > 0;

// R-120 NEW-309: the organization column of payout_accounts is tenant_id until p035 and organization_id after it (a database
// built from the models has the new name before this p027 backfill runs).
const _orgColumn = async (sequelize) => ((await _hasColumn(sequelize, 'payout_accounts', 'tenant_id')) ? 'tenant_id' : 'organization_id');

const _hasColumn = async (sequelize, table, column) =>
  (
    await sequelize.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
      { replacements: [table, column], type: QueryTypes.SELECT }
    )
  ).length > 0;

/** MySQL JSON comes back as a string or an object depending on the driver path. */
const _parse = (value) => {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined; // not JSON: reported, never copied
  }
};

/** True when at least one value is non-blank text or a number. */
const _hasContent = (obj) =>
  !!obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.values(obj).some((v) => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number');

/**
 * @returns {Promise<{ copy: Array<{ organizationId, detailsJson, detailsUpdatedAt, keys: string[] }>,
 *   alreadyHaveDefault: string[], emptyOrUnreadable: Array<{ organizationId, reason }>, tenantsScanned: number }>}
 */
const planPayoutAccountBackfill = async (sequelize) => {
  const plan = { copy: [], alreadyHaveDefault: [], emptyOrUnreadable: [], tenantsScanned: 0 };
  let ORG_TABLE = null;
  for (const name of ORG_TABLE_CANDIDATES) if (await _hasTable(sequelize, name)) { ORG_TABLE = name; break; }
  if (!ORG_TABLE) return plan;
  if (!(await _hasTable(sequelize, ORG_TABLE)) || !(await _hasColumn(sequelize, ORG_TABLE, 'payment_details_json'))) return plan;
  const hasUpdatedAt = await _hasColumn(sequelize, ORG_TABLE, 'payment_details_updated_at');

  const rows = await sequelize.query(
    `SELECT id, payment_details_json AS details${hasUpdatedAt ? ', DATE_FORMAT(payment_details_updated_at, \'%Y-%m-%d %H:%i:%s\') AS updatedAt' : ''}
       FROM ${ORG_TABLE} WHERE payment_details_json IS NOT NULL ORDER BY id`,
    { type: QueryTypes.SELECT }
  );
  plan.tenantsScanned = rows.length;

  const existing = new Set();
  if (await _hasTable(sequelize, 'payout_accounts')) {
    const have = await sequelize.query(
      `SELECT ${await _orgColumn(sequelize)} AS organizationId FROM payout_accounts WHERE scope_key = ? AND provider = ?`,
      { replacements: [TENANT_SCOPE, PROVIDER], type: QueryTypes.SELECT }
    );
    have.forEach((r) => existing.add(r.organizationId));
  }

  for (const row of rows) {
    const details = _parse(row.details);
    if (details === undefined) {
      plan.emptyOrUnreadable.push({ organizationId: row.id, reason: 'not valid JSON' });
    } else if (!_hasContent(details)) {
      plan.emptyOrUnreadable.push({ organizationId: row.id, reason: 'no bank or wallet value' });
    } else if (existing.has(row.id)) {
      plan.alreadyHaveDefault.push(row.id);
    } else {
      plan.copy.push({ organizationId: row.id, detailsJson: details, detailsUpdatedAt: row.updatedAt || null, keys: Object.keys(details).sort() });
    }
  }
  return plan;
};

/** Inserts the plan's rows (only called by p027 after the table exists). Returns the count. */
const applyPayoutAccountBackfill = async (sequelize, plan) => {
  for (const item of plan.copy) {
    await sequelize.query(
      `INSERT IGNORE INTO payout_accounts
         (id, ${await _orgColumn(sequelize)}, business_id, scope_key, provider, status, details_json, details_updated_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'ACTIVE', ?, ?, NOW(), NOW())`,
      { replacements: [crypto.randomUUID(), item.organizationId, TENANT_SCOPE, PROVIDER, JSON.stringify(item.detailsJson), item.detailsUpdatedAt] }
    );
  }
  return plan.copy.length;
};

module.exports = { planPayoutAccountBackfill, applyPayoutAccountBackfill };
