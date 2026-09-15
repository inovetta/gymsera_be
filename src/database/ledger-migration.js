/**
 * Idempotent schema migration for the collection ledger — same shape and same
 * reasoning as rbac-migration.js: `sequelize.sync({ alter: true })` only runs in
 * development, so new tenant tables need an explicit, additive, safe-to-run-every-
 * connection path in production.
 *
 * Two tables. Deliberately not more:
 *  - ledger_days          one row per branch per business date, tracks OPEN/CLOSED
 *  - ledger_adjustments   append-only reconciliation entries against a ledger_day
 *
 * "Today's Ledger" is never a stored table — it's the `payments` table filtered by
 * branch_id + business_date, joined against these two. See ledger.service.js.
 */

const TABLES = {
  ledger_days: `
    CREATE TABLE IF NOT EXISTS ledger_days (
      id                     CHAR(36)     NOT NULL,
      branch_id              CHAR(36)     NOT NULL,
      business_date          DATE         NOT NULL,
      status                 ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
      opened_at              DATETIME     NOT NULL,
      closed_by              CHAR(36)     NULL,
      closed_at              DATETIME     NULL,
      closed_expected_total  DECIMAL(10,2) NULL,
      closed_verified_total  DECIMAL(10,2) NULL,
      created_at             DATETIME     NOT NULL,
      updated_at             DATETIME     NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY ld_branch_day_unique (branch_id, business_date),
      KEY ld_status (status),
      KEY ld_branch_status (branch_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  ledger_adjustments: `
    CREATE TABLE IF NOT EXISTS ledger_adjustments (
      id                  CHAR(36)     NOT NULL,
      ledger_day_id       CHAR(36)     NOT NULL,
      type                ENUM('DISCREPANCY_NOTE','VARIANCE_ADJUSTMENT','REVERSAL','MISSED_DAY_RECONCILIATION') NOT NULL,
      related_payment_id  CHAR(36)     NULL,
      amount              DECIMAL(10,2) NULL,
      reason              TEXT         NOT NULL,
      created_by          CHAR(36)     NOT NULL,
      created_at          DATETIME     NOT NULL,
      PRIMARY KEY (id),
      KEY la_ledger_day (ledger_day_id),
      KEY la_payment (related_payment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

/**
 * Create any ledger table missing from this tenant database. Never drops, never
 * alters an existing column. Failures are logged and swallowed per table.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {string} tenantId  for log context
 * @returns {Promise<string[]>} tables that were created or already present
 */
const ensureLedgerTables = async (sequelize, tenantId) => {
  const ready = [];
  for (const [table, ddl] of Object.entries(TABLES)) {
    try {
      await sequelize.query(ddl);
      ready.push(table);
    } catch (err) {
      console.warn(`[Ledger] tenant ${tenantId}: could not ensure ${table} — ${err.message}`);
    }
  }
  return ready;
};

module.exports = { ensureLedgerTables, TABLES };
