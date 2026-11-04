/**
 * NEW-203 (P2): after the tenant MySQL user's password changes (secrets rotation row 1), every
 * tenants.connection_string_encrypted still holds the old password and no tool rebuilt them.
 *
 * src/scripts/rebuild-tenant-connection-strings.js: dry run by default (read-only), --apply writes.
 * Rules proved here:
 *  - only the password changes; user, host, port and database name are kept exactly as stored
 *    (R-79: a database name is never composed or guessed);
 *  - a row whose database name differs from tenants.db_name is refused, not "fixed";
 *  - a row that uses another MySQL user (R-25 leftovers) is reported and left alone;
 *  - every rebuilt string must connect (SELECT 1) before anything is written;
 *  - any failure writes nothing (one transaction);
 *  - no password is ever printed.
 *
 * Runs against the local test MySQL only (R-19), with a throwaway MySQL user.
 */
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { encrypt, decrypt } = require('../../src/utils/crypto.utils');
const { Tenant } = require('../../src/models/platform');
const tool = require('../../src/scripts/rebuild-tenant-connection-strings');

const DB = 'gymsera_test_tenant_1';
const USER = 'gymsera_new203';
const OLD_PASS = 'old-pass:with@chars';
const NEW_PASS = 'new-pass/with#chars%';
const host = process.env.TENANT_DB_HOST || '127.0.0.1';
const port = process.env.TENANT_DB_PORT || '3308';
const url = (user, pass, db = DB) => `mysql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;

describe('NEW-203 rebuildUrl (pure)', () => {
  it('changes only the password and keeps user, host, port and database', () => {
    const next = tool.rebuildUrl('mysql://app:old@db.example:3307/gymsera_t_abc', { password: 'n@w/pass' });
    expect(next).toBe('mysql://app:n%40w%2Fpass@db.example:3307/gymsera_t_abc');
  });

  it('reads the stored parts without guessing', () => {
    expect(tool.parseConnUrl('mysql://app%40x:p%3Aw@h:3306/gymsera_t_1')).toEqual({
      user: 'app@x', password: 'p:w', host: 'h', port: '3306', database: 'gymsera_t_1',
    });
  });
});

describe('NEW-203 rebuild-tenant-connection-strings (test MySQL)', () => {
  let admin;
  let tenant;
  let other;
  let pending;
  let logs;
  const log = (line) => logs.push(line);
  const env = () => ({ ...process.env, TENANT_DB_USER: USER, TENANT_DB_PASS: NEW_PASS });
  // Only this test's tenants (the tool's --tenant filter); other rows in the test database are not touched.
  const ids = () => [tenant.id, other.id, pending.id];

  beforeAll(async () => {
    await setupTestDatabases();
    admin = await getAdminConnection();
    await admin.query(`DROP USER IF EXISTS '${USER}'@'%'`);
    await admin.query(`CREATE USER '${USER}'@'%' IDENTIFIED BY ?`, [OLD_PASS]);
    await admin.query(`GRANT SELECT ON \`${DB}\`.* TO '${USER}'@'%'`);
  });

  afterAll(async () => {
    await admin.query(`DROP USER IF EXISTS '${USER}'@'%'`).catch(() => {});
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    logs = [];
    await admin.query(`ALTER USER '${USER}'@'%' IDENTIFIED BY ?`, [OLD_PASS]);
    tenant = await factories.createTenant({ dbName: DB, connectionStringEncrypted: encrypt(url(USER, OLD_PASS)) });
    other = await factories.createTenant({ dbName: DB, connectionStringEncrypted: encrypt(url('root', '')) });
    pending = await factories.createTenant({ connectionStringEncrypted: 'PENDING_PROVISIONING' });
    // The owner changed the MySQL password (runbook row 1, step 1).
    await admin.query(`ALTER USER '${USER}'@'%' IDENTIFIED BY ?`, [NEW_PASS]);
  });

  const stored = async (t) => decrypt((await Tenant.findByPk(t.id)).connectionStringEncrypted);

  it('dry run: reports, checks the new string connects, writes nothing, prints no password', async () => {
    const result = await tool.run({ apply: false, env: env(), log, tenantIds: ids() });
    expect(result).toMatchObject({ applied: false, toRebuild: 1, otherUser: 1, notProvisioned: 1, failures: [] });
    expect(await stored(tenant)).toBe(url(USER, OLD_PASS));
    const out = logs.join('\n');
    expect(out).toContain(tenant.tenantCode);
    expect(out).toContain(`${host}:${port}/${DB}`);
    for (const secret of [OLD_PASS, NEW_PASS, encodeURIComponent(OLD_PASS), encodeURIComponent(NEW_PASS)]) {
      expect(out).not.toContain(secret);
    }
  });

  it('--apply rewrites only the tenant-user rows with the new password; the database name is kept', async () => {
    const result = await tool.run({ apply: true, env: env(), log, tenantIds: ids() });
    expect(result).toMatchObject({ applied: true, toRebuild: 1, failures: [] });
    expect(await stored(tenant)).toBe(url(USER, NEW_PASS));
    expect(await stored(other)).toBe(url('root', ''));
    expect((await Tenant.findByPk(pending.id)).connectionStringEncrypted).toBe('PENDING_PROVISIONING');
    // A second run finds nothing to do.
    const again = await tool.run({ apply: true, env: env(), log, tenantIds: ids() });
    expect(again).toMatchObject({ toRebuild: 0, alreadyCurrent: 1 });
  });

  it('a wrong new password fails the connection check and nothing is written', async () => {
    const result = await tool.run({ apply: true, env: { ...env(), TENANT_DB_PASS: 'not-the-password' }, log, tenantIds: ids() });
    expect(result.applied).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ tenantCode: tenant.tenantCode, reason: 'cannot_connect' })]);
    expect(await stored(tenant)).toBe(url(USER, OLD_PASS));
  });

  it('a stored database name that differs from tenants.db_name is refused, never corrected (R-79)', async () => {
    await tenant.update({ dbName: 'gymsera_t_somethingelse' }, { hooks: false });
    const result = await tool.run({ apply: true, env: env(), log, tenantIds: ids() });
    expect(result.applied).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ tenantCode: tenant.tenantCode, reason: 'db_name_mismatch' })]);
    expect(await stored(tenant)).toBe(url(USER, OLD_PASS));
  });

  it('a value the current key cannot read stops the run with nothing written', async () => {
    await other.update({ connectionStringEncrypted: 'not-a-ciphertext' }, { hooks: false });
    const result = await tool.run({ apply: true, env: env(), log, tenantIds: ids() });
    expect(result.applied).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ tenantCode: other.tenantCode, reason: 'unreadable' })]);
    expect(await stored(tenant)).toBe(url(USER, OLD_PASS));
  });

  it('refuses to run without TENANT_DB_USER and TENANT_DB_PASS', async () => {
    await expect(tool.run({ apply: false, env: { ...process.env, TENANT_DB_USER: '', TENANT_DB_PASS: undefined }, log, tenantIds: ids() }))
      .rejects.toThrow('TENANT_DB_USER');
  });
});
