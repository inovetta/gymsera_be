/**
 * NEW-306 (R-120): business tables and columns get their names (platform p033, tenant 030).
 * On MySQL 5.7: a database shaped like production before the migrations is renamed in place (data,
 * foreign keys, indexes and comments kept; two enum values renamed); a re-run and a dry run change
 * nothing; a fresh database built by the models plus every migration has only the new names; the
 * tenant baseline still probes an old database (legacy table name) and knows 030.
 */
const { Sequelize, QueryTypes } = require('sequelize');
const { assertTestEnvironmentSafety, getAdminConnection, setupTestDatabases, teardownTestDatabases } = require('../harness');
const { PLATFORM_MIGRATIONS } = require('../../src/database/platform-migrations');
const { MIGRATIONS } = require('../../src/database/tenant-migration-runner');
const { inspectTenantSchema } = require('../../src/database/tenant-schema-baseline');

const PLATFORM_DB = 'gymsera_test_new306_platform';
const TENANT_DB = 'gymsera_test_new306_tenant';
const p033 = PLATFORM_MIGRATIONS.find((m) => m.name === 'p033_business_naming');
const t030 = MIGRATIONS.find((m) => m.name === '030_business_naming');

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
    // MySQL names the index it adds for a foreign key after the constraint; not ours to rename.
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

