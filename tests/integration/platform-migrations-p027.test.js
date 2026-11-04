/**
 * Platform migration p027 (P7b, R-94, NEW-217): payout_accounts, with each tenant's saved bank
 * details (tenants.payment_details_json) copied in as its tenant default. Proof: the preview and
 * the runner's dry-run write nothing; apply creates the table and one default per tenant with
 * details (keeping payment_details_updated_at, SEC-13); empty or unreadable values are not
 * copied; an existing default is never overwritten; the old column is kept; a re-run is a no-op.
 *
 * Scratch database: `gymsera_test_platform_mig_p027` (R-19).
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS, runPlatformMigrations } = require('../../src/database/platform-migrations');
const { planPayoutAccountBackfill } = require('../../src/database/payout-accounts-backfill');
const { printPlan } = require('../../src/scripts/preview-payout-accounts-backfill');

const SCRATCH_DB = 'gymsera_test_platform_mig_p027';
const P027 = 'p027_payout_accounts';
const T = (n) => `00000000-0000-0000-0000-00000000000${n}`;

describe('Platform migration p027 (payout_accounts + tenant default backfill)', () => {
  let seq;

  const hasTable = async (name) =>
    (await seq.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', {
      replacements: [name],
      type: QueryTypes.SELECT,
    })).length > 0;
  const accounts = () =>
    seq.query('SELECT tenant_id AS tenantId, organization_id AS organizationId, scope_key AS scopeKey, provider, status, details_json AS details, DATE_FORMAT(details_updated_at, \'%Y-%m-%d %H:%i:%s\') AS updatedAt FROM payout_accounts ORDER BY tenant_id', { type: QueryTypes.SELECT });
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

  beforeAll(async () => {
    assertTestEnvironmentSafety({ databases: [SCRATCH_DB] });
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    seq = new Sequelize(SCRATCH_DB, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
      host: process.env.PLATFORM_DB_HOST || 'localhost',
      port: Number(process.env.PLATFORM_DB_PORT),
      dialect: 'mysql',
      logging: false,
    });
    await seq.query(
      'CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    for (const mig of PLATFORM_MIGRATIONS.filter((m) => m.version <= 26)) {
      await seq.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, NOW())', { replacements: [mig.version, mig.name] });
    }
    await seq.query(
      'CREATE TABLE tenants (id CHAR(36) PRIMARY KEY, payment_details_json JSON NULL, payment_details_updated_at DATETIME NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );
    await seq.query(
      `INSERT INTO tenants VALUES
        ('${T(1)}', '{"bankName":"Meezan","accountTitle":"Alpha","accountNumber":"0012345678"}', '2026-10-01 10:00:00'),
        ('${T(2)}', '{"jazzCashNumber":"03001234567"}', NULL),
        ('${T(3)}', '{"bankName":"  ","iban":""}', NULL),
        ('${T(4)}', '{}', NULL),
        ('${T(5)}', NULL, NULL)`
    );
  });

  afterAll(async () => {
    if (seq) await seq.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``).catch(() => {});
    await teardownTestDatabases();
  });

  test('p027 exists at version 27 and documents preview, backup and rollback', () => {
    const mig = PLATFORM_MIGRATIONS.find((m) => m.version === 27);
    expect(mig.name).toBe(P027);
    const source = require('fs').readFileSync(require.resolve('../../src/database/platform-migrations'), 'utf8');
    const block = source.slice(source.indexOf(P027));
    expect(block).toMatch(/PREVIEW/);
    expect(block).toMatch(/BACKUP/);
    expect(block).toMatch(/ROLLBACK/);
  });

  test('preview: the plan lists what would be copied, prints field names but never values, and writes nothing', async () => {
    const plan = await planPayoutAccountBackfill(seq);
    expect(plan.tenantsScanned).toBe(4);
    expect(plan.copy.map((c) => c.tenantId)).toEqual([T(1), T(2)]);
    expect(plan.copy[0].keys).toEqual(['accountNumber', 'accountTitle', 'bankName']);
    expect(plan.emptyOrUnreadable.map((r) => r.tenantId)).toEqual([T(3), T(4)]);
    expect(plan.alreadyHaveDefault).toEqual([]);

    const lines = [];
    printPlan(plan, (l) => lines.push(l));
    const out = lines.join('\n');
    expect(out).toContain(T(1));
    expect(out).toContain('accountNumber');
    expect(out).not.toContain('0012345678');
    expect(out).not.toContain('03001234567');
    expect(await hasTable('payout_accounts')).toBe(false);
  });

  test('runner dry-run lists p027 and writes nothing', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 27, dryRun: true });
    expect(res.wouldRun).toEqual([P027]);
    expect(await hasTable('payout_accounts')).toBe(false);
  });

  test('apply: table created, tenant defaults copied with their SEC-13 timestamp, old column kept', async () => {
    const res = await runPlatformMigrations(seq, { targetVersion: 27 });
    expect(res.applied).toEqual([P027]);

    const rows = await accounts();
    expect(rows.map((r) => r.tenantId)).toEqual([T(1), T(2)]);
    expect(rows[0]).toMatchObject({ organizationId: null, scopeKey: 'TENANT', provider: 'BANK_TRANSFER', status: 'ACTIVE' });
    expect(parse(rows[0].details)).toEqual({ bankName: 'Meezan', accountTitle: 'Alpha', accountNumber: '0012345678' });
    // Copied as text: the machine's time zone (UTC+5 on the dev Mac) must not shift it.
    expect(rows[0].updatedAt).toBe('2026-10-01 10:00:00');
    expect(rows[1].updatedAt).toBeNull();

    const [kept] = await seq.query('SELECT payment_details_json AS d FROM tenants WHERE id = ?', { replacements: [T(1)], type: QueryTypes.SELECT });
    expect(parse(kept.d).bankName).toBe('Meezan');
  });

  test('the table allows one tenant default and one row per organization', async () => {
    const insert = (id, tenant, org, scope) =>
      seq.query(
        'INSERT INTO payout_accounts (id, tenant_id, organization_id, scope_key, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'BANK_TRANSFER\', \'ACTIVE\', NOW(), NOW())',
        { replacements: [id, tenant, org, scope] }
      );
    await expect(insert(T(7), T(1), null, 'TENANT')).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await insert(T(8), T(1), T(9), T(9));
    await expect(insert(T(6), T(1), T(9), T(9))).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    await seq.query('DELETE FROM payout_accounts WHERE organization_id IS NOT NULL');
  });

  test('re-run: recorded, nothing copied twice; a later run never overwrites an existing default', async () => {
    const again = await runPlatformMigrations(seq, { targetVersion: 27 });
    expect(again.applied).toEqual([]);

    // Force the up() again (as if schema_migrations were lost) after the host changed their details.
    await seq.query('UPDATE payout_accounts SET details_json = \'{"bankName":"Changed after deploy"}\' WHERE tenant_id = ?', { replacements: [T(1)] });
    await seq.query('DELETE FROM schema_migrations WHERE version = 27');
    const plan = await planPayoutAccountBackfill(seq);
    expect(plan.alreadyHaveDefault).toEqual([T(1), T(2)]);
    expect(plan.copy).toEqual([]);
    await runPlatformMigrations(seq, { targetVersion: 27 });
    const rows = await accounts();
    expect(rows).toHaveLength(2);
    expect(parse(rows[0].details)).toEqual({ bankName: 'Changed after deploy' });
  });
});
