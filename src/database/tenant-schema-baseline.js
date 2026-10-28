/**
 * Tenant schema baseline (NEW-127).
 *
 * A tenant database that has its tables but no `schema_migrations` (provisioned before the
 * runner existed, 2026-09-26, and never reached by a migration run) cannot be handed to
 * `runTenantMigrations`: with no record it would replay every migration from 001, including
 * the backfills and the collation conversion. This module looks at what the database
 * already has, migration by migration, read-only:
 *
 *   present   the migration's effect is already there: record it (baseline), run nothing
 *   missing   not there: run that migration's own `up` (the runner, unchanged)
 *   conflict  something is there in a shape the migration does not expect: refuse
 *
 * The repair also refuses when a table or column the models read is missing and no
 * missing migration adds it (NEW-126: those need a new migration first), and when the
 * database already has `schema_migrations` (that is the normal runner's job).
 *
 * Every probe is a pure function of one information_schema snapshot, plus three counts
 * for the data migrations (004, 005, 014). A test fails when a migration has no probe.
 */
const { QueryTypes } = require('sequelize');
const {
  MIGRATIONS, ensureMigrationTable, runTenantMigrations, missingTenantMigrations,
} = require('./tenant-migration-runner');

const CANONICAL_COLLATION = 'utf8mb4_unicode_ci';
const TEXT_TYPES = ['text', 'mediumtext', 'longtext'];
const INT_TYPES = ['int', 'smallint', 'tinyint', 'bigint', 'mediumint'];

// What each additive migration creates. Used by the probes and to tell a model gap that a
// pending migration will close from one that nothing closes.
const ADDS = {
  1: { tables: ['role_assignments', 'role_assignment_branches', 'assignment_overrides', 'approval_requests', 'approval_policies', 'audit_logs'] },
  2: { tables: ['ledger_days', 'ledger_adjustments'] },
  3: {
    columns: {
      member_subscriptions: ['created_by', 'created_by_role'],
      invoices: ['branch_id', 'created_by', 'created_by_role'],
      membership_plans: ['is_deactivated'],
      branches: ['gym_listing_id', 'timezone'],
      approval_requests: ['collected_by', 'collected_at', 'collection_method', 'collection_notes'],
      payments: ['business_date', 'idempotency_key', 'printed_at', 'printed_by'],
      gyms: ['gym_listing_id'],
    },
    indexes: { payments: ['payments_branch_business_date', 'payments_idempotency_unique'] },
  },
  8: { columns: { branches: ['admin_suspended', 'admin_suspended_reason', 'admin_suspended_at', 'admin_suspended_by'] } },
  9: { tables: ['capacity_outbox'] },
  10: { columns: { branches: ['billing_locked_at', 'billing_lock_reason'] } },
  11: { tables: ['idempotency_records'] },
  12: { tables: ['payouts'] },
  13: { columns: { role_assignments: ['version'] } },
  14: { tables: ['invoice_sequences'] },
  15: { columns: { gym_staff: ['invite_token_hash', 'token_expires_at'] } },
  16: { columns: { payments: ['shift'], ledger_days: ['closed_collectors_json'] } },
  17: { columns: { payments: ['pending_change_json'] } },
  18: { columns: { payments: ['expires_at'] } },
  19: { columns: { branches: ['currency'] } },
  20: { columns: { branches: ['google_place_id'] } },
};

/** One read of information_schema for the current database. */
async function readSnapshot(sequelize) {
  const rows = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT });
  const tableRows = await rows(
    'SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\''
  );
  const columnRows = await rows(
    'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const indexRows = await rows(
    'SELECT DISTINCT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()'
  );

  const tables = new Map(tableRows.map((r) => [r.TABLE_NAME, r]));
  const columns = new Map();
  for (const r of columnRows) {
    if (!columns.has(r.TABLE_NAME)) columns.set(r.TABLE_NAME, new Map());
    columns.get(r.TABLE_NAME).set(r.COLUMN_NAME, r);
  }
  const indexes = new Map();
  for (const r of indexRows) {
    if (!indexes.has(r.TABLE_NAME)) indexes.set(r.TABLE_NAME, new Set());
    indexes.get(r.TABLE_NAME).add(r.INDEX_NAME);
  }
  return {
    hasTable: (t) => tables.has(t),
    col: (t, c) => columns.get(t)?.get(c) || null,
    hasIndex: (t, i) => Boolean(indexes.get(t)?.has(i)),
    tables,
    columns,
  };
}

