/**
 * Platform migrations added in Prompt 1B (p004 onward), each proven on its own
 * against a scratch database shaped like production AFTER Prompt 1A (p001–p003
 * applied): `--dry-run` writes nothing, conflicting data makes the migration
 * skip (not recorded, nothing changed), applying is idempotent.
 *
 * Scratch database `gymsera_test_platform_mig_1b` — never the harness platform
 * DB and never a live one (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_1b';
const STATUS_AFTER_1A =
  "ENUM('ACTIVE','EXPIRED','CANCELLED','PENDING_MIGRATION','PENDING_CANCEL','SCHEDULED','REVOKED') NOT NULL DEFAULT 'ACTIVE'";

describe('Platform migrations p004+ (Prompt 1B)', () => {
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

  const columnType = async (column) => {
    const [[col]] = await seq.query(`SHOW COLUMNS FROM tenant_subscriptions LIKE '${column}'`);
    return col ? col.Type : null;
  };

  /** A platform DB as production has it after Prompt 1A: p001–p003 applied. */
  const createDbAfter1A = async ({ statusType = STATUS_AFTER_1A } = {}) => {
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
      CREATE TABLE tenant_subscriptions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) NOT NULL,
        platform ENUM('MANUAL','IOS','ANDROID','STRIPE') NOT NULL DEFAULT 'MANUAL',
        external_original_transaction_id VARCHAR(150) NULL,
        amount DECIMAL(10,2) NOT NULL DEFAULT 0,
        status ${statusType},
        UNIQUE INDEX tenant_subscriptions_platform_external_unique (platform, external_original_transaction_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(
      "INSERT INTO tenant_subscriptions (id, tenant_id, platform, external_original_transaction_id, amount, status) VALUES " +
        "('s1', 't1', 'IOS', 'orig-1', 4999.00, 'ACTIVE'), ('s2', 't2', 'MANUAL', NULL, 1000.00, 'REVOKED')"
    );
    await seq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES " +
        "(1, 'p001_create_billing_events', NOW()), (2, 'p002_tenant_subscriptions_status_revoked', NOW()), " +
        "(3, 'p003_tenant_subscriptions_unique_external_id', NOW())"
    );
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
  });

  afterAll(async () => {
    await seq?.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await teardownTestDatabases();
  });

  const newNames = () => PLATFORM_MIGRATIONS.filter((m) => m.version >= 4).map((m) => m.name);

  describe('p004 — status GRACE, ON_HOLD, PAUSED (BILL-04)', () => {
    const P004 = 'p004_tenant_subscriptions_status_grace_hold_pause';
    const p004 = () => PLATFORM_MIGRATIONS.find((m) => m.name === P004);

    test('--dry-run lists p004 and writes NOTHING (schema and rows identical)', async () => {
      await createDbAfter1A();
      const before = await snapshot();
      const result = await runPlatformMigrations(seq, { dryRun: true });
      expect(result.applied).toEqual([]);
      expect(result.initialVersion).toBe(3);
      expect(result.finalVersion).toBe(3);
      expect(result.wouldRun).toEqual(newNames());
      expect(result.wouldRun).toContain(P004);
      // The migration's own guard, called directly with the dry-run context.
      await p004().up(seq, { dryRun: true });
      expect(await snapshot()).toEqual(before);
    });

    test('conflicting data: a status value p004 does not know → skipped, not recorded, nothing changed', async () => {
      await createDbAfter1A({
        statusType:
          "ENUM('ACTIVE','EXPIRED','CANCELLED','PENDING_MIGRATION','PENDING_CANCEL','SCHEDULED','REVOKED','LEGACY_TRIAL') NOT NULL DEFAULT 'ACTIVE'",
      });
      await seq.query("INSERT INTO tenant_subscriptions (id, tenant_id, amount, status) VALUES ('s3', 't3', 0, 'LEGACY_TRIAL')");
      const before = await snapshot();

      const result = await p004().up(seq, {});
      expect(result).toMatchObject({ skipped: true, reason: 'unknown_enum_values', unknownAllowed: ['LEGACY_TRIAL'] });
      expect(result.unknownRows).toEqual([expect.objectContaining({ value: 'LEGACY_TRIAL' })]);
      expect(await snapshot()).toEqual(before);

      const run = await runPlatformMigrations(seq);
      expect(run.applied).not.toContain(P004);
      const [recorded] = await seq.query('SELECT version FROM schema_migrations WHERE version = 4');
      expect(recorded).toHaveLength(0);
      expect(await columnType('status')).toContain("'LEGACY_TRIAL'");
    });

    test('apply adds the three states, keeps every row; a re-run changes nothing', async () => {
      await createDbAfter1A();
      const result = await runPlatformMigrations(seq);
      expect(result.applied).toContain(P004);
      expect(await columnType('status')).toBe(
        "enum('ACTIVE','EXPIRED','CANCELLED','PENDING_MIGRATION','PENDING_CANCEL','SCHEDULED','REVOKED','GRACE','ON_HOLD','PAUSED')"
      );
      const rows = await seq.query('SELECT id, status FROM tenant_subscriptions ORDER BY id', { type: QueryTypes.SELECT });
      expect(rows).toEqual([{ id: 's1', status: 'ACTIVE' }, { id: 's2', status: 'REVOKED' }]);
      await seq.query("UPDATE tenant_subscriptions SET status = 'GRACE' WHERE id = 's1'");

      const afterFirst = await snapshot();
      const second = await runPlatformMigrations(seq);
      expect(second.applied).toEqual([]);
      // Called directly again (as if its row were missing): still a no-op.
      expect(await p004().up(seq, {})).toBeNull();
      expect(await snapshot()).toEqual(afterFirst);
    });
  });
});