const OLD_PLATFORM = [
  `CREATE TABLE gym_listings (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, branch_id CHAR(36) BINARY NULL,
     city_id INT NOT NULL, area_id INT NULL, title VARCHAR(200) NOT NULL, short_description TEXT NULL,
     status ENUM('ACTIVE','INACTIVE','PENDING','DRAFT','REJECTED') NOT NULL DEFAULT 'DRAFT',
     is_featured TINYINT(1) DEFAULT 0, gender_type ENUM('MIXED','MALE_ONLY','FEMALE_ONLY') NULL,
     KEY gym_listings_city_id_area_id_status (city_id, area_id, status), KEY gym_listings_tenant_id (tenant_id),
     KEY gym_listings_is_featured (is_featured), KEY gym_listings_gender_type (gender_type)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE saved_gyms (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, user_id CHAR(36) BINARY NOT NULL, gym_listing_id CHAR(36) BINARY NOT NULL,
     UNIQUE KEY saved_gyms_user_id_gym_listing_id (user_id, gym_listing_id), KEY saved_gyms_user_id (user_id),
     CONSTRAINT saved_gyms_ibfk_1 FOREIGN KEY (gym_listing_id) REFERENCES gym_listings (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE gym_reviews (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, gym_listing_id CHAR(36) BINARY NOT NULL, branch_id CHAR(36) BINARY NULL,
     user_id CHAR(36) BINARY NOT NULL, status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
     KEY gym_reviews_gym_listing_id_status (gym_listing_id, status), KEY gym_reviews_branch_id_status (branch_id, status),
     KEY gym_reviews_user_id (user_id), UNIQUE KEY gym_reviews_branch_user_unique (branch_id, user_id),
     CONSTRAINT gym_reviews_ibfk_1 FOREIGN KEY (gym_listing_id) REFERENCES gym_listings (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE user_gym_memberships (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, user_id CHAR(36) BINARY NOT NULL, tenant_id CHAR(36) BINARY NOT NULL,
     gym_listing_id CHAR(36) BINARY NOT NULL, subscription_id CHAR(36) BINARY NOT NULL, gym_name VARCHAR(200) NULL,
     status ENUM('PENDING','ACTIVE','FROZEN','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING',
     KEY user_gym_memberships_user_id_status (user_id, status), KEY user_gym_memberships_tenant_id (tenant_id),
     KEY user_gym_memberships_subscription_id (subscription_id), KEY user_gym_memberships_gym_listing_id (gym_listing_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE payout_accounts (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, organization_id CHAR(36) BINARY NULL,
     scope_key VARCHAR(36) NOT NULL, KEY payout_accounts_organization_id (organization_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE access_devices (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) BINARY NOT NULL, organization_id CHAR(36) BINARY NULL,
     branch_id CHAR(36) BINARY NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE capacity_events (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, tenant_id CHAR(36) NOT NULL, listing_id CHAR(36) NULL,
     action ENUM('BRANCH_DELETED','BRANCH_RESTORED','SLOT_TRANSFERRED','SLOT_TRIMMED_DOWNGRADE','SLOT_ATTRIBUTED_UPGRADE','SLOT_CONSUMED_BUILD','ORG_DELETED','ORG_BRANCHES_MOVED','BRANCH_BILLING_LOCKED','BRANCH_BILLING_UNLOCKED') NOT NULL,
     INDEX capacity_events_listing_id (listing_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE platform_packages (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, max_organizations INT NOT NULL DEFAULT 1
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  'INSERT INTO gym_listings (id, tenant_id, branch_id, city_id, title, short_description) VALUES (\'l1\', \'t1\', \'b1\', 3, \'Iron House\', \'Strong\')',
  'INSERT INTO saved_gyms (id, user_id, gym_listing_id) VALUES (\'s1\', \'u1\', \'l1\')',
  'INSERT INTO gym_reviews (id, gym_listing_id, branch_id, user_id) VALUES (\'r1\', \'l1\', \'b1\', \'u1\')',
  'INSERT INTO user_gym_memberships (id, user_id, tenant_id, gym_listing_id, subscription_id, gym_name) VALUES (\'m1\', \'u1\', \'t1\', \'l1\', \'sub1\', \'Iron House\')',
  'INSERT INTO payout_accounts (id, tenant_id, organization_id, scope_key) VALUES (\'pa1\', \'t1\', \'l1\', \'l1\')',
  'INSERT INTO access_devices (id, tenant_id, organization_id, branch_id) VALUES (\'d1\', \'t1\', \'g1\', \'b1\')',
  'INSERT INTO capacity_events (id, tenant_id, listing_id, action) VALUES (\'e1\', \'t1\', \'l1\', \'ORG_DELETED\'), (\'e2\', \'t1\', \'l1\', \'ORG_BRANCHES_MOVED\'), (\'e3\', \'t1\', NULL, \'SLOT_TRANSFERRED\')',
  'INSERT INTO platform_packages (id, max_organizations) VALUES (\'pk1\', 2)',
];

const OLD_TENANT = [
  `CREATE TABLE gyms (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL, gym_listing_id CHAR(36) BINARY NULL,
     refunds_allowed TINYINT(1) NOT NULL DEFAULT 0, refund_window_days SMALLINT UNSIGNED NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE branches (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, gym_id CHAR(36) BINARY NOT NULL, gym_listing_id CHAR(36) BINARY NULL,
     branch_name VARCHAR(200) NOT NULL, KEY branches_gym_id (gym_id),
     CONSTRAINT branches_ibfk_1 FOREIGN KEY (gym_id) REFERENCES gyms (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE membership_plans (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, gym_id CHAR(36) BINARY NOT NULL, name VARCHAR(200) NOT NULL,
     KEY membership_plans_gym_id (gym_id), CONSTRAINT membership_plans_ibfk_1 FOREIGN KEY (gym_id) REFERENCES gyms (id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE expense_categories (
     id CHAR(36) BINARY NOT NULL PRIMARY KEY, name VARCHAR(100) NOT NULL, gym_id CHAR(36) BINARY NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  'INSERT INTO gyms (id, name, gym_listing_id) VALUES (\'g1\', \'Iron House\', \'l1\')',
  'INSERT INTO branches (id, gym_id, gym_listing_id, branch_name) VALUES (\'b1\', \'g1\', \'l1\', \'DHA\')',
  'INSERT INTO membership_plans (id, gym_id, name) VALUES (\'mp1\', \'g1\', \'Monthly\')',
  'INSERT INTO expense_categories (id, name, gym_id) VALUES (\'ec1\', \'Rent\', \'g1\')',
];

describe('NEW-306 business naming (p033, tenant 030)', () => {
  let seq;
  const fresh = async (db, statements) => {
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    if (seq) await seq.close().catch(() => {});
    seq = connect(db);
    for (const s of statements) await seq.query(s);
  };

  beforeAll(() => {
    assertTestEnvironmentSafety({ databases: [PLATFORM_DB, TENANT_DB] });
  });

  afterAll(async () => {
    await seq?.close().catch(() => {});
    const conn = await getAdminConnection();
    await conn.query(`DROP DATABASE IF EXISTS \`${PLATFORM_DB}\``);
    await conn.query(`DROP DATABASE IF EXISTS \`${TENANT_DB}\``);
    await teardownTestDatabases();
  });

  describe('platform p033 on a database before it', () => {
    beforeEach(() => fresh(PLATFORM_DB, OLD_PLATFORM));

    it('renames tables, columns, indexes and enum values in place; data and foreign keys kept', async () => {
      expect(await p033.up(seq)).toBeNull();
      expect(await tablesOf(seq)).toEqual([
        'access_devices', 'business_listings', 'business_reviews', 'capacity_events', 'member_subscription_index',
        'payout_accounts', 'platform_packages', 'saved_businesses',
      ]);
      expect(await columnsOf(seq, 'business_listings')).toEqual(expect.arrayContaining(['name', 'primary_branch_id', 'description']));
      expect(await columnsOf(seq, 'business_listings')).not.toEqual(expect.arrayContaining(['title']));
      expect(await indexesOf(seq, 'business_listings')).toEqual([
        'PRIMARY', 'business_listings_city_id_area_id_status', 'business_listings_gender_type', 'business_listings_is_featured', 'business_listings_tenant_id',
      ]);
      expect(await indexesOf(seq, 'saved_businesses')).toEqual(['PRIMARY', 'saved_businesses_user_id', 'saved_businesses_user_id_business_id']);
      expect(await indexesOf(seq, 'business_reviews')).toEqual([
        'PRIMARY', 'business_reviews_branch_id_status', 'business_reviews_branch_user_unique', 'business_reviews_business_id_status', 'business_reviews_user_id',
      ]);
      expect(await indexesOf(seq, 'member_subscription_index')).toEqual([
        'PRIMARY', 'member_subscription_index_business_id', 'member_subscription_index_subscription_id',
        'member_subscription_index_tenant_id', 'member_subscription_index_user_id_status',
      ]);
      expect(await indexesOf(seq, 'payout_accounts')).toEqual(['PRIMARY', 'payout_accounts_business_id']);
      expect(await indexesOf(seq, 'capacity_events')).toEqual(['PRIMARY', 'capacity_events_business_id']);
      expect(await fksOf(seq, 'saved_businesses')).toEqual([{ c: 'business_id', t: 'business_listings' }]);
      expect(await fksOf(seq, 'business_reviews')).toEqual([{ c: 'business_id', t: 'business_listings' }]);

      const one = async (sql) => (await seq.query(sql, { type: QueryTypes.SELECT }))[0];
      expect(await one('SELECT name, primary_branch_id, description FROM business_listings')).toEqual({ name: 'Iron House', primary_branch_id: 'b1', description: 'Strong' });
      expect(await one('SELECT business_id FROM saved_businesses')).toEqual({ business_id: 'l1' });
      expect(await one('SELECT business_id, business_name FROM member_subscription_index')).toEqual({ business_id: 'l1', business_name: 'Iron House' });
      expect(await one('SELECT business_id FROM payout_accounts')).toEqual({ business_id: 'l1' });
      expect(await one('SELECT business_id FROM access_devices')).toEqual({ business_id: 'g1' });
      expect(await one('SELECT max_businesses FROM platform_packages')).toEqual({ max_businesses: 2 });
      expect((await seq.query('SELECT action FROM capacity_events ORDER BY id', { type: QueryTypes.SELECT })).map((r) => r.action))
        .toEqual(['BUSINESS_DELETED', 'BUSINESS_BRANCHES_MOVED', 'SLOT_TRANSFERRED']);
      const [[ddl]] = await seq.query('SHOW CREATE TABLE business_listings');
      expect(ddl['Create Table']).toMatch(/`name` varchar\(200\) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Business name shown to travellers/);
      expect(ddl['Create Table']).toMatch(/COMMENT='One row per business/);
      // The foreign key still enforces after both renames.
      await expect(seq.query('INSERT INTO saved_businesses (id, user_id, business_id) VALUES (\'s2\', \'u1\', \'nope\')')).rejects.toThrow(/foreign key/i);
    });

    it('a re-run changes nothing; a dry run writes nothing', async () => {
      const before = await dump(seq);
      expect(await p033.up(seq, { dryRun: true })).toBeNull();
      expect(await dump(seq)).toEqual(before);
      await p033.up(seq);
      const after = await dump(seq);
      expect(await p033.up(seq)).toBeNull();
      expect(await dump(seq)).toEqual(after);
    });

    it('a table present under both names with data in both is reported, not recorded', async () => {
      await seq.query('CREATE TABLE saved_businesses (id CHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
      await seq.query('INSERT INTO saved_businesses VALUES (\'x\')');
      const r = await p033.up(seq);
      expect(r).toMatchObject({ skipped: true, reason: 'rename_conflict' });
      expect(r.conflicts).toEqual([{ reason: 'both_tables_have_data', from: 'saved_gyms', to: 'saved_businesses' }]);
      expect(await tablesOf(seq)).toContain('saved_gyms');
    });
  });

  describe('tenant 030 on a database before it', () => {
    beforeEach(() => fresh(TENANT_DB, OLD_TENANT));

    it('renames gyms and the gym_id columns; FKs follow; re-run no-op; the baseline knows 030', async () => {
      const before = await inspectTenantSchema(seq);
      expect(before.probes.find((p) => p.version === 30).state).toBe('missing');
      // Older probes find the business table under its old name.
      expect(before.probes.find((p) => p.version === 28).state).toBe('missing'); // refund_requests absent here
      expect(await t030.up(seq)).toBeNull();
      const tables = await tablesOf(seq);
      expect(tables).toContain('businesses');
      expect(tables).not.toContain('gyms');
      for (const t of ['branches', 'membership_plans', 'expense_categories']) {
        expect(await columnsOf(seq, t)).toContain('business_id');
        expect(await columnsOf(seq, t)).not.toContain('gym_id');
      }
      expect(await indexesOf(seq, 'branches')).toContain('branches_business_id');
      expect(await indexesOf(seq, 'membership_plans')).toContain('membership_plans_business_id');
      expect(await fksOf(seq, 'branches')).toEqual([{ c: 'business_id', t: 'businesses' }]);
      expect(await fksOf(seq, 'membership_plans')).toEqual([{ c: 'business_id', t: 'businesses' }]);
      // ON DELETE CASCADE still works through the renamed table and column.
      await seq.query('DELETE FROM membership_plans WHERE id = \'mp1\'');
      await seq.query('DELETE FROM businesses WHERE id = \'g1\'');
      expect(await seq.query('SELECT id FROM branches', { type: QueryTypes.SELECT })).toEqual([]);
      const snapshot = await dump(seq);
      expect(await t030.up(seq)).toBeNull();
      expect(await dump(seq)).toEqual(snapshot);
      const after = await inspectTenantSchema(seq);
      expect(after.probes.find((p) => p.version === 30).state).toBe('present');
    });
  });

  describe('fresh databases (models + every migration)', () => {
    let h;
    beforeAll(async () => { h = await setupTestDatabases(); });

    it('platform: p033 recorded, only the new names exist', async () => {
      const ps = h.platform.sequelize;
      const [{ n }] = await ps.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 33', { type: QueryTypes.SELECT });
      expect(Number(n)).toBe(1);
      const tables = await tablesOf(ps);
      for (const t of ['business_listings', 'saved_businesses', 'business_reviews', 'member_subscription_index']) expect(tables).toContain(t);
      for (const t of ['gym_listings', 'saved_gyms', 'gym_reviews', 'user_gym_memberships']) expect(tables).not.toContain(t);
      expect(await columnsOf(ps, 'payout_accounts')).toContain('business_id');
      expect(await columnsOf(ps, 'capacity_events')).toContain('business_id');
      expect(await columnsOf(ps, 'capacity_events')).not.toContain('listing_id');
    });

    it('tenant: 030 recorded, only the new names exist', async () => {
      const ts = h.tenant1.sequelize;
      const [{ n }] = await ts.query('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 30', { type: QueryTypes.SELECT });
      expect(Number(n)).toBe(1);
      const tables = await tablesOf(ts);
      expect(tables).toContain('businesses');
      expect(tables).not.toContain('gyms');
      expect(await columnsOf(ts, 'branches')).toContain('business_id');
      expect(await columnsOf(ts, 'branches')).not.toContain('gym_id');
    });
  });
});
