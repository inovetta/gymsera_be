-- NEW-127 — how was GYM-4814C134 made without tenant migrations, and is any other gym the same? READ-ONLY.
--
-- From the app folder that holds server.js and .env (no mysql client needed):
--   node src/scripts/run-sql-check.js docs/sql/new-127-tenant-history.sql
-- SELECTs only, over `tenants`, `tenant_subscriptions` and information_schema. No personal data.
-- Send the agent all four grids.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The tenant row: created, approved, last changed, provisioning record (FLOW-02, 2026-10-01:
--    NULL = approved by code older than that), deletion record.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.tenant_code,
  t.db_name,
  t.status,
  t.kyc_status,
  t.created_at,
  t.approved_at,
  t.updated_at,
  t.provisioning_state,
  t.provisioning_error,
  t.status_before_deletion,
  t.deletion_requested_at
FROM tenants t
WHERE t.tenant_code = 'GYM-4814C134';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Its database: when its tables were made. A first table before 2026-09-26 means it was
--    provisioned before the migration runner existed. capacity_outbox (v9), idempotency_records
--    (v11) and payouts (v12) are created by migrations or by the model sync of later code.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.tenant_code,
  COUNT(*) AS table_count,
  MIN(x.CREATE_TIME) AS first_table_created,
  MAX(x.CREATE_TIME) AS last_table_created,
  SUM(CASE WHEN x.TABLE_NAME = 'capacity_outbox' THEN 1 ELSE 0 END) AS has_capacity_outbox,
  SUM(CASE WHEN x.TABLE_NAME = 'idempotency_records' THEN 1 ELSE 0 END) AS has_idempotency_records,
  SUM(CASE WHEN x.TABLE_NAME = 'payouts' THEN 1 ELSE 0 END) AS has_payouts
FROM tenants t
JOIN information_schema.TABLES x ON x.TABLE_SCHEMA = t.db_name
WHERE t.tenant_code = 'GYM-4814C134'
GROUP BY t.tenant_code;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Its hosting subscriptions, oldest first. An expired row followed by a new one around
--    2026-10-24 points at "suspended at expiry, back to ACTIVE when renewed" (no migration step).
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  s.status,
  s.platform,
  s.payment_status,
  s.start_date,
  s.end_date,
  s.created_at,
  s.updated_at
FROM tenant_subscriptions s
JOIN tenants t ON t.id = s.tenant_id
WHERE t.tenant_code = 'GYM-4814C134'
ORDER BY s.created_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Any other gym with the same problem: every tenant with a database that was created or
--    approved on or after 2026-10-24, or that lacks schema_migrations or branches.currency
--    (any status). has_* = 1 and 1 is healthy.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  t.tenant_code,
  t.status,
  t.created_at,
  t.approved_at,
  t.provisioning_state,
  (SELECT COUNT(*) FROM information_schema.TABLES x
     WHERE x.TABLE_SCHEMA = t.db_name AND x.TABLE_NAME = 'schema_migrations') AS has_schema_migrations,
  (SELECT COUNT(*) FROM information_schema.COLUMNS c
     WHERE c.TABLE_SCHEMA = t.db_name AND c.TABLE_NAME = 'branches' AND c.COLUMN_NAME = 'currency') AS has_branches_currency
FROM tenants t
WHERE t.db_name IS NOT NULL
  AND (t.created_at >= '2026-10-24'
       OR t.approved_at >= '2026-10-24'
       OR NOT EXISTS (SELECT 1 FROM information_schema.TABLES x
                        WHERE x.TABLE_SCHEMA = t.db_name AND x.TABLE_NAME = 'schema_migrations')
       OR NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS c
                        WHERE c.TABLE_SCHEMA = t.db_name AND c.TABLE_NAME = 'branches' AND c.COLUMN_NAME = 'currency'))
ORDER BY t.approved_at DESC;