const type = (c) => String(c?.DATA_TYPE || '').toLowerCase();
const present = () => ({ state: 'present' });
const missing = (detail) => ({ state: 'missing', detail });
const conflict = (detail) => ({ state: 'conflict', detail });

/** All of `spec.tables` and `spec.columns` / `spec.indexes` exist → present, else missing. */
const allAdded = (s, spec) => {
  const absent = [];
  for (const t of spec.tables || []) if (!s.hasTable(t)) absent.push(t);
  for (const [t, cols] of Object.entries(spec.columns || {})) {
    for (const c of cols) if (!s.col(t, c)) absent.push(`${t}.${c}`);
  }
  for (const [t, idx] of Object.entries(spec.indexes || {})) {
    for (const i of idx) if (!s.hasIndex(t, i)) absent.push(`${t} index ${i}`);
  }
  return absent.length ? missing(`not found: ${absent.join(', ')}`) : present();
};

/** A table the migration creates, recognised by one column it must have (the migration's own skip rule). */
const tableWithColumn = (s, table, column) => {
  if (!s.hasTable(table)) return missing(`table ${table} not found`);
  if (!s.col(table, column)) return conflict(`table ${table} exists without column ${column}`);
  return present();
};

/** A column the migration adds, with the types the migration accepts as already done. */
const columnOfType = (s, table, column, okTypes, { tableOptional = false } = {}) => {
  if (!s.hasTable(table)) return tableOptional ? present() : missing(`table ${table} not found`);
  const c = s.col(table, column);
  if (!c) return missing(`${table}.${column} not found`);
  if (!okTypes(c)) return conflict(`${table}.${column} is ${c.COLUMN_TYPE}`);
  return present();
};

const count = async (sequelize, sql) => {
  const [row] = await sequelize.query(sql, { type: QueryTypes.SELECT });
  return Number(row?.n || 0);
};

