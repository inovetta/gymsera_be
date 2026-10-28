/**
 * Launch wipe (spec §16): reset-platform-data keeps the allow-list and the named admins, empties the rest, and only
 * drops tenant databases named in `tenants`, only when asked. Runs on scratch databases on the local Docker MySQL (R-19).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const { ALLOWED_TEST_HOSTS } = require('../harness/test-db');
const { runReset } = require('../../src/services/platform-reset.service');

const HOST = process.env.PLATFORM_TEST_DB_HOST || process.env.PLATFORM_DB_HOST || process.env.MYSQL_HOST || 'localhost';
const PORT = parseInt(process.env.PLATFORM_DB_PORT, 10);
const USER = process.env.PLATFORM_TEST_DB_USER || process.env.PLATFORM_DB_USER || process.env.MYSQL_USER || 'root';
const PASS = process.env.PLATFORM_TEST_DB_PASS !== undefined
  ? process.env.PLATFORM_TEST_DB_PASS
  : (process.env.PLATFORM_DB_PASS !== undefined ? process.env.PLATFORM_DB_PASS : '');

const PLATFORM = 'gymsera_test_reset_platform';
const TENANT_A = 'gymsera_test_reset_tenant_a';
const TENANT_B = 'gymsera_test_reset_tenant_b';
const BYSTANDER = 'gymsera_test_reset_bystander';
const ALL = [PLATFORM, TENANT_A, TENANT_B, BYSTANDER];
const ADMIN = 'owner.admin@gymsera.test';
const OTHER_ADMIN = 'other.admin@gymsera.test';

let admin;
let conn;
let logDir;

const config = { database: PLATFORM, host: HOST };
const count = async (table) => (await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``))[0][0].n;
const dbExists = async (name) =>
  (await admin.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [name]))[0].length === 1;

async function seed() {
  for (const d of ALL) await admin.query(`DROP DATABASE IF EXISTS \`${d}\``);
  for (const d of ALL) await admin.query(`CREATE DATABASE \`${d}\``);
  conn = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS, database: PLATFORM });
  await conn.query('CREATE TABLE schema_migrations (name VARCHAR(100) PRIMARY KEY)');
  await conn.query('CREATE TABLE billing_plans (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE billing_plan_prices (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE platform_packages (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE cities (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE areas (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE notifications (id INT PRIMARY KEY)');
  await conn.query('CREATE TABLE refresh_tokens (id INT PRIMARY KEY, user_id INT)');
  await conn.query('CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100), role VARCHAR(30))');
  // The real column names (Tenant model, underscored: true). NEW-136: this table used `dbName`, so the test passed
  // while the service could not read the real `tenants.db_name`.
  await conn.query('CREATE TABLE tenants (id INT PRIMARY KEY, tenant_code VARCHAR(50), status VARCHAR(20), db_name VARCHAR(100))');
  for (const t of ['schema_migrations']) await conn.query(`INSERT INTO ${t} VALUES ('001'),('002')`);
  for (const t of ['billing_plans', 'billing_plan_prices', 'platform_packages', 'cities', 'areas']) {
    await conn.query(`INSERT INTO ${t} VALUES (1),(2),(3)`);
  }
  await conn.query('INSERT INTO notifications VALUES (1),(2)');
  await conn.query('INSERT INTO refresh_tokens VALUES (1,1),(2,2),(3,3)');
  await conn.query(
    'INSERT INTO users VALUES (1,?,?),(2,?,?),(3,\'member@gymsera.test\',\'MEMBER\'),(4,\'host@gymsera.test\',\'GYM_HOST\')',
    [ADMIN, 'PLATFORM_ADMIN', OTHER_ADMIN, 'PLATFORM_ADMIN']
  );
  await conn.query(
    'INSERT INTO tenants VALUES (1,\'GYM-RESETA\',\'ACTIVE\',?),(2,\'GYM-RESETB\',\'PROVISIONING_FAILED\',?)',
    [TENANT_A, TENANT_B]
  );
  for (const d of [TENANT_A, TENANT_B, BYSTANDER]) await admin.query(`CREATE TABLE \`${d}\`.members (id INT)`);
}

beforeAll(async () => {
  if (!ALLOWED_TEST_HOSTS.has(HOST)) throw new Error(`R-19: refusing to run against host ${HOST}`);
  admin = await mysql.createConnection({ host: HOST, port: PORT, user: USER, password: PASS });
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-log-'));
});

beforeEach(async () => {
  if (conn) await conn.end();
  await seed();
});

afterAll(async () => {
  if (conn) await conn.end();
  for (const d of ALL) await admin.query(`DROP DATABASE IF EXISTS \`${d}\``);
  await admin.end();
  fs.rmSync(logDir, { recursive: true, force: true });
});

const run = (extra = {}) => runReset({ conn, adminConn: admin, config, keepAdmins: [ADMIN], logDir, echo: false, ...extra });

describe('reset-platform-data', () => {
  test('is a dry run by default: reports the plan and changes nothing', async () => {
    const r = await run();
    expect(r.mode).toBe('DRY_RUN');
    expect(await count('notifications')).toBe(2);
    expect(await count('users')).toBe(4);
    expect(await dbExists(TENANT_A)).toBe(true);
    expect(r.plan.tables.find((t) => t.name === 'notifications')).toMatchObject({ action: 'EMPTY', rows: 2 });
    expect(r.plan.users).toMatchObject({ keep: 1, remove: 3 });
  });

  test('--keep-admin is required, and every named admin must exist and be a PLATFORM_ADMIN', async () => {
    await expect(run({ keepAdmins: [] })).rejects.toMatchObject({ code: 'keep_admin_required' });
    await expect(run({ keepAdmins: ['nobody@gymsera.test'] })).rejects.toMatchObject({ code: 'keep_admin_not_found' });
    await expect(run({ keepAdmins: ['host@gymsera.test'] })).rejects.toMatchObject({ code: 'keep_admin_not_admin' });
    expect(await count('users')).toBe(4);
  });

  test('--confirm needs the exact database name and host', async () => {
    await expect(run({ confirm: true })).rejects.toMatchObject({ code: 'target_required' });
    await expect(run({ confirm: true, db: 'something_else', host: HOST })).rejects.toMatchObject({ code: 'db_mismatch' });
    await expect(run({ confirm: true, db: PLATFORM, host: 'db.example.invalid' })).rejects.toMatchObject({ code: 'host_mismatch' });
    expect(await count('notifications')).toBe(2);
    expect(await count('users')).toBe(4);
  });

  test('apply keeps the allow-list and the named admin, empties the rest, leaves tenant databases alone', async () => {
    const r = await run({ confirm: true, db: PLATFORM, host: HOST });
    expect(r.mode).toBe('APPLY');
    expect(await count('schema_migrations')).toBe(2);
    for (const t of ['billing_plans', 'billing_plan_prices', 'platform_packages', 'cities', 'areas']) {
      expect(await count(t)).toBe(3);
    }
    expect(await count('notifications')).toBe(0);
    expect(await count('refresh_tokens')).toBe(0);
    expect(await count('tenants')).toBe(0);
    const [users] = await conn.query('SELECT email FROM users');
    expect(users.map((u) => u.email)).toEqual([ADMIN]);
    // Tenant databases are not touched without --drop-tenant-databases.
    expect(await dbExists(TENANT_A)).toBe(true);
    expect(await dbExists(TENANT_B)).toBe(true);
    expect(r.leftInPlace.sort()).toEqual([TENANT_A, TENANT_B]);
  });

  test('--drop-tenant-databases drops only the databases named in tenants', async () => {
    const r = await run({ confirm: true, db: PLATFORM, host: HOST, dropTenantDatabases: true });
    expect(r.droppedDatabases.sort()).toEqual([TENANT_A, TENANT_B]);
    expect(await dbExists(TENANT_A)).toBe(false);
    expect(await dbExists(TENANT_B)).toBe(false);
    expect(await dbExists(BYSTANDER)).toBe(true);
    expect(await dbExists(PLATFORM)).toBe(true);
  });

  test('the plan lists each tenant_code with the db_name read from tenants (NEW-136)', async () => {
    const r = await run();
    expect(r.plan.tenants).toEqual([
      { id: 1, tenantCode: 'GYM-RESETA', status: 'ACTIVE', dbName: TENANT_A },
      { id: 2, tenantCode: 'GYM-RESETB', status: 'PROVISIONING_FAILED', dbName: TENANT_B },
    ]);
  });

  test('never works a name out from tenant_code: a tenant with no db_name keeps the database the naming rule would give (R-79)', async () => {
    // buildDbName('test_reset_bystander') is BYSTANDER; the row does not name it, so it is not the wipe's to drop.
    await conn.query('INSERT INTO tenants VALUES (3,\'test_reset_bystander\',\'PROVISIONING_FAILED\',NULL)');
    const r = await run({ confirm: true, db: PLATFORM, host: HOST, dropTenantDatabases: true });
    expect(r.droppedDatabases.sort()).toEqual([TENANT_A, TENANT_B]);
    expect(await dbExists(BYSTANDER)).toBe(true);
  });

  test('never drops a system schema, the platform database or an oddly named database from the tenants table', async () => {
    await conn.query('UPDATE tenants SET db_name = \'mysql\' WHERE id = 1');
    await conn.query('UPDATE tenants SET db_name = ? WHERE id = 2', [PLATFORM]);
    const r = await run({ confirm: true, db: PLATFORM, host: HOST, dropTenantDatabases: true });
    expect(r.droppedDatabases).toEqual([]);
    expect(r.leftInPlace.sort()).toEqual([PLATFORM, 'mysql'].sort());
    expect(await dbExists('mysql')).toBe(true);
    expect(await dbExists(PLATFORM)).toBe(true);
  });

  test('writes a log of what it removed that holds no e-mail addresses', async () => {
    const r = await run({ confirm: true, db: PLATFORM, host: HOST, dropTenantDatabases: true });
    const text = fs.readFileSync(r.log.file, 'utf8');
    expect(text).toContain('"event":"emptied"');
    expect(text).toContain('"event":"tenant_database_dropped"');
    expect(text).not.toMatch(/@gymsera\.test/);
  });
});
