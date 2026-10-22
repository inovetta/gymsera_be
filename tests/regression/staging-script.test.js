/**
 * Staging test script (scripts/staging): refuses unless told it is staging, never drops anything but its own
 * restore_drill_* database, and its checks report real findings. Database parts run on the local Docker MySQL (R-19).
 */
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');
const { stagingRefusals, assertStaging } = require('../../scripts/staging/lib/guard');
const { verifySandboxPurchases, auditActiveTenants, reconcileBilling } = require('../../scripts/staging/lib/checks');
const drill = require('../../scripts/staging/lib/restore-drill');

const OK_ENV = { GYMSERA_ENV: 'staging', NODE_ENV: 'staging', STAGING_DB_HOSTS: 'stg-db.internal', PRODUCTION_DB_HOSTS: 'prod-db.internal' };
const OK = { argv: ['--env=staging'], env: OK_ENV, platformHost: 'stg-db.internal' };

describe('staging guard', () => {
  test('passes only when told it is staging on a staging host', () => {
    expect(stagingRefusals(OK)).toEqual([]);
    expect(() => assertStaging(OK)).not.toThrow();
  });

  test.each([
    ['no --env=staging flag', { ...OK, argv: [] }],
    ['no GYMSERA_ENV', { ...OK, env: { ...OK_ENV, GYMSERA_ENV: undefined } }],
    ['GYMSERA_ENV=production', { ...OK, env: { ...OK_ENV, GYMSERA_ENV: 'production' } }],
    ['NODE_ENV=production', { ...OK, env: { ...OK_ENV, NODE_ENV: 'production' } }],
    ['host not in STAGING_DB_HOSTS', { ...OK, platformHost: 'other-db.internal' }],
    ['no STAGING_DB_HOSTS at all', { ...OK, env: { ...OK_ENV, STAGING_DB_HOSTS: '' } }],
    ['host listed as production', { ...OK, env: { ...OK_ENV, STAGING_DB_HOSTS: 'prod-db.internal,stg-db.internal' }, platformHost: 'prod-db.internal' }],
    ['host name contains prod', { ...OK, env: { ...OK_ENV, STAGING_DB_HOSTS: 'db-production.example' }, platformHost: 'db-production.example' }],
    ['no host', { ...OK, platformHost: '' }],
    ['live Stripe key', { ...OK, env: { ...OK_ENV, STRIPE_SECRET_KEY: 'sk_live_x' } }],
    ['Apple production', { ...OK, env: { ...OK_ENV, APPLE_IAP_ENVIRONMENT: 'Production' } }],
  ])('refuses: %s', (label, ctx) => {
    expect(stagingRefusals(ctx).length).toBeGreaterThan(0);
    expect(() => assertStaging(ctx)).toThrow(/REFUSED/);
  });

  test('the CLI exits 2 and runs nothing when it is not told it is staging', () => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'staging', 'staging-check.js');
    const env = { PATH: process.env.PATH, PLATFORM_DB_HOST: 'prod-db.internal', PLATFORM_DB_PASS: '', NODE_ENV: 'production' };
    const res = spawnSync('node', [script, '--restore-drill', '--drop-old-drills'], { env, encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/REFUSED/);
    expect(res.stdout).toBe('');
  });
});