/** version → async (snapshot, sequelize) → { state, detail? }. Each mirrors that migration's `up`. */
const PROBES = {
  1: async (s) => allAdded(s, ADDS[1]),
  2: async (s) => allAdded(s, ADDS[2]),
  3: async (s) => allAdded(s, ADDS[3]),
  4: async (s, seq) => {
    if (!s.col('payments', 'business_date')) return missing('payments.business_date not found');
    const n = await count(seq, 'SELECT COUNT(*) AS n FROM payments WHERE business_date IS NULL');
    return n ? missing(`${n} payment(s) without business_date`) : present();
  },
  5: async (s, seq) => {
    if (!s.col('branches', 'gym_listing_id') || !s.col('gyms', 'gym_listing_id')) return missing('gym_listing_id not found');
    const n = await count(
      seq,
      'SELECT (SELECT COUNT(*) FROM branches WHERE gym_listing_id IS NULL OR gym_listing_id = \'\') + (SELECT COUNT(*) FROM gyms WHERE gym_listing_id IS NULL OR gym_listing_id = \'\') AS n'
    );
    return n ? missing(`${n} branch / gym row(s) without gym_listing_id`) : present();
  },
  6: async (s) => {
    const c = s.col('payments', 'business_date');
    if (!c) return missing('payments.business_date not found');
    return c.IS_NULLABLE === 'NO' ? present() : missing('payments.business_date is nullable');
  },
  7: async (s) => {
    const off = new Set();
    for (const [name, t] of s.tables) if (t.TABLE_COLLATION && t.TABLE_COLLATION !== CANONICAL_COLLATION) off.add(name);
    for (const [name, cols] of s.columns) {
      if (!s.hasTable(name)) continue; // views
      for (const c of cols.values()) if (c.COLLATION_NAME && c.COLLATION_NAME !== CANONICAL_COLLATION) off.add(name);
    }
    return off.size ? missing(`${off.size} table(s) not ${CANONICAL_COLLATION}: ${[...off].sort().join(', ')}`) : present();
  },
  8: async (s) => allAdded(s, ADDS[8]),
  9: async (s) => tableWithColumn(s, 'capacity_outbox', 'idempotency_key'),
  10: async (s) => allAdded(s, ADDS[10]),
  11: async (s) => tableWithColumn(s, 'idempotency_records', 'idempotency_key'),
  12: async (s) => tableWithColumn(s, 'payouts', 'amount'),
  13: async (s) => columnOfType(s, 'role_assignments', 'version', (c) => INT_TYPES.includes(type(c))),
  14: async (s, seq) => {
    const t = tableWithColumn(s, 'invoice_sequences', 'next_number');
    if (t.state !== 'present') return t;
    const n = await count(seq, 'SELECT COUNT(*) AS n FROM invoice_sequences WHERE branch_id = \'GLOBAL\'');
    return n ? present() : missing('invoice_sequences has no GLOBAL row');
  },
  15: async (s) => {
    const r = columnOfType(s, 'gym_staff', 'invite_token_hash', (c) => ['varchar', 'char', 'text'].includes(type(c)), { tableOptional: true });
    if (r.state !== 'present' || !s.hasTable('gym_staff')) return r;
    return s.col('gym_staff', 'token_expires_at') ? present() : missing('gym_staff.token_expires_at not found');
  },
  16: async (s) => {
    const shift = columnOfType(s, 'payments', 'shift', (c) => type(c) === 'varchar', { tableOptional: true });
    if (shift.state === 'conflict') return shift;
    const closed = columnOfType(s, 'ledger_days', 'closed_collectors_json', (c) => TEXT_TYPES.includes(type(c)), { tableOptional: true });
    if (closed.state === 'conflict') return closed;
    return shift.state === 'present' && closed.state === 'present' ? present() : missing([shift.detail, closed.detail].filter(Boolean).join('; '));
  },
  17: async (s) => columnOfType(s, 'payments', 'pending_change_json', (c) => TEXT_TYPES.includes(type(c)), { tableOptional: true }),
  18: async (s) => {
    if (!s.hasTable('payments')) return present();
    const status = s.col('payments', 'status');
    const known = ['PENDING', 'STAFF_COLLECTED', 'COMPLETED', 'FAILED', 'REFUNDED'];
    let hasExpired = true;
    if (type(status) === 'enum') {
      const values = [...String(status.COLUMN_TYPE).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);
      const lacking = known.filter((v) => !values.includes(v));
      if (lacking.length) return conflict(`payments.status is ${status.COLUMN_TYPE}; it lacks ${lacking.join(', ')}`);
      hasExpired = values.includes('EXPIRED');
    } else if (!(['varchar', 'char'].includes(type(status)) && Number(status?.CHARACTER_MAXIMUM_LENGTH) >= 'EXPIRED'.length)) {
      return conflict(`payments.status is ${status?.COLUMN_TYPE}`);
    }
    const expires = s.col('payments', 'expires_at');
    if (expires && !['datetime', 'timestamp'].includes(type(expires))) return conflict(`payments.expires_at is ${expires.COLUMN_TYPE}`);
    if (!hasExpired) return missing('payments.status has no EXPIRED');
    return expires ? present() : missing('payments.expires_at not found');
  },
  19: async (s) => columnOfType(
    s, 'branches', 'currency',
    (c) => ['varchar', 'char'].includes(type(c)) && Number(c.CHARACTER_MAXIMUM_LENGTH) >= 3
  ),
  20: async (s) => columnOfType(
    s, 'branches', 'google_place_id',
    (c) => type(c) === 'varchar' && Number(c.CHARACTER_MAXIMUM_LENGTH) >= 255
  ),
};

/** Tables and columns the tenant models read (Sequelize field names, no VIRTUAL attributes). */
function modelColumns() {
  const { Sequelize } = require('sequelize');
  const registerTenantModels = require('../models/tenant');
  const offline = new Sequelize('mysql://offline@127.0.0.1:1/offline', { dialect: 'mysql', logging: false });
  const models = registerTenantModels(offline);
  const out = new Map();
  for (const model of Object.values(models)) {
    if (!model || typeof model.getTableName !== 'function') continue;
    const table = String(model.getTableName());
    const cols = out.get(table) || new Set();
    for (const attr of Object.values(model.rawAttributes)) {
      if (attr.type && attr.type.key === 'VIRTUAL') continue;
      cols.add(attr.field || attr.fieldName);
    }
    out.set(table, cols);
  }
  return out;
}

