/**
 * AUTH-07 / NEW-34 — read-only check script for data the old "deletion" and the
 * reject-during-provisioning gap may already have left (`gymsera-auth07-deletion-check.js`).
 *
 * Classification is tested on plain data; then the real script runs in a child process
 * (network jail) against the local test databases and must change nothing and print no
 * personal data.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { classify } = require('../../gymsera-auth07-deletion-check');

const NOW = new Date('2030-06-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const DBS = ['gymsera_test_a07chk_rej_old', 'gymsera_test_a07chk_rej_new'];

describe('classify', () => {
  const u = (over) => ({ id: 'u1', status: 'ACTIVE', is_verified: 1, anonymized: 1, ...over });
  const t = (over) => ({ id: 't1', tenant_code: 'GYM-1', status: 'ACTIVE', db_name: null, owner_user_id: 'u1', rejected_at: null, updated_at: NOW, ...over });
  const run = (data) => classify({ users: [], tenants: [], databases: [], now: NOW, ...data });

  test('a verified INACTIVE user is a legacy deletion request; an unverified one is just a new sign-up', () => {
    const f = run({ users: [u({ id: 'a', status: 'INACTIVE' }), u({ id: 'b', status: 'INACTIVE', is_verified: 0 })] });
    expect(f.map((x) => [x.id, x.verdicts])).toEqual([['a', ['LEGACY_DELETION_REQUEST']]]);
  });

  test('...and it is flagged louder when that user still owns a live gym', () => {
    const f = run({ users: [u({ status: 'INACTIVE' })], tenants: [t({ status: 'ACTIVE' })] });
    expect(f[0]).toMatchObject({ ownsTenant: true, liveTenants: 1, verdicts: ['LEGACY_DELETION_REQUEST', 'LEGACY_DELETION_LIVE_TENANT'] });
  });

  test('a REJECTED tenant whose database still exists is reported with its age; only >= 90 days is eligible', () => {
    const f = run({
      tenants: [
        t({ id: 'old', tenant_code: 'GYM-OLD', status: 'REJECTED', rejected_at: new Date(NOW - 100 * DAY) }),
        t({ id: 'new', tenant_code: 'GYM-NEW', status: 'REJECTED', rejected_at: new Date(NOW - 10 * DAY) }),
        t({ id: 'gone', tenant_code: 'GYM-GONE', status: 'REJECTED', rejected_at: new Date(NOW - 200 * DAY) }),
      ],
      databases: ['gymsera_gym_old', 'gymsera_gym_new'],
    });
    expect(f.map((x) => [x.id, x.eligibleToDrop, x.verdicts])).toEqual([
      ['old', true, ['REJECTED_TENANT_DATABASE']],
      ['new', false, ['REJECTED_TENANT_DATABASE']],
    ]);
  });

  test('after the migrations: a due deletion, a state mismatch, and a DELETED row that was not anonymized', () => {
    const f = run({
      users: [
        u({ id: 'due', status: 'PENDING_DELETION', deletion_scheduled_for: new Date(NOW - DAY) }),
        u({ id: 'mismatch', status: 'PENDING_DELETION', deletion_scheduled_for: new Date(NOW.getTime() + DAY) }),
        u({ id: 'dirty', status: 'DELETED', anonymized: 0 }),
        u({ id: 'clean', status: 'DELETED', anonymized: 1 }),
      ],
      tenants: [t({ id: 'tm', owner_user_id: 'mismatch', status: 'ACTIVE' })],
    });
    const byId = Object.fromEntries(f.map((x) => [x.id, x.verdicts]));
    expect(byId.due).toEqual(['DELETION_DUE']);
    expect(byId.mismatch).toEqual(['DELETION_STATE_MISMATCH']);
    expect(byId.dirty).toEqual(['DELETED_ROW_NOT_ANONYMIZED']);
    expect(byId.clean).toBeUndefined();
  });

  test('healthy data reports nothing', () => {
    expect(run({ users: [u()], tenants: [t()], databases: ['gymsera_gym_1'] })).toEqual([]);
  });
});

describe('the script itself', () => {
  let conn;
  let legacy;
  let legacyOwner;

  beforeAll(async () => {
    await setupTestDatabases();
    conn = await getAdminConnection();
    // A legacy deletion request that owns a live gym, and a rejected tenant with a leftover database.
    legacyOwner = await factories.createUser({ role: 'GYM_HOST', status: 'INACTIVE', email: 'legacy.owner@gymseratest.com', fullName: 'Legacy Person' });
    legacy = await factories.createTenant({ ownerUserId: legacyOwner.id, status: 'ACTIVE' });
    for (const db of DBS) await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\``);
    await factories.createTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 100 * DAY), tenantCode: 'A07CHK-OLD', dbName: DBS[0] });
    await factories.createTenant({ status: 'REJECTED', rejectedAt: new Date(Date.now() - 5 * DAY), tenantCode: 'A07CHK-NEW', dbName: DBS[1] });
  });

  afterAll(async () => {
    for (const db of DBS) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
    await teardownTestDatabases();
  });

  const root = path.join(__dirname, '..', '..');
  const baseEnv = () => ({
    ...process.env,
    CHK_HOST: process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost',
    CHK_PORT: process.env.PLATFORM_DB_PORT,
    CHK_USER: process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root',
    CHK_PASSWORD: process.env.PLATFORM_TEST_DB_PASS ?? process.env.PLATFORM_DB_PASS ?? '',
    CHK_PLATFORM_DB: process.env.PLATFORM_DB_NAME,
  });
  const runScript = (env) =>
    spawnSync(process.execPath, ['-r', path.join(root, 'tests', 'harness', 'no-network.js'), 'gymsera-auth07-deletion-check.js'], { cwd: root, encoding: 'utf8', env });

  test('lists the legacy request, the live-gym owner and the orphan databases — changes NOTHING and prints no personal data', async () => {
    const snapshot = async () => JSON.stringify([
      (await conn.query(`SELECT * FROM \`${process.env.PLATFORM_DB_NAME}\`.users ORDER BY id`))[0],
      (await conn.query(`SELECT * FROM \`${process.env.PLATFORM_DB_NAME}\`.tenants ORDER BY id`))[0],
      (await conn.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'gymsera%' ORDER BY SCHEMA_NAME"))[0],
      (await conn.query(`SELECT COUNT(*) AS n FROM \`${process.env.PLATFORM_DB_NAME}\`.platform_audit_logs`).catch(() => [[0]]))[0],
    ]);
    const before = await snapshot();

    const res = runScript(baseEnv());

    expect(res.stderr).not.toMatch(/Check failed/);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/p014\/p015 applied: yes/);
    expect(res.stdout).toMatch(new RegExp(`user=${legacyOwner.id} status=INACTIVE ownsTenant=true liveTenants=1  → LEGACY_DELETION_REQUEST, LEGACY_DELETION_LIVE_TENANT`));
    expect(res.stdout).toMatch(/code=A07CHK-OLD status=REJECTED .*rejectedDaysAgo=100 eligibleToDrop=true  → REJECTED_TENANT_DATABASE/);
    expect(res.stdout).toMatch(/code=A07CHK-NEW status=REJECTED .*rejectedDaysAgo=5 eligibleToDrop=false  → REJECTED_TENANT_DATABASE/);
    expect(res.stdout).not.toMatch(/@/); // no e-mail addresses
    expect(res.stdout).not.toContain('Legacy Person'); // no names
    expect(res.stdout).not.toContain(legacy.phone || '+92300'); // no phones
    expect(await snapshot()).toBe(before);
  });

  test('no default database user or password: missing CHK_USER / CHK_PASSWORD → exit 2 before connecting', () => {
    const env = { ...process.env, CHK_HOST: '127.0.0.1', CHK_PORT: '1' };
    delete env.CHK_USER;
    delete env.CHK_PASSWORD;
    const res = runScript(env);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Set CHK_USER and CHK_PASSWORD/);
  });

  test('every connection is READ ONLY and the file contains no write statement', () => {
    const src = require('fs').readFileSync(path.join(root, 'gymsera-auth07-deletion-check.js'), 'utf8');
    expect(src).toMatch(/SET SESSION TRANSACTION READ ONLY/);
    expect(src).toMatch(/START TRANSACTION READ ONLY/);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\s/);
  });
});
