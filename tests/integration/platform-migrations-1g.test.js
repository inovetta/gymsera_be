/**
 * Platform migration added in Prompt 1G (FLOW-02): p013 adds the resumable
 * provisioning columns to `tenants`. Proven like every earlier migration:
 * `--dry-run` writes nothing, a conflicting column makes it skip (not recorded,
 * nothing changed), applying is idempotent and keeps every existing row as is.
 *
 * Deploy order (the Prompt 1E lesson): the Tenant model reads these columns, and
 * tenant discovery in the tenant migration runner queries the Tenant model, so
 * p013 must be APPLIED before the new code runs — including before
 * `run-tenant-migrations.js --dry-run`.
 *
 * Scratch database: `gymsera_test_platform_mig_1g` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_1g';
const P013 = 'p013_tenants_provisioning_state';
const COLUMNS = ['provisioning_state', 'provisioning_lock_token', 'provisioning_locked_until', 'provisioning_error'];

describe('Prompt 1G migration p013 (tenants provisioning state)', () => {
  let seq;

  const snapshot = async () => {
    const tables = await seq.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      { type: QueryTypes.SELECT }
    );
    const out = {};
    for (const { TABLE_NAME } of tables) {
      const [[ddl]] = await seq.query(`SHOW CREATE TABLE \`${TABLE_NAME}\``);
      const rows = await seq.query(`SELECT * FROM \`${TABLE_NAME}\``, { type: QueryTypes.SELECT });
      out[TABLE_NAME] = { ddl: ddl['Create Table'], rows: JSON.parse(JSON.stringify(rows)) };
    }
    return out;
  };

  const columns = async () =>
    (await seq.query(
      "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND COLUMN_NAME LIKE 'provisioning%'",
      { type: QueryTypes.SELECT }
    )).sort((a, b) => (a.name < b.name ? -1 : 1)); // byte order, not the collation's

  /** Shaped like production after Prompt 1E: schema_migrations at v12, tenants with rows in every status. */
  const createPlatformDbBefore1G = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (seq) await seq.close().catch(() => {});
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    await seq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 12)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', {
        replacements: [mig.version, mig.name],
      });
    }
    await seq.query(`
      CREATE TABLE tenants (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_code VARCHAR(50) NOT NULL,
        status ENUM('DRAFT','PENDING_REVIEW','UNDER_REVIEW','APPROVED','ACTIVE','SUSPENDED','REJECTED') NOT NULL DEFAULT 'DRAFT',
        db_name VARCHAR(100) NULL,
        payment_details_json JSON NULL,
        payment_details_updated_at DATETIME NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(`
      INSERT INTO tenants (id, tenant_code, status, db_name, created_at, updated_at) VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001', 'GYM-ACTIVE', 'ACTIVE', 'gymsera_gym_active', NOW(), NOW()),
        ('aaaaaaaa-0000-4000-8000-000000000002', 'GYM-STUCK', 'APPROVED', NULL, NOW(), NOW()),
        ('aaaaaaaa-0000-4000-8000-000000000003', 'GYM-PENDING', 'PENDING_REVIEW', NULL, NOW(), NOW())
    `);
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p013 is the platform target version', () => {
    expect(PLATFORM_TARGET_VERSION).toBe(13);
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 13).name).toBe(P013);
  });

  test('--dry-run reports p013 and writes NOTHING', async () => {
    await createPlatformDbBefore1G();
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toEqual([P013]);
    expect(await snapshot()).toEqual(before);
  });

  test('a conflicting column (other type) → skipped, not recorded, table unchanged', async () => {
    await createPlatformDbBefore1G();
    await seq.query('ALTER TABLE tenants ADD COLUMN provisioning_state INT NULL');
    await seq.query("UPDATE tenants SET provisioning_state = 7 WHERE tenant_code = 'GYM-STUCK'");
    const before = await snapshot();

    await runPlatformMigrations(seq);

    expect(await snapshot()).toEqual(before); // no other column added either (all-or-nothing)
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 13', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('a conflicting NOT NULL column → skipped too', async () => {
    await createPlatformDbBefore1G();
    await seq.query("ALTER TABLE tenants ADD COLUMN provisioning_error VARCHAR(500) NOT NULL DEFAULT ''");
    const before = await snapshot();
    await runPlatformMigrations(seq);
    expect(await snapshot()).toEqual(before);
  });

  test('apply adds four nullable columns, keeps every row, is recorded; re-run is a no-op', async () => {
    await createPlatformDbBefore1G();
    const rowsBefore = await seq.query('SELECT id, tenant_code, status, db_name FROM tenants ORDER BY id', { type: QueryTypes.SELECT });

    const res = await runPlatformMigrations(seq);
    expect(res.applied).toEqual([P013]);
    expect(await columns()).toEqual([
      { name: 'provisioning_error', type: 'varchar(500)', nullable: 'YES' },
      { name: 'provisioning_lock_token', type: 'char(36)', nullable: 'YES' },
      { name: 'provisioning_locked_until', type: 'datetime', nullable: 'YES' },
      { name: 'provisioning_state', type: 'varchar(32)', nullable: 'YES' },
    ]);
    expect(await seq.query('SELECT id, tenant_code, status, db_name FROM tenants ORDER BY id', { type: QueryTypes.SELECT })).toEqual(rowsBefore);
    const states = await seq.query(`SELECT ${COLUMNS.join(', ')} FROM tenants`, { type: QueryTypes.SELECT });
    expect(states.every((r) => COLUMNS.every((c) => r[c] === null))).toBe(true); // no backfill

    const afterApply = await snapshot();
    const again = await runPlatformMigrations(seq);
    expect(again.applied).toEqual([]);
    expect(await snapshot()).toEqual(afterApply);
  });

  test('columns added by hand with the right types → recorded without changes', async () => {
    await createPlatformDbBefore1G();
    await seq.query(
      'ALTER TABLE tenants ADD COLUMN provisioning_state VARCHAR(32) NULL, ADD COLUMN provisioning_lock_token CHAR(36) NULL'
    );
    const res = await runPlatformMigrations(seq);
    expect(res.applied).toEqual([P013]);
    expect((await columns()).map((c) => c.name)).toEqual([
      'provisioning_error', 'provisioning_lock_token', 'provisioning_locked_until', 'provisioning_state',
    ]);
  });
});
