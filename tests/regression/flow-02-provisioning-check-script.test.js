/**
 * FLOW-02 — read-only check script for tenants the old provisioning left
 * half-done or duplicated (`gymsera-flow02-provisioning-check.js`).
 *
 * Classification is tested on plain data; then the real script runs in a child
 * process (network jail) against the local test databases and must change nothing.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { Tenant, GymListing, TenantSubscription, City } = require('../../src/models/platform');
const { classify, dbNameFor } = require('../../gymsera-flow02-provisioning-check');

const DBS = ['gymsera_test_f02chk_b', 'gymsera_test_f02chk_d', 'gymsera_test_f02chk_orphan'];

beforeAll(async () => {
  await setupTestDatabases();
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of DBS) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

describe('classify', () => {
  const base = { listings: [], planCounts: {}, databases: [], tenantDbs: {}, platformDb: 'gymsera' };
  const t = (over) => ({ id: 't1', tenant_code: 'GYM-1', status: 'ACTIVE', db_name: null, has_connection: true, ...over });

  test('uses the same database name rule as provisioning', () => {
    expect(dbNameFor('GYM-AB12')).toBe('gymsera_gym_ab12');
  });

  test('APPROVED with / without its database', () => {
    const f = classify({ ...base, tenants: [t({ status: 'APPROVED' }), t({ id: 't2', tenant_code: 'GYM-2', status: 'APPROVED' })], databases: ['gymsera_gym_2'] });
    expect(f.find((x) => x.id === 't1').verdicts).toEqual(['STUCK_APPROVED_NO_DB']);
    expect(f.find((x) => x.id === 't2').verdicts).toEqual(['STUCK_APPROVED_PARTIAL']);
  });

  test('ACTIVE without listing / plan / connection string', () => {
    const [f] = classify({ ...base, tenants: [t({ has_connection: false })] });
    expect(f.verdicts).toEqual(['ACTIVE_NO_CONNECTION', 'ACTIVE_NO_LISTING', 'ACTIVE_NO_PLAN']);
  });

  test('two listings created minutes apart = a double approval; far apart = a second organization', () => {
    const tenants = [t(), t({ id: 't2', tenant_code: 'GYM-2' })];
    const listings = [
      { tenant_id: 't1', created_at: '2026-09-01 10:00:00' }, { tenant_id: 't1', created_at: '2026-09-01 10:00:03' },
      { tenant_id: 't2', created_at: '2026-09-01 10:00:00' }, { tenant_id: 't2', created_at: '2026-09-20 10:00:00' },
    ];
    const f = classify({ ...base, tenants, listings, planCounts: { t1: 1, t2: 1 } });
    expect(f.map((x) => [x.id, x.verdicts])).toEqual([['t1', ['DUPLICATE_LISTING_AT_APPROVAL']]]);
  });

  test('tenant DB contents, unreadable DB, orphan databases; a healthy tenant is not listed', () => {
    const tenants = [
      t(), t({ id: 't2', tenant_code: 'GYM-2' }), t({ id: 't3', tenant_code: 'GYM-3' }), t({ id: 't4', tenant_code: 'GYM-4', status: 'REJECTED' }),
    ];
    const listings = ['t1', 't2', 't3'].map((id) => ({ tenant_id: id, created_at: '2026-09-01 10:00:00' }));
    const f = classify({
      ...base,
      tenants,
      listings,
      planCounts: { t1: 1, t2: 1, t3: 1 },
      databases: ['gymsera', 'gymsera_gym_1', 'gymsera_gym_2', 'gymsera_gym_3', 'gymsera_gym_4', 'gymsera_leftover'],
      tenantDbs: {
        gymsera_gym_1: { gyms: 1, branchesWithoutListing: 0 },
        gymsera_gym_2: { gyms: 2, branchesWithoutListing: 1 },
        gymsera_gym_3: { error: 'ER_TABLEACCESS_DENIED_ERROR' },
        gymsera_gym_4: { gyms: 1, branchesWithoutListing: 0 },
      },
    });
    expect(f.map((x) => [x.id || x.dbName, x.verdicts])).toEqual([
      ['t2', ['DUPLICATE_GYM', 'BRANCH_WITHOUT_LISTING']],
      ['t3', ['UNREACHABLE_TENANT_DB']],
      ['gymsera_gym_4', ['ORPHAN_DATABASE']], // its tenant was REJECTED
      ['gymsera_leftover', ['ORPHAN_DATABASE']],
    ]);
  });
});

describe('the script against real databases', () => {
  test('lists each case, inside READ ONLY transactions, and changes nothing', async () => {
    const conn = await getAdminConnection();
    const stuckNoDb = await factories.createTenant({ tenantCode: 'test_f02chk_a', status: 'APPROVED', connectionStringEncrypted: null });
    const stuckPartial = await factories.createTenant({ tenantCode: 'test_f02chk_b', status: 'APPROVED', connectionStringEncrypted: null });
    await conn.query('CREATE DATABASE IF NOT EXISTS `gymsera_test_f02chk_b`');
    const activeBare = await factories.createTenant({ tenantCode: 'test_f02chk_c', status: 'ACTIVE' });
    const activeDup = await factories.createTenant({ tenantCode: 'test_f02chk_d', status: 'ACTIVE' });
    await factories.createGymListing(activeDup.id);
    await factories.createTenantSubscription(activeDup.id);
    await conn.query('CREATE DATABASE IF NOT EXISTS `gymsera_test_f02chk_d`');
    await conn.query('CREATE TABLE `gymsera_test_f02chk_d`.gyms (id CHAR(36) PRIMARY KEY)');
    await conn.query("INSERT INTO `gymsera_test_f02chk_d`.gyms VALUES ('g1'), ('g2')");
    await conn.query('CREATE TABLE `gymsera_test_f02chk_d`.branches (id CHAR(36) PRIMARY KEY, gym_listing_id CHAR(36) NULL)');
    await conn.query("INSERT INTO `gymsera_test_f02chk_d`.branches VALUES ('b1', NULL)");
    await conn.query('CREATE DATABASE IF NOT EXISTS `gymsera_test_f02chk_orphan`');

    const snapshot = async () => JSON.stringify([
      await Tenant.findAll({ order: [['id', 'ASC']], raw: true }),
      await GymListing.findAll({ order: [['id', 'ASC']], raw: true }),
      await TenantSubscription.findAll({ order: [['id', 'ASC']], raw: true }),
      (await conn.query('SELECT * FROM `gymsera_test_f02chk_d`.gyms ORDER BY id'))[0],
      (await conn.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera%' ORDER BY SCHEMA_NAME"))[0],
    ]);
    const before = await snapshot();

    const root = path.join(__dirname, '..', '..');
    const res = spawnSync(process.execPath, ['-r', path.join(root, 'tests', 'harness', 'no-network.js'), 'gymsera-flow02-provisioning-check.js'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CHK_HOST: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost',
        CHK_PORT: process.env.PLATFORM_DB_PORT,
        CHK_USER: process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root',
        CHK_PASSWORD: process.env.PLATFORM_TEST_DB_PASS ?? process.env.PLATFORM_DB_PASS ?? '',
        CHK_PLATFORM_DB: process.env.PLATFORM_DB_NAME,
      },
    });
    expect(res.stderr).not.toMatch(/Check failed/);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/p013 applied: yes/);
    expect(res.stdout).toMatch(new RegExp(`tenant=${stuckNoDb.id} .*→ STUCK_APPROVED_NO_DB`));
    expect(res.stdout).toMatch(new RegExp(`tenant=${stuckPartial.id} .*dbExists=true.*→ STUCK_APPROVED_PARTIAL`));
    expect(res.stdout).toMatch(new RegExp(`tenant=${activeBare.id} .*→ ACTIVE_NO_LISTING, ACTIVE_NO_PLAN`));
    expect(res.stdout).toMatch(new RegExp(`tenant=${activeDup.id} .*gyms=2 branchesWithoutListing=1 .*→ DUPLICATE_GYM, BRANCH_WITHOUT_LISTING`));
    expect(res.stdout).toMatch(/database=gymsera_test_f02chk_orphan .*→ ORPHAN_DATABASE/);
    expect(res.stdout).not.toMatch(/@/); // no e-mail addresses or connection strings
    expect(await snapshot()).toBe(before);
  });

  test('no default database user or password: missing CHK_USER / CHK_PASSWORD → exit 2 before connecting', () => {
    const root = path.join(__dirname, '..', '..');
    const env = { ...process.env, CHK_HOST: '127.0.0.1', CHK_PORT: '1' };
    delete env.CHK_USER;
    delete env.CHK_PASSWORD;
    const res = spawnSync(process.execPath, ['-r', path.join(root, 'tests', 'harness', 'no-network.js'), 'gymsera-flow02-provisioning-check.js'], {
      cwd: root, encoding: 'utf8', env,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Set CHK_USER and CHK_PASSWORD/);
  });
});
