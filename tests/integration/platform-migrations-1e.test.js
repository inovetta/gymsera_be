/**
 * Platform and Tenant migrations added in Prompt 1E (p011 and 011), each proven
 * on its own: `--dry-run` writes nothing, conflicting schema makes the migration
 * skip (not recorded, nothing changed), applying is idempotent.
 *
 * Scratch databases: `gymsera_test_platform_mig_1e` and `gymsera_test_tenant_mig_1e`
 * (Rule R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');
const { runTenantMigrations, TARGET_SCHEMA_VERSION, MIGRATIONS } = require('../../src/database/tenant-migration-runner');

const SCRATCH_PLATFORM_DB = 'gymsera_test_platform_mig_1e';
const SCRATCH_TENANT_DB = 'gymsera_test_tenant_mig_1e';

describe('Prompt 1E Migrations (p011 & 011)', () => {
  let platformSeq;
  let tenantSeq;

  const snapshot = async (seq) => {
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

  const createPlatformDbBefore1E = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_PLATFORM_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_PLATFORM_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (platformSeq) await platformSeq.close().catch(() => {});
    platformSeq = new Sequelize(SCRATCH_PLATFORM_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });

    // Seed schema_migrations up to version 10
    await platformSeq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    for (let v = 1; v <= 10; v++) {
      const mig = PLATFORM_MIGRATIONS.find((m) => m.version === v);
      if (mig) {
        await platformSeq.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())',
          { replacements: [v, mig.name] }
        );
      }
    }
  };

  const createTenantDbBefore1E = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_TENANT_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_TENANT_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (tenantSeq) await tenantSeq.close().catch(() => {});
    tenantSeq = new Sequelize(SCRATCH_TENANT_DB, process.env.TENANT_DB_USER || 'root', process.env.TENANT_DB_PASS || '', {
      host: process.env.TENANT_DB_HOST || 'localhost',
      port: Number(process.env.TENANT_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });

    // Seed schema_migrations up to version 10
    await tenantSeq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    for (let v = 1; v <= 10; v++) {
      const mig = MIGRATIONS.find((m) => m.version === v);
      if (mig) {
        await tenantSeq.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())',
          { replacements: [v, mig.name] }
        );
      }
    }
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_PLATFORM_DB, SCRATCH_TENANT_DB] });
  });

  afterAll(async () => {
    if (platformSeq) await platformSeq.close().catch(() => {});
    if (tenantSeq) await tenantSeq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_PLATFORM_DB}\``).catch(() => {});
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_TENANT_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  describe('p011_create_idempotency_records (Platform DB)', () => {
    const P011 = 'p011_create_idempotency_records';

    test('--dry-run reports wouldRun and writes NOTHING', async () => {
      await createPlatformDbBefore1E();
      const before = await snapshot(platformSeq);
      const res = await runPlatformMigrations(platformSeq, { dryRun: true });

      expect(res.dryRun).toBe(true);
      expect(res.wouldRun).toContain(P011);
      expect(await snapshot(platformSeq)).toEqual(before);
    });

    test('p011 skips cleanly when table exists with conflicting schema', async () => {
      await createPlatformDbBefore1E();
      // Create conflicting idempotency_records table without idempotency_key
      await platformSeq.query(`
        CREATE TABLE IF NOT EXISTS idempotency_records (
          id CHAR(36) NOT NULL PRIMARY KEY,
          legacy_key VARCHAR(100) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      const before = await snapshot(platformSeq);
      const res = await runPlatformMigrations(platformSeq);
      expect(res.applied).not.toContain(P011);

      const [record] = await platformSeq.query(
        'SELECT version FROM schema_migrations WHERE version = 11'
      );
      expect(record).toHaveLength(0); // skipped, not recorded
      expect(await snapshot(platformSeq)).toEqual(before);
    });

    test('apply creates idempotency_records and is idempotent', async () => {
      await createPlatformDbBefore1E();
      const res1 = await runPlatformMigrations(platformSeq);
      expect(res1.finalVersion).toBe(11);
      expect(res1.applied).toContain(P011);

      // Verify table exists and has proper columns
      const cols = await platformSeq.getQueryInterface().describeTable('idempotency_records');
      expect(cols.idempotency_key).toBeDefined();
      expect(cols.request_hash).toBeDefined();
      expect(cols.status).toBeDefined();
      expect(cols.response_body).toBeDefined();

      // Second run is idempotent
      const res2 = await runPlatformMigrations(platformSeq);
      expect(res2.applied).toHaveLength(0);
      expect(res2.finalVersion).toBe(11);
    });
  });

  describe('011_create_idempotency_records_table (Tenant DB)', () => {
    const M011 = '011_create_idempotency_records_table';

    test('--dry-run writes nothing to tenant DB', async () => {
      await createTenantDbBefore1E();
      const before = await snapshot(tenantSeq);
      const res = await runTenantMigrations(tenantSeq, {
        tenantId: 'scratch-tenant',
        dryRun: true,
      });

      expect(res.dryRun).toBe(true);
      expect(res.wouldRun).toContain(M011);
      expect(await snapshot(tenantSeq)).toEqual(before);
    });

    test('apply creates idempotency_records table on tenant DB', async () => {
      await createTenantDbBefore1E();
      const res = await runTenantMigrations(tenantSeq, {
        tenantId: 'scratch-tenant',
      });
      expect(res.finalVersion).toBe(11);
      expect(res.applied).toContain(M011);

      const cols = await tenantSeq.getQueryInterface().describeTable('idempotency_records');
      expect(cols.idempotency_key).toBeDefined();
      expect(cols.request_hash).toBeDefined();
      expect(cols.status).toBeDefined();

      // Second run is idempotent
      const res2 = await runTenantMigrations(tenantSeq, {
        tenantId: 'scratch-tenant',
      });
      expect(res2.applied).toHaveLength(0);
      expect(res2.finalVersion).toBe(11);
    });
  });
});
