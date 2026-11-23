/**
 * NEW-307 (R-120): organization tables and columns get their names (platform p034), new organization codes
 * start ORG- from one generator (F8), and the launch-wipe plan reads either table name.
 * On MySQL 5.7: a database shaped like production before p034 is renamed in place (data, foreign keys, indexes,
 * comments kept; three stored values renamed); a re-run and a dry run change nothing; a fresh database built by the
 * models plus every migration has only the new names.
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, setupTestDatabases, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS } = require('../../src/database/platform-migrations');
const { planReset } = require('../../src/services/platform-reset.service');
const { generateOrganizationCode, ORGANIZATION_CODE_PREFIX } = require('../../src/utils/organization-code.utils');

const DB = 'gymsera_test_new307_platform';
const p034 = PLATFORM_MIGRATIONS.find((m) => m.name === 'p034_organization_naming');

const connect = (db) =>
  new Sequelize(db, process.env.PLATFORM_DB_USER || 'root', process.env.PLATFORM_DB_PASS || '', {
    host: process.env.PLATFORM_DB_HOST || 'localhost',
    port: Number(process.env.PLATFORM_DB_PORT),
    dialect: 'mysql',
    logging: false,
  });

const tablesOf = async (seq) =>
  (await seq.query('SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = \'BASE TABLE\'',
    { type: QueryTypes.SELECT })).map((r) => r.t).sort();
const columnsOf = async (seq, table) =>
  (await seq.query('SELECT COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    { replacements: [table], type: QueryTypes.SELECT })).map((r) => r.c);
const indexesOf = async (seq, table) =>
  [...new Set((await seq.query('SELECT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    { replacements: [table], type: QueryTypes.SELECT })).map((r) => r.i))]
    .filter((i) => !/_ibfk_\d+$/.test(i)).sort();
const fksOf = (seq, table) =>
  seq.query('SELECT COLUMN_NAME c, REFERENCED_TABLE_NAME t FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL',
    { replacements: [table], type: QueryTypes.SELECT });
const dump = async (seq) => {
  const out = {};
  for (const t of await tablesOf(seq)) {
    const [[ddl]] = await seq.query(`SHOW CREATE TABLE \`${t}\``);
    out[t] = { ddl: ddl['Create Table'], rows: JSON.parse(JSON.stringify(await seq.query(`SELECT * FROM \`${t}\``, { type: QueryTypes.SELECT }))) };
  }
  return out;
};

const OLD = [
  `CREATE TABLE tenants (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_code VARCHAR(50) NOT NULL, business_name VARCHAR(200) NOT NULL,
     owner_user_id CHAR(36) BINARY NOT NULL, city_id INT NULL, gym_name VARCHAR(200) NULL, gym_description TEXT NULL,
     main_branch_data_json JSON NULL, status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', db_name VARCHAR(100) NULL,
     UNIQUE KEY tenants_tenant_code_unique (tenant_code), KEY tenants_owner_user_id (owner_user_id),
     KEY tenants_status (status), KEY tenants_city_id (city_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE tenant_subscriptions (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, platform VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
     external_original_transaction_id VARCHAR(150) NULL, status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', end_date DATE NULL,
     KEY tenant_subscriptions_tenant_id (tenant_id), KEY tenant_subscriptions_status (status), KEY tenant_subscriptions_end_date (end_date),
     KEY tenant_subscriptions_external_original_transaction_id (external_original_transaction_id),
     UNIQUE KEY tenant_subscriptions_platform_external_unique (platform, external_original_transaction_id),
     CONSTRAINT tenant_subscriptions_ibfk_1 FOREIGN KEY (tenant_id) REFERENCES tenants (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE tenant_invitations (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, token_hash VARCHAR(64) NOT NULL, owner_email VARCHAR(150) NOT NULL,
     business_name VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
     UNIQUE KEY tenant_invitations_token_hash (token_hash), KEY tenant_invitations_owner_email (owner_email), KEY tenant_invitations_status (status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE user_org_index (
     user_id CHAR(36) BINARY NOT NULL, tenant_id CHAR(36) BINARY NOT NULL, role_key VARCHAR(40) NOT NULL,
     status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', PRIMARY KEY (user_id, tenant_id),
     KEY user_org_index_user_id_status (user_id, status), KEY user_org_index_tenant_id_status (tenant_id, status)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE plan_payment_requests (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, tenant_subscription_id CHAR(36) BINARY NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE platform_invoices (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, tenant_subscription_id CHAR(36) BINARY NULL,
     KEY platform_invoices_tenant_subscription_id (tenant_subscription_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE area_request_links (
     id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL,
     target ENUM('tenant','main_branch','listing','branch') NOT NULL, target_id VARCHAR(36) NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE user_blocks (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, user_id CHAR(36) BINARY NOT NULL, tenant_id CHAR(36) BINARY NOT NULL,
     blocked_by VARCHAR(8) NOT NULL, UNIQUE KEY user_blocks_pair_side (user_id, tenant_id, blocked_by)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE payout_accounts (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, scope_key VARCHAR(36) NOT NULL,
     provider VARCHAR(32) NOT NULL DEFAULT 'BANK_TRANSFER', UNIQUE KEY payout_accounts_tenant_scope_provider (tenant_id, scope_key, provider)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'INSERT INTO tenants (id, tenant_code, business_name, owner_user_id, gym_name, gym_description, main_branch_data_json, status, db_name) VALUES (\'t1\', \'GYM-AAAA1111\', \'Iron Group\', \'u1\', \'Iron House\', \'Strong\', \'{"branchName":"DHA"}\', \'ACTIVE\', \'gymsera_gym_aaaa1111\')',
  'INSERT INTO tenant_subscriptions (id, tenant_id, platform, external_original_transaction_id) VALUES (\'s1\', \'t1\', \'IOS\', \'orig-1\')',
  'INSERT INTO tenant_invitations (id, token_hash, owner_email, business_name) VALUES (\'i1\', \'h\', \'a@b.test\', \'Iron Group\')',
  'INSERT INTO user_org_index (user_id, tenant_id, role_key) VALUES (\'u1\', \'t1\', \'ORG_ADMIN\')',
  'INSERT INTO plan_payment_requests (id, tenant_id, tenant_subscription_id) VALUES (\'r1\', \'t1\', \'s1\')',
  'INSERT INTO platform_invoices (id, tenant_id, tenant_subscription_id) VALUES (\'v1\', \'t1\', \'s1\')',
  'INSERT INTO area_request_links (tenant_id, target, target_id) VALUES (\'t1\', \'tenant\', \'t1\'), (\'t1\', \'main_branch\', \'t1\'), (\'t1\', \'listing\', \'l1\'), (\'t1\', \'branch\', \'b1\')',
  'INSERT INTO user_blocks (id, user_id, tenant_id, blocked_by) VALUES (\'k1\', \'u2\', \'t1\', \'USER\'), (\'k2\', \'u2\', \'t1\', \'TENANT\')',
  'INSERT INTO payout_accounts (id, tenant_id, scope_key) VALUES (\'pa1\', \'t1\', \'TENANT\'), (\'pa2\', \'t1\', \'l1\')',
];

describe('NEW-307 organization naming (p034)', () => {
  let seq;
  const fresh = async () => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (seq) await seq.close().catch(() => {});
    seq = connect(DB);
    for (const s of OLD) await seq.query(s);
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [DB] });
  });

  afterAll(async () => {
    await seq?.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
    await teardownTestDatabases();
  });

  describe('p034 on a database before it', () => {
    beforeEach(fresh);

    it('renames tables, columns, indexes and the three stored values in place; data and foreign keys kept', async () => {
      expect(await p034.up(seq)).toBeNull();
      expect(await tablesOf(seq)).toEqual([
        'area_request_links', 'organization_invitations', 'organization_subscriptions', 'organizations', 'payout_accounts',
        'plan_payment_requests', 'platform_invoices', 'user_blocks', 'user_organization_index',
      ]);
      expect(await columnsOf(seq, 'organizations')).toEqual([
        'id', 'organization_code', 'organization_name', 'owner_user_id', 'city_id', 'first_business_name', 'first_business_description',
        'first_branch_draft_json', 'status', 'db_name',
      ]);
      expect(await indexesOf(seq, 'organizations')).toEqual([
        'PRIMARY', 'organizations_city_id', 'organizations_organization_code_unique', 'organizations_owner_user_id', 'organizations_status',
      ]);
      expect(await indexesOf(seq, 'organization_subscriptions')).toEqual([
        'PRIMARY', 'organization_subscriptions_end_date', 'organization_subscriptions_external_original_transaction_id',
        'organization_subscriptions_platform_external_unique', 'organization_subscriptions_status', 'organization_subscriptions_tenant_id',
      ]);
      expect(await indexesOf(seq, 'organization_invitations')).toEqual([
        'PRIMARY', 'organization_invitations_owner_email', 'organization_invitations_status', 'organization_invitations_token_hash',
      ]);
      expect(await indexesOf(seq, 'user_organization_index')).toEqual([
        'PRIMARY', 'user_organization_index_tenant_id_status', 'user_organization_index_user_id_status',
      ]);
      expect(await indexesOf(seq, 'platform_invoices')).toEqual(['PRIMARY', 'platform_invoices_organization_subscription_id']);
      expect(await columnsOf(seq, 'organization_invitations')).toContain('organization_name');
      expect(await columnsOf(seq, 'plan_payment_requests')).toContain('organization_subscription_id');
      expect(await columnsOf(seq, 'platform_invoices')).toContain('organization_subscription_id');
      expect(await fksOf(seq, 'organization_subscriptions')).toEqual([{ c: 'tenant_id', t: 'organizations' }]);

      const one = async (sql) => (await seq.query(sql, { type: QueryTypes.SELECT }))[0];
      expect(await one('SELECT organization_code, organization_name, first_business_name, first_business_description, db_name FROM organizations'))
        .toEqual({ organization_code: 'GYM-AAAA1111', organization_name: 'Iron Group', first_business_name: 'Iron House', first_business_description: 'Strong', db_name: 'gymsera_gym_aaaa1111' });
      expect((await one('SELECT first_branch_draft_json AS d FROM organizations')).d).toEqual({ branchName: 'DHA' });
      expect(await one('SELECT organization_name FROM organization_invitations')).toEqual({ organization_name: 'Iron Group' });
      expect(await one('SELECT organization_subscription_id AS s FROM plan_payment_requests')).toEqual({ s: 's1' });
      expect((await seq.query('SELECT target FROM area_request_links ORDER BY id', { type: QueryTypes.SELECT })).map((r) => r.target))
        .toEqual(['organization', 'first_branch_draft', 'business', 'branch']);
      expect((await seq.query('SELECT blocked_by FROM user_blocks ORDER BY id', { type: QueryTypes.SELECT })).map((r) => r.blocked_by))
        .toEqual(['USER', 'ORGANIZATION']);
      expect((await seq.query('SELECT scope_key FROM payout_accounts ORDER BY id', { type: QueryTypes.SELECT })).map((r) => r.scope_key))
        .toEqual(['ORGANIZATION', 'l1']);
      const [[blocks]] = await seq.query('SHOW CREATE TABLE user_blocks');
      expect(blocks['Create Table']).toMatch(/`blocked_by` varchar\(16\)/);
      const [[orgDdl]] = await seq.query('SHOW CREATE TABLE organizations');
      expect(orgDdl['Create Table']).toMatch(/COMMENT='One row per organization/);
      expect(orgDdl['Create Table']).toMatch(/`organization_code` varchar\(50\) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Short human code/);
      await expect(seq.query('INSERT INTO organization_subscriptions (id, tenant_id) VALUES (\'s9\', \'nope\')')).rejects.toThrow(/foreign key/i);
    });

    it('a re-run changes nothing; a dry run writes nothing', async () => {
      const before = await dump(seq);
      expect(await p034.up(seq, { dryRun: true })).toBeNull();
      expect(await dump(seq)).toEqual(before);
      await p034.up(seq);
      const after = await dump(seq);
      expect(await p034.up(seq)).toBeNull();
      expect(await dump(seq)).toEqual(after);
    });

    it('an enum value it does not know stops the value rename (reported, nothing changed there)', async () => {
      await seq.query('ALTER TABLE area_request_links MODIFY COLUMN target ENUM(\'tenant\',\'main_branch\',\'listing\',\'branch\',\'weird\') NOT NULL');
      await seq.query('INSERT INTO area_request_links (tenant_id, target, target_id) VALUES (\'t1\', \'weird\', \'x\')');
      const r = await p034.up(seq);
      expect(r).toMatchObject({ skipped: true, reason: 'rename_conflict' });
      expect(r.conflicts).toEqual([{ reason: 'unknown_enum_values', table: 'area_request_links', column: 'target', unknown: ['weird'] }]);
      expect(await tablesOf(seq)).toContain('organizations');
    });
  });

  describe('the launch-wipe plan reads either table name', () => {
    const wipeDb = 'gymsera_test_new307_wipe';
    const plan = async (create, insert) => {
      const conn = await getAdminConnection();
      await conn.query(`DROP DATABASE IF EXISTS \`${wipeDb}\``);
      await conn.query(`CREATE DATABASE \`${wipeDb}\``);
      const mysql = require('mysql2/promise');
      const c = await mysql.createConnection({
        host: process.env.PLATFORM_DB_HOST, port: Number(process.env.PLATFORM_DB_PORT), user: process.env.PLATFORM_DB_USER,
        password: process.env.PLATFORM_DB_PASS || '', database: wipeDb,
      });
      try {
        await c.query('CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(100), role VARCHAR(30))');
        await c.query('INSERT INTO users VALUES (1, \'a@gymsera.test\', \'PLATFORM_ADMIN\')');
        await c.query(create);
        await c.query(insert);
        return await planReset(c, { keepAdmins: ['a@gymsera.test'] });
      } finally {
        await c.end();
        await conn.query(`DROP DATABASE IF EXISTS \`${wipeDb}\``);
      }
    };

    beforeAll(() => assertTestEnvironmentSafety({ databases: [wipeDb] }));

    it('after p034 (organizations, organization_code)', async () => {
      const p = await plan('CREATE TABLE organizations (id INT PRIMARY KEY, organization_code VARCHAR(50), status VARCHAR(20), db_name VARCHAR(100))',
        'INSERT INTO organizations VALUES (1, \'ORG-AAAA1111\', \'ACTIVE\', \'gymsera_org_a\')');
      expect(p.tenants).toEqual([{ id: 1, tenantCode: 'ORG-AAAA1111', status: 'ACTIVE', dbName: 'gymsera_org_a' }]);
    });

    it('before p034 (tenants, tenant_code)', async () => {
      const p = await plan('CREATE TABLE tenants (id INT PRIMARY KEY, tenant_code VARCHAR(50), status VARCHAR(20), db_name VARCHAR(100))',
        'INSERT INTO tenants VALUES (1, \'GYM-AAAA1111\', \'ACTIVE\', \'gymsera_gym_a\')');
      expect(p.tenants).toEqual([{ id: 1, tenantCode: 'GYM-AAAA1111', status: 'ACTIVE', dbName: 'gymsera_gym_a' }]);
    });
  });

  describe('organization codes (F8)', () => {
    it('one generator: ORG- plus 8 uppercase hex characters, unique in practice', () => {
      const codes = new Set(Array.from({ length: 200 }, generateOrganizationCode));
      expect(codes.size).toBe(200);
      for (const c of codes) expect(c).toMatch(/^ORG-[0-9A-F]{8}$/);
      expect(ORGANIZATION_CODE_PREFIX).toBe('ORG-');
    });

    it('both creation paths use it (no second generator is left)', () => {
      const fs = require('fs');
      for (const f of ['src/services/tenant.service.js', 'src/services/auth.service.js']) {
        const src = fs.readFileSync(require('path').join(__dirname, '../..', f), 'utf8');
        expect(src).toMatch(/organization-code\.utils/);
        expect(src).not.toMatch(/`GYM-\$\{/);
      }
    });
  });

  describe('fresh databases (models + every migration)', () => {
    let h;
    beforeAll(async () => { h = await setupTestDatabases(); });

    it('only the new names exist and p034 is recorded', async () => {
      const ps = h.platform.sequelize;
      const [{ n }] = await ps.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 34', { type: QueryTypes.SELECT });
      expect(Number(n)).toBe(1);
      const tables = await tablesOf(ps);
      for (const t of ['organizations', 'organization_subscriptions', 'organization_invitations', 'user_organization_index']) expect(tables).toContain(t);
      for (const t of ['tenants', 'tenant_subscriptions', 'tenant_invitations', 'user_org_index']) expect(tables).not.toContain(t);
      expect(await columnsOf(ps, 'organizations')).toEqual(expect.arrayContaining(['organization_code', 'organization_name', 'first_business_name', 'first_branch_draft_json']));
      const [col] = await ps.query('SELECT CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'user_blocks\' AND COLUMN_NAME = \'blocked_by\'', { type: QueryTypes.SELECT });
      expect(Number(col.n)).toBe(16);
    });
  });
});
