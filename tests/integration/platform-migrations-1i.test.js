/**
 * Platform migrations added in Prompt 1I (AUTH-07, spec §14 R-28):
 *   p014 — `users`: statuses PENDING_DELETION / DELETED + deletion_requested_at,
 *          deletion_scheduled_for, deleted_at
 *   p015 — `tenants`: the same two statuses + the same three columns +
 *          status_before_deletion (what "undo" restores)
 *   p016 — `users.apple_refresh_token_encrypted` (Sign in with Apple revoke on deletion)
 *
 * Proven like every earlier migration: `--dry-run` writes nothing, a conflicting
 * column makes it skip (not recorded, nothing changed), applying keeps every row
 * and is idempotent.
 *
 * Deploy order (the Prompt 1E/1G lesson): the Tenant and User models read these
 * columns and tenant discovery in the tenant migration runner queries the Tenant
 * model, so p014/p015 must be APPLIED before the new code runs — including before
 * `run-tenant-migrations.js --dry-run`.
 *
 * Scratch database: `gymsera_test_platform_mig_1i` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, PLATFORM_TARGET_VERSION, runPlatformMigrations } = require('../../src/database/platform-migrations');

const SCRATCH_DB = 'gymsera_test_platform_mig_1i';
const P014 = 'p014_users_account_deletion';
const P015 = 'p015_tenants_account_deletion';
const P016 = 'p016_users_apple_refresh_token';
const DELETION_COLUMNS = ['deleted_at', 'deletion_requested_at', 'deletion_scheduled_for'];

describe('Prompt 1I migrations p014 / p015 (account deletion columns and statuses)', () => {
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

  const columns = async (table, like) =>
    (await seq.query(
      'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND (COLUMN_NAME LIKE ? OR COLUMN_NAME = \'deleted_at\')',
      { replacements: [table, like], type: QueryTypes.SELECT }
    )).sort((a, b) => (a.name < b.name ? -1 : 1)); // byte order, not the collation's

  const enumOf = async (table) => {
    const [row] = await seq.query(
      "SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'status'",
      { replacements: [table], type: QueryTypes.SELECT }
    );
    return [...String(row.type).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };

  /** Shaped like production after Prompt 1H: schema_migrations at v13, users and tenants with rows in every status. */
  const createPlatformDbBefore1I = async () => {
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
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 13)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', {
        replacements: [mig.version, mig.name],
      });
    }
    await seq.query(`
      CREATE TABLE users (
        id CHAR(36) NOT NULL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        status ENUM('ACTIVE','INACTIVE','SUSPENDED') NOT NULL DEFAULT 'INACTIVE',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(`
      INSERT INTO users (id, email, status, created_at, updated_at) VALUES
        ('bbbbbbbb-0000-4000-8000-000000000001', 'a@x.test', 'ACTIVE', NOW(), NOW()),
        ('bbbbbbbb-0000-4000-8000-000000000002', 'b@x.test', 'INACTIVE', NOW(), NOW()),
        ('bbbbbbbb-0000-4000-8000-000000000003', 'c@x.test', 'SUSPENDED', NOW(), NOW())
    `);
    await seq.query(`
      CREATE TABLE tenants (
        id CHAR(36) NOT NULL PRIMARY KEY,
        tenant_code VARCHAR(50) NOT NULL,
        status ENUM('DRAFT','PENDING_REVIEW','UNDER_REVIEW','APPROVED','REJECTED','SUSPENDED','ACTIVE') NOT NULL DEFAULT 'DRAFT',
        db_name VARCHAR(100) NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await seq.query(`
      INSERT INTO tenants (id, tenant_code, status, db_name, created_at, updated_at) VALUES
        ('aaaaaaaa-0000-4000-8000-000000000001', 'GYM-ACTIVE', 'ACTIVE', 'gymsera_gym_active', NOW(), NOW()),
        ('aaaaaaaa-0000-4000-8000-000000000002', 'GYM-REJECTED', 'REJECTED', 'gymsera_gym_rejected', NOW(), NOW()),
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

  test('p014, p015 and p016 are the last platform migrations, in order', () => {
    expect(PLATFORM_TARGET_VERSION).toBe(16);
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 16).name).toBe(P016);
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 14).name).toBe(P014);
    expect(PLATFORM_MIGRATIONS.find((m) => m.version === 15).name).toBe(P015);
  });

  test('--dry-run reports both and writes NOTHING', async () => {
    await createPlatformDbBefore1I();
    const before = await snapshot();
    const res = await runPlatformMigrations(seq, { dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toEqual([P014, P015, P016]);
    expect(await snapshot()).toEqual(before);
  });

  test('a conflicting users column (other type) → p014 skipped, not recorded, nothing changed', async () => {
    await createPlatformDbBefore1I();
    await seq.query('ALTER TABLE users ADD COLUMN deleted_at INT NULL');
    await seq.query("UPDATE users SET deleted_at = 5 WHERE email = 'b@x.test'");
    const before = await snapshot();

    await runPlatformMigrations(seq, { targetVersion: 14 });

    expect(await snapshot()).toEqual(before); // the enum was not widened and no other column added (all-or-nothing)
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 14', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('a conflicting NOT NULL tenants column → p015 skipped, nothing changed by it', async () => {
    await createPlatformDbBefore1I();
    await seq.query("ALTER TABLE tenants ADD COLUMN status_before_deletion VARCHAR(20) NOT NULL DEFAULT ''");
    await runPlatformMigrations(seq, { targetVersion: 14 }); // p014 may apply; p015 is what we test
    const before = await snapshot();

    await runPlatformMigrations(seq, { targetVersion: 15 });

    expect(await snapshot()).toEqual(before);
    const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 15', { type: QueryTypes.SELECT });
    expect(Number(row.n)).toBe(0);
  });

  test('apply widens both enums (old values keep their order), adds nullable columns, keeps every row; re-run is a no-op', async () => {
    await createPlatformDbBefore1I();
    const usersBefore = await seq.query('SELECT id, email, status FROM users ORDER BY id', { type: QueryTypes.SELECT });
    const tenantsBefore = await seq.query('SELECT id, tenant_code, status, db_name FROM tenants ORDER BY id', { type: QueryTypes.SELECT });

    const res = await runPlatformMigrations(seq);
    expect(res.applied).toEqual([P014, P015, P016]);

    expect(await enumOf('users')).toEqual(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'PENDING_DELETION', 'DELETED']);
    expect(await enumOf('tenants')).toEqual([
      'DRAFT', 'PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ACTIVE', 'PENDING_DELETION', 'DELETED',
    ]);
    expect(await columns('users', 'deletion%')).toEqual(
      DELETION_COLUMNS.map((name) => ({ name, type: 'datetime', nullable: 'YES' }))
    );
    expect(await columns('tenants', 'deletion%')).toEqual(
      DELETION_COLUMNS.map((name) => ({ name, type: 'datetime', nullable: 'YES' }))
    );
    const [sbd] = await seq.query(
      "SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
        "AND TABLE_NAME = 'tenants' AND COLUMN_NAME = 'status_before_deletion'",
      { type: QueryTypes.SELECT }
    );
    expect(sbd).toEqual({ type: 'varchar(20)', nullable: 'YES' });

    expect(await seq.query('SELECT id, email, status FROM users ORDER BY id', { type: QueryTypes.SELECT })).toEqual(usersBefore);
    expect(await seq.query('SELECT id, tenant_code, status, db_name FROM tenants ORDER BY id', { type: QueryTypes.SELECT })).toEqual(tenantsBefore);
    const filled = await seq.query(
      'SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NOT NULL OR deletion_requested_at IS NOT NULL OR deletion_scheduled_for IS NOT NULL',
      { type: QueryTypes.SELECT }
    );
    expect(Number(filled[0].n)).toBe(0); // no backfill

    const afterApply = await snapshot();
    const again = await runPlatformMigrations(seq);
    expect(again.applied).toEqual([]);
    expect(await snapshot()).toEqual(afterApply);
  });

  test('columns added by hand with the right types → recorded without changes to them', async () => {
    await createPlatformDbBefore1I();
    await seq.query('ALTER TABLE users ADD COLUMN deleted_at DATETIME NULL');
    const res = await runPlatformMigrations(seq);
    expect(res.applied).toEqual([P014, P015, P016]);
    expect((await columns('users', 'deletion%')).map((c) => c.name)).toEqual(DELETION_COLUMNS);
  });

  describe('p016 (users.apple_refresh_token_encrypted)', () => {
    const appleColumn = async () =>
      (await seq.query(
        "SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() " +
          "AND TABLE_NAME = 'users' AND COLUMN_NAME = 'apple_refresh_token_encrypted'",
        { type: QueryTypes.SELECT }
      ))[0];

    test('adds one nullable TEXT column, keeps every row, no backfill; re-run is a no-op', async () => {
      await createPlatformDbBefore1I();
      await runPlatformMigrations(seq, { targetVersion: 15 });
      const before = await seq.query('SELECT id, email, status FROM users ORDER BY id', { type: QueryTypes.SELECT });

      const res = await runPlatformMigrations(seq);

      expect(res.applied).toEqual([P016]);
      expect(await appleColumn()).toEqual({ type: 'text', nullable: 'YES' });
      expect(await seq.query('SELECT id, email, status FROM users ORDER BY id', { type: QueryTypes.SELECT })).toEqual(before);
      const [{ n }] = await seq.query('SELECT COUNT(*) AS n FROM users WHERE apple_refresh_token_encrypted IS NOT NULL', { type: QueryTypes.SELECT });
      expect(Number(n)).toBe(0);
      const afterApply = await snapshot();
      expect((await runPlatformMigrations(seq)).applied).toEqual([]);
      expect(await snapshot()).toEqual(afterApply);
    });

    test('a platform database with no `users` table at all: nothing to alter, no error (like p013/p014)', async () => {
      await createPlatformDbBefore1I();
      await seq.query('DROP TABLE users');
      await runPlatformMigrations(seq, { targetVersion: 15 });

      const res = await runPlatformMigrations(seq);

      expect(res.applied).toEqual([P016]);
      expect(await appleColumn()).toBeUndefined();
    });

    test('--dry-run writes nothing; a column of another type makes it skip (not recorded, data untouched)', async () => {
      await createPlatformDbBefore1I();
      await runPlatformMigrations(seq, { targetVersion: 15 });
      const before = await snapshot();
      expect((await runPlatformMigrations(seq, { dryRun: true })).wouldRun).toEqual([P016]);
      expect(await snapshot()).toEqual(before);

      await seq.query('ALTER TABLE users ADD COLUMN apple_refresh_token_encrypted INT NULL');
      await seq.query("UPDATE users SET apple_refresh_token_encrypted = 9 WHERE email = 'a@x.test'");
      const conflicted = await snapshot();
      await runPlatformMigrations(seq);
      expect(await snapshot()).toEqual(conflicted);
      const [row] = await seq.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 16', { type: QueryTypes.SELECT });
      expect(Number(row.n)).toBe(0);
    });
  });

  test('a row in an unexpected status is never rewritten (widening keeps every existing value)', async () => {
    await createPlatformDbBefore1I();
    // The live enum already carries a value this code does not know.
    await seq.query("ALTER TABLE users MODIFY COLUMN status ENUM('ACTIVE','INACTIVE','SUSPENDED','LEGACY_X') NOT NULL DEFAULT 'INACTIVE'");
    await seq.query("UPDATE users SET status = 'LEGACY_X' WHERE email = 'c@x.test'");

    await runPlatformMigrations(seq);

    expect(await enumOf('users')).toEqual(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'LEGACY_X', 'PENDING_DELETION', 'DELETED']);
    const [row] = await seq.query("SELECT status FROM users WHERE email = 'c@x.test'", { type: QueryTypes.SELECT });
    expect(row.status).toBe('LEGACY_X');
  });
});
