/**
 * Platform migrations added in Prompt 1D (p008, p009, p010), each proven on its own
 * against a scratch database: `--dry-run` writes nothing, conflicting data makes the migration
 * skip (not recorded, nothing changed), applying is idempotent.
 *
 * Scratch database `gymsera_test_platform_mig_1d` — never the harness platform
 * DB and never a live one (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_1d';

describe('Platform migrations p008, p009, p010 (Prompt 1D)', () => {
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

  const createDbBefore1D = async () => {
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

    // Create refresh_tokens table as it existed before p008 (no family_id column)
    await seq.query(`
      CREATE TABLE refresh_tokens (
        id CHAR(36) NOT NULL PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        token TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        is_revoked TINYINT(1) DEFAULT 0,
        ip_address VARCHAR(50) NULL,
        user_agent VARCHAR(300) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(
      "INSERT INTO refresh_tokens (id, user_id, token, expires_at, created_at, updated_at) VALUES " +
        "('rt1', 'u1', 'legacy_token_1', NOW() + INTERVAL 7 DAY, NOW(), NOW())"
    );

    // Create otps table as it existed before p009 (code VARCHAR(6), no attempts/max_attempts)
    await seq.query(`
      CREATE TABLE otps (
        id CHAR(36) NOT NULL PRIMARY KEY,
        user_id CHAR(36) NULL,
        email VARCHAR(150) NULL,
        phone VARCHAR(25) NULL,
        code VARCHAR(6) NOT NULL,
        type VARCHAR(50) NOT NULL,
        is_used TINYINT(1) DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(
      "INSERT INTO otps (id, email, code, type, expires_at, created_at, updated_at) VALUES " +
        "('otp1', 'user@example.test', '123456', 'EMAIL_VERIFICATION', NOW() + INTERVAL 10 MINUTE, NOW(), NOW())"
    );

    // Seed schema_migrations up to version 7
    await seq.query(`
      CREATE TABLE schema_migrations (
        version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    for (let v = 1; v <= 7; v++) {
      const mig = PLATFORM_MIGRATIONS.find(m => m.version === v);
      if (mig) {
        await seq.query(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())",
          { replacements: [v, mig.name] }
        );
      }
    }
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

  describe('p008 — refresh_tokens.family_id (AUTH-01)', () => {
    const P008 = 'p008_refresh_tokens_family_id';
    const p008 = () => PLATFORM_MIGRATIONS.find((m) => m.name === P008);

    test('--dry-run lists p008 and writes NOTHING (schema and rows identical)', async () => {
      await createDbBefore1D();
      const before = await snapshot();
      const result = await runPlatformMigrations(seq, { dryRun: true });
      expect(result.wouldRun).toContain(P008);
      await p008().up(seq, { dryRun: true });
      expect(await snapshot()).toEqual(before);
    });

    test('conflicting data: a hand-made family_id column of another type → skipped, not recorded, untouched', async () => {
      await createDbBefore1D();
      await seq.query('ALTER TABLE refresh_tokens ADD COLUMN family_id INT NOT NULL DEFAULT 1');
      const before = await snapshot();

      const result = await p008().up(seq, {});
      expect(result).toMatchObject({ skipped: true, reason: 'column_exists_with_other_type' });
      expect(await snapshot()).toEqual(before);

      const run = await runPlatformMigrations(seq);
      expect(run.applied).not.toContain(P008);
      const [recorded] = await seq.query('SELECT version FROM schema_migrations WHERE version = 8');
      expect(recorded).toHaveLength(0);
    });

    test('apply adds nullable CHAR(36) family_id column; existing rows untouched; re-run changes nothing', async () => {
      await createDbBefore1D();
      const result = await runPlatformMigrations(seq, { targetVersion: 8 });
      expect(result.applied).toContain(P008);

      const [[col]] = await seq.query("SHOW COLUMNS FROM refresh_tokens LIKE 'family_id'");
      expect(col).toBeDefined();
      expect(col.Type.toLowerCase()).toBe('char(36)');
      expect(col.Null).toBe('YES');

      const rows = await seq.query('SELECT id, family_id FROM refresh_tokens', { type: QueryTypes.SELECT });
      expect(rows).toEqual([{ id: 'rt1', family_id: null }]);

      const afterFirst = await snapshot();
      const second = await runPlatformMigrations(seq, { targetVersion: 8 });
      expect(second.applied).toEqual([]);
      expect(await p008().up(seq, {})).toBeNull();
      expect(await snapshot()).toEqual(afterFirst);
    });
  });

  describe('p009 — otps code widening and attempts tracking (AUTH-04)', () => {
    const P009 = 'p009_otp_security_hash_and_attempts';
    const p009 = () => PLATFORM_MIGRATIONS.find((m) => m.name === P009);

    test('--dry-run lists p009 and writes NOTHING', async () => {
      await createDbBefore1D();
      const before = await snapshot();
      const result = await runPlatformMigrations(seq, { dryRun: true });
      expect(result.wouldRun).toContain(P009);
      await p009().up(seq, { dryRun: true });
      expect(await snapshot()).toEqual(before);
    });

    test('conflicting data: hand-made attempts column of incompatible type (VARCHAR) → skipped, not recorded', async () => {
      await createDbBefore1D();
      await seq.query('ALTER TABLE otps ADD COLUMN attempts VARCHAR(50) NOT NULL DEFAULT "zero"');
      const before = await snapshot();

      const result = await p009().up(seq, {});
      expect(result).toMatchObject({ skipped: true, reason: 'column_exists_with_other_type', column: 'attempts' });
      expect(await snapshot()).toEqual(before);

      const run = await runPlatformMigrations(seq);
      expect(run.applied).not.toContain(P009);
      const [recorded] = await seq.query('SELECT version FROM schema_migrations WHERE version = 9');
      expect(recorded).toHaveLength(0);
    });

    test('apply widens code to VARCHAR(64) and adds attempts / max_attempts; re-run is idempotent', async () => {
      await createDbBefore1D();
      const result = await runPlatformMigrations(seq, { targetVersion: 9 });
      expect(result.applied).toContain(P009);

      const [[codeCol]] = await seq.query("SHOW COLUMNS FROM otps LIKE 'code'");
      expect(codeCol.Type.toLowerCase()).toBe('varchar(64)');

      const [[attCol]] = await seq.query("SHOW COLUMNS FROM otps LIKE 'attempts'");
      expect(attCol.Type.toLowerCase()).toBe('int(11)');

      const [[maxAttCol]] = await seq.query("SHOW COLUMNS FROM otps LIKE 'max_attempts'");
      expect(maxAttCol.Type.toLowerCase()).toBe('int(11)');

      const afterFirst = await snapshot();
      const second = await runPlatformMigrations(seq, { targetVersion: 9 });
      expect(second.applied).toEqual([]);
      expect(await p009().up(seq, {})).toBeNull();
      expect(await snapshot()).toEqual(afterFirst);
    });
  });

  describe('p010 — tenant_invitations and platform_audit_logs (AUTH-09)', () => {
    const P010 = 'p010_tenant_invitations_and_audit';
    const p010 = () => PLATFORM_MIGRATIONS.find((m) => m.name === P010);

    test('--dry-run lists p010 and writes NOTHING', async () => {
      await createDbBefore1D();
      const before = await snapshot();
      const result = await runPlatformMigrations(seq, { dryRun: true });
      expect(result.wouldRun).toContain(P010);
      await p010().up(seq, { dryRun: true });
      expect(await snapshot()).toEqual(before);
    });

    test('conflicting data: tenant_invitations table exists with incompatible schema → skipped, not recorded', async () => {
      await createDbBefore1D();
      await seq.query('CREATE TABLE tenant_invitations (id INT PRIMARY KEY, dummy VARCHAR(50))');
      const before = await snapshot();

      const result = await p010().up(seq, {});
      expect(result).toMatchObject({ skipped: true, reason: 'table_exists_with_other_schema', table: 'tenant_invitations' });
      expect(await snapshot()).toEqual(before);

      const run = await runPlatformMigrations(seq);
      expect(run.applied).not.toContain(P010);
      const [recorded] = await seq.query('SELECT version FROM schema_migrations WHERE version = 10');
      expect(recorded).toHaveLength(0);
    });

    test('apply creates tenant_invitations and platform_audit_logs tables; re-run is idempotent', async () => {
      await createDbBefore1D();
      const result = await runPlatformMigrations(seq, { targetVersion: 10 });
      expect(result.applied).toContain(P010);

      const [[invTable]] = await seq.query("SHOW TABLES LIKE 'tenant_invitations'");
      expect(invTable).toBeDefined();

      const [[auditTable]] = await seq.query("SHOW TABLES LIKE 'platform_audit_logs'");
      expect(auditTable).toBeDefined();

      const afterFirst = await snapshot();
      const second = await runPlatformMigrations(seq, { targetVersion: 10 });
      expect(second.applied).toEqual([]);
      expect(await p010().up(seq, {})).toBeNull();
      expect(await snapshot()).toEqual(afterFirst);
    });
  });
});