describe('sandbox purchase verifier', () => {
  const play = (p) => ({ getSubscriptionPurchase: async () => p });
  const apple = (t) => ({ getLatestTransaction: async () => t });

  test('accepts store sandbox purchases and reports their state', async () => {
    const r = await verifySandboxPurchases({
      google: { purchaseToken: 't' }, apple: { transactionId: '1' },
      playApi: play({ testPurchase: {}, subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ productId: 'p1' }] }),
      appleApi: apple({ environment: 'Sandbox', productId: 'p2', expiresDate: 1790000000000 }),
    });
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.provider)).toEqual(['GOOGLE', 'APPLE']);
  });

  test('rejects a real (non-sandbox) purchase from either store', async () => {
    const r = await verifySandboxPurchases({
      google: { purchaseToken: 't' }, apple: { transactionId: '1' },
      playApi: play({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [] }),
      appleApi: apple({ environment: 'Production' }),
    });
    expect(r.ok).toBe(false);
    expect(r.findings.every((f) => f.ok === false && f.problem)).toBe(true);
  });

  test('reports a failed lookup and a call with nothing to verify as failures', async () => {
    const boom = { getSubscriptionPurchase: async () => { throw new Error('404'); } };
    expect((await verifySandboxPurchases({ google: { purchaseToken: 'x' }, playApi: boom })).ok).toBe(false);
    expect((await verifySandboxPurchases({ playApi: boom, appleApi: {} })).ok).toBe(false);
  });
});

describe('auditCapacity over active tenants', () => {
  test('passes clean tenants, reports drift, errors and tenants with no database', async () => {
    const tenants = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const r = await auditActiveTenants({
      listActiveTenants: async () => tenants,
      getTenantDb: async (t) => (t.id === 'd' ? null : {}),
      auditCapacity: async (id) => {
        if (id === 'b') return { ok: false, driftedListings: [{}, {}] };
        if (id === 'c') throw new Error('connection refused');
        return { ok: true };
      },
    });
    expect(r).toMatchObject({ ok: false, tenants: 4, passed: 1 });
    expect(r.failed).toEqual([{ tenantId: 'b', error: null, driftedListings: 2 }, { tenantId: 'c', error: 'connection refused' }]);
    expect(r.skipped).toEqual([{ tenantId: 'd', reason: 'no tenant database connection' }]);
  });

  test('is green when every tenant passes', async () => {
    const r = await auditActiveTenants({ listActiveTenants: async () => [{ id: 'a' }], getTenantDb: async () => ({}), auditCapacity: async () => ({ ok: true }) });
    expect(r.ok).toBe(true);
  });
});

describe('billing reconciliation', () => {
  test('flags stuck and failed events and lapsed subscriptions that still entitle', async () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const seen = [];
    const r = await reconcileBilling({
      now,
      countEvents: async (q) => { seen.push(q); return q.status === 'FAILED' ? 1 : 2; },
      countLapsed: async ({ endedBefore }) => { seen.push({ endedBefore }); return 3; },
    });
    expect(r).toEqual({ ok: false, stuckEvents: 2, failedEvents: 1, lapsedStillEntitling: 3 });
    expect(seen[0].receivedBefore.toISOString()).toBe('2026-12-01T11:50:00.000Z');
    expect(seen[2].endedBefore.toISOString()).toBe('2026-11-30T12:00:00.000Z');
  });

  test('is green when nothing is stuck, failed or lapsed', async () => {
    expect((await reconcileBilling({ countEvents: async () => 0, countLapsed: async () => 0 })).ok).toBe(true);
  });
});

