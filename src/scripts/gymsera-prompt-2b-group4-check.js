/**
 * READ-ONLY check for data left behind by the defects fixed in Prompt 2B group 4
 * (NEW-39, FLOW-08, NEW-40, PAY-08). SELECT statements only — zero writes.
 * Works before or after tenant migrations 017/018 (it never reads their columns).
 * Prints ids, counts, amounts and dates only — no names, e-mails or phones.
 *
 * Per ACTIVE tenant:
 *  completedPaymentPendingSubscription  NEW-39: payment COMPLETED, membership still PENDING
 *  upgradeAppliedBeforePayment          FLOW-08: membership already on the "Upgrade to X"
 *                                       plan while that upgrade payment is not COMPLETED
 *                                       (host-approved staff upgrades also appear; check created_by)
 *  clientAmountDiffersFromInvoice       FLOW-08: member-started payment whose amount matches
 *                                       no invoice of its membership (client-sent amount)
 *  activeWithoutCompletedPayment        NEW-40: ACTIVE membership with no COMPLETED or
 *                                       STAFF_COLLECTED payment at all (free renewal candidates)
 *  stalePendingMemberPayments           PAY-08: member-started PENDING payment, no proof,
 *                                       older than MEMBER_PAYMENT_PENDING_TTL_HOURS (default 168)
 *  floatMoneyColumns                    FLOAT/DOUBLE money columns in the tenant schema
 *
 * Do not run against production without the owner. Usage:
 *   node src/scripts/gymsera-prompt-2b-group4-check.js
 */
require('dotenv').config();
const { QueryTypes } = require('sequelize');

const SAMPLE = 10;

const TENANT_CHECKS = {
  completedPaymentPendingSubscription: `
    SELECT p.id AS paymentId, p.reference_entity_id AS subscriptionId, p.amount, p.updated_at AS paymentUpdatedAt
    FROM payments p
    JOIN member_subscriptions s ON s.id = p.reference_entity_id
    WHERE p.payment_for = 'MEMBERSHIP' AND p.status = 'COMPLETED' AND s.status = 'PENDING'`,

  upgradeAppliedBeforePayment: `
    SELECT p.id AS paymentId, p.reference_entity_id AS subscriptionId, p.status AS paymentStatus,
           p.amount, p.created_by AS createdBy, p.created_at AS requestedAt
    FROM payments p
    JOIN member_subscriptions s ON s.id = p.reference_entity_id
    JOIN membership_plans mp ON mp.id = s.membership_plan_id
    WHERE p.notes = CONCAT('Upgrade to ', mp.name)
      AND p.status <> 'COMPLETED' AND p.status <> 'REFUNDED'`,

  clientAmountDiffersFromInvoice: `
    SELECT p.id AS paymentId, p.reference_entity_id AS subscriptionId, p.status AS paymentStatus, p.amount
    FROM payments p
    WHERE p.payment_for = 'MEMBERSHIP' AND p.created_by IS NULL AND p.reference_entity_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM invoices i WHERE i.reference_entity_id = p.reference_entity_id)
      AND NOT EXISTS (SELECT 1 FROM invoices i
                      WHERE i.reference_entity_id = p.reference_entity_id AND i.total_amount = p.amount)`,

  activeWithoutCompletedPayment: `
    SELECT s.id AS subscriptionId, s.start_date AS startDate, s.end_date AS endDate
    FROM member_subscriptions s
    WHERE s.status = 'ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM payments p
                      WHERE p.reference_entity_id = s.id AND p.status IN ('COMPLETED', 'STAFF_COLLECTED'))`,

  stalePendingMemberPayments: `
    SELECT p.id AS paymentId, p.reference_entity_id AS subscriptionId, p.amount, p.created_at AS createdAt
    FROM payments p
    WHERE p.status = 'PENDING' AND p.created_by IS NULL AND p.proof_url IS NULL
      AND p.created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL :ttlHours HOUR)`,

  floatMoneyColumns: `
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, DATA_TYPE AS dataType
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE IN ('float', 'double')
      AND (COLUMN_NAME LIKE '%amount%' OR COLUMN_NAME LIKE '%price%' OR COLUMN_NAME LIKE '%fee%'
           OR COLUMN_NAME LIKE '%total%' OR COLUMN_NAME LIKE '%balance%')`,
};

const ttlHours = () => {
  const n = Number(process.env.MEMBER_PAYMENT_PENDING_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 168;
};

async function discoverTenantDbs(platformSeq, logger) {
  const TenantDbManager = require('../database/TenantDbManager');
  const tenants = await platformSeq.query(
    'SELECT id, tenant_code, connection_string_encrypted FROM tenants WHERE status = \'ACTIVE\'',
    { type: QueryTypes.SELECT }
  );
  const out = [];
  for (const t of tenants) {
    if (!t.connection_string_encrypted || t.connection_string_encrypted === 'PENDING_PROVISIONING') continue;
    try {
      const db = await TenantDbManager.getConnection(t.id, t.connection_string_encrypted);
      out.push({ code: t.tenant_code, sequelize: db.sequelize });
    } catch (err) {
      logger(`[Tenant ${t.tenant_code}] could not connect: ${err.message}`);
    }
  }
  return out;
}

async function runGroup4Check(options = {}) {
  const logger = options.logger || console.log;
  const platformSeq = options.platformSeq || require('../database/platform').sequelize;
  await platformSeq.authenticate();

  const tenantDbs = options.tenantDbs || (await discoverTenantDbs(platformSeq, logger));
  const results = {};
  for (const name of Object.keys(TENANT_CHECKS)) results[name] = { count: 0, byTenant: [] };

  logger('=== Prompt 2B group 4 data check (READ-ONLY) ===');
  for (const tenant of tenantDbs) {
    for (const [name, sql] of Object.entries(TENANT_CHECKS)) {
      try {
        const rows = await tenant.sequelize.query(sql, {
          type: QueryTypes.SELECT,
          replacements: { ttlHours: ttlHours() },
        });
        if (rows.length > 0) {
          results[name].count += rows.length;
          results[name].byTenant.push({ tenantCode: tenant.code, count: rows.length, sample: rows.slice(0, SAMPLE) });
        }
      } catch (err) {
        logger(`[Tenant ${tenant.code}] ${name} failed: ${err.message}`);
      }
    }
  }

  for (const [name, r] of Object.entries(results)) {
    logger(`${name}: ${r.count}`);
    for (const t of r.byTenant) logger(`  ${t.tenantCode}: ${t.count} — ${JSON.stringify(t.sample)}`);
  }
  logger('Done. 0 writes performed.');
  return results;
}

if (require.main === module) {
  runGroup4Check()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[FATAL] group 4 check failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runGroup4Check, TENANT_CHECKS };