/**
 * Read-only inspection. Nothing is written.
 * @returns {Promise<{ hasMigrationTable: boolean, recordedVersions: number[], probes: Array<{version:number,name:string,state:string,detail?:string}>,
 *   modelGaps: string[], refusals: string[], baseline: number[], toApply: number[] }>}
 */
async function inspectTenantSchema(sequelize) {
  const s = await readSnapshot(sequelize);
  const hasMigrationTable = s.hasTable('schema_migrations');
  const recordedVersions = hasMigrationTable
    ? (await sequelize.query('SELECT version FROM schema_migrations ORDER BY version', { type: QueryTypes.SELECT })).map((r) => Number(r.version))
    : [];

  const refusals = [];
  if (hasMigrationTable) {
    refusals.push('schema_migrations already exists: use node src/scripts/run-tenant-migrations.js (--dry-run first)');
  }
  if (!s.hasTable('branches') || !s.hasTable('gyms')) {
    refusals.push('no branches / gyms table: this is not a provisioned tenant database');
  }

  const probes = [];
  for (const mig of MIGRATIONS) {
    const probe = PROBES[mig.version];
    if (!probe) {
      refusals.push(`migration ${mig.name} has no baseline probe`);
      continue;
    }
    const r = await probe(s, sequelize);
    probes.push({ version: mig.version, name: mig.name, ...r });
    if (r.state === 'conflict') refusals.push(`${mig.name}: ${r.detail}`);
  }

  // What the pending migrations will add; anything else the models read must exist already.
  const willAdd = new Set();
  for (const p of probes.filter((x) => x.state === 'missing')) {
    const spec = ADDS[p.version] || {};
    for (const t of spec.tables || []) willAdd.add(t);
    for (const [t, cols] of Object.entries(spec.columns || {})) for (const c of cols) willAdd.add(`${t}.${c}`);
  }
  const modelGaps = [];
  for (const [table, cols] of modelColumns()) {
    if (!s.hasTable(table)) {
      if (!willAdd.has(table)) modelGaps.push(table);
      continue;
    }
    for (const c of cols) {
      if (!s.col(table, c) && !willAdd.has(`${table}.${c}`)) modelGaps.push(`${table}.${c}`);
    }
  }
  if (modelGaps.length) {
    refusals.push(`the models read ${modelGaps.length} table(s) / column(s) that no tenant migration adds (NEW-126, a new migration is needed first): ${modelGaps.join(', ')}`);
  }

  return {
    hasMigrationTable,
    recordedVersions,
    probes,
    modelGaps,
    refusals,
    baseline: probes.filter((p) => p.state === 'present').map((p) => p.version),
    toApply: probes.filter((p) => p.state === 'missing').map((p) => p.version),
  };
}

/**
 * Baseline a tenant database that has no `schema_migrations`, then apply only what is missing.
 * Dry run unless `apply: true`. Refuses (writes nothing) when `inspectTenantSchema` finds a refusal.
 * @returns {Promise<{ applied: boolean, refused: boolean, inspection: object, migrationResult?: object, missingAfter?: number[] }>}
 */
async function repairTenantSchema(sequelize, { apply = false, tenantId, tenantCode, gymName } = {}) {
  const inspection = await inspectTenantSchema(sequelize);
  if (inspection.refusals.length) return { applied: false, refused: true, inspection };
  if (!apply) return { applied: false, refused: false, inspection };

  const names = new Map(MIGRATIONS.map((m) => [m.version, m.name]));
  // DDL commits on its own in MySQL, so the table is made first; the baseline rows are one unit.
  await ensureMigrationTable(sequelize);
  await sequelize.transaction(async (transaction) => {
    for (const v of inspection.baseline) {
      await sequelize.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())',
        { replacements: [v, names.get(v)], transaction }
      );
    }
  });

  const migrationResult = await runTenantMigrations(sequelize, { tenantId, tenantCode, gymName });
  const missingAfter = await missingTenantMigrations(sequelize);
  return { applied: true, refused: false, inspection, migrationResult, missingAfter };
}

module.exports = { PROBES, ADDS, inspectTenantSchema, repairTenantSchema, readSnapshot };