describe('restore drill', () => {
  test('only restore_drill_<stamp> names are droppable, and never the source', () => {
    expect(drill.isDrillDatabaseName('restore_drill_20261201_120000')).toBe(true);
    for (const bad of ['gymsera_platform', 'restore_drill_', 'restore_drill_x', 'restore_drill_20261201_120000; DROP', 'mysql', 'my_restore_drill_20261201_120000', '', null, undefined]) {
      expect(drill.isDrillDatabaseName(bad)).toBe(false);
      expect(() => drill.assertDroppable(bad, 'src')).toThrow(/only restore_drill_/);
    }
    expect(() => drill.assertDroppable('restore_drill_20261201_120000', 'restore_drill_20261201_120000')).toThrow(/source/);
    expect(drill.drillName(new Date('2026-12-01T01:02:03Z'))).toBe('restore_drill_20261201_010203');
  });

  describe('on the local Docker MySQL', () => {
    const SRC = 'gymsera_test_stg_drill_src';
    const BYSTANDER = 'gymsera_test_stg_drill_bystander';
    const host = process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost';
    const port = parseInt(process.env.PLATFORM_DB_PORT, 10);
    const user = process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root';
    const password = process.env.PLATFORM_TEST_DB_PASS !== undefined ? process.env.PLATFORM_TEST_DB_PASS : (process.env.PLATFORM_DB_PASS || '');
    let admin;
    // The mysqldump on a developer laptop can be newer than the Docker 5.7 server and fail to log in, so run the
    // client inside the container that hosts the test server (when there is one); CI has a matching client on PATH.
    const container = (() => {
      const r = spawnSync('docker', ['ps', '--filter', 'publish=' + process.env.PLATFORM_DB_PORT, '--format', '{{.Names}}'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.split('\n')[0].trim() : '';
    })();
    const runner = container
      ? (cmd, args, env, input) => {
        const i = args.indexOf('-h');
        const inner = args.slice();
        inner.splice(i, 4, '-h', '127.0.0.1', '-P', '3306');
        const r = spawnSync('docker', ['exec', '-i', '-e', 'MYSQL_PWD=' + (env.MYSQL_PWD || ''), container, cmd, ...inner], { input, maxBuffer: 64 * 1024 * 1024 });
        if (r.status !== 0) throw new Error(cmd + ' failed: ' + String(r.stderr).slice(0, 200));
        return Promise.resolve(r.stdout);
      }
      : undefined;
    const exists = async (n) => (await admin.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [n]))[0].length === 1;

    beforeAll(async () => {
      expect(['localhost', '127.0.0.1', '::1', 'mysql']).toContain(host);
      admin = await mysql.createConnection({ host, port, user, password });
      for (const d of [SRC, BYSTANDER]) await admin.query('DROP DATABASE IF EXISTS ??', [d]);
      await admin.query('CREATE DATABASE ??', [SRC]);
      await admin.query('CREATE DATABASE ??', [BYSTANDER]);
      await admin.query('CREATE TABLE ??.users (id INT PRIMARY KEY, name VARCHAR(20))', [SRC]);
      await admin.query('INSERT INTO ??.users VALUES (1,\'a\'),(2,\'b\'),(3,\'c\')', [SRC]);
    });
    afterAll(async () => {
      for (const d of [SRC, BYSTANDER]) await admin.query('DROP DATABASE IF EXISTS ??', [d]);
      for (const d of await drill.listDrillDatabases(admin)) await drill.dropDrillDatabase(admin, d, SRC);
      await admin.end();
    });

    test('restores into restore_drill_*, compares row counts, then drops only that database', async () => {
      const r = await drill.restoreDrill({ adminConn: admin, server: { host, port, user, password }, sourceDb: SRC, runner });
      expect(r).toMatchObject({ ok: true, tables: 1, mismatches: [], dropped: true });
      expect(drill.isDrillDatabaseName(r.target)).toBe(true);
      expect(await exists(r.target)).toBe(false);
      expect(await exists(SRC)).toBe(true);
      expect(await exists(BYSTANDER)).toBe(true);
    });

    test('--keep leaves the drill database, and listing finds only drill names', async () => {
      const r = await drill.restoreDrill({ adminConn: admin, server: { host, port, user, password }, sourceDb: SRC, runner, keep: true, now: new Date('2026-12-01T00:00:00Z') });
      expect(r.dropped).toBe(false);
      expect(await exists(r.target)).toBe(true);
      const listed = await drill.listDrillDatabases(admin);
      expect(listed).toContain(r.target);
      expect(listed.every(drill.isDrillDatabaseName)).toBe(true);
      await drill.dropDrillDatabase(admin, r.target, SRC);
      expect(await exists(r.target)).toBe(false);
    });

    test('refuses to drop a real database through the drill helper', async () => {
      await expect(drill.dropDrillDatabase(admin, BYSTANDER, SRC)).rejects.toThrow(/only restore_drill_/);
      expect(await exists(BYSTANDER)).toBe(true);
    });
  });
});
