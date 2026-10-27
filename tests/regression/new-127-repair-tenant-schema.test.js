/**
 * NEW-127 repair — a tenant database with no `schema_migrations` (GYM-4814C134) is baselined:
 * what each migration already did is recorded without running it, only what is missing runs,
 * and any unexpected schema refuses the whole repair before a single write.
 * `src/scripts/repair-tenant-schema.js`, dry run unless --apply --confirm <code>.
 *
 * Local test MySQL only (R-19): `gymsera_test_n127r_*` databases.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, getAdminConnection, factories } = require('../harness');
const { encrypt } = require('../../src/utils/crypto.utils');
const registerTenantModels = require('../../src/models/tenant');
const { MIGRATIONS, runTenantMigrations } = require('../../src/database/tenant-migration-runner');
const { PROBES, inspectTenantSchema } = require('../../src/database/tenant-schema-baseline');
const { main } = require('../../src/scripts/repair-tenant-schema');

const ALL_VERSIONS = MIGRATIONS.map((m) => m.version);
const SCRIPT = path.join(__dirname, '..', '..', 'src', 'scripts', 'repair-tenant-schema.js');
const createdDbs = [];
let n = 0;

beforeAll(async () => {
  await setupTestDatabases();
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of createdDbs) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await teardownTestDatabases();
});

const url = (db) => {
  const host = process.env.TENANT_DB_HOST || 'localhost';
  const port = process.env.TENANT_DB_PORT || '3306';
  const user = process.env.TENANT_DB_USER || 'root';
  const pass = process.env.TENANT_DB_PASS !== undefined ? process.env.TENANT_DB_PASS : '';
  return `mysql://${user}:${pass}@${host}:${port}/${db}`;
};

/**
 * A tenant like GYM-4814C134: models synced and every migration's effect present except 019,
 * then `schema_migrations` dropped. `alter(seq)` bends it into other shapes.
 */
const legacyTenant = async (alter = async () => {}) => {
  n += 1;
  const tenantCode = `test_n127r_${Date.now().toString(36)}_${n}`;
  const db = `gymsera_${tenantCode}`;
  createdDbs.push(db);
  const conn = await getAdminConnection();
  await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const seq = new Sequelize(url(db), { dialect: 'mysql', logging: false });
  const models = registerTenantModels(seq);
  await seq.sync();
  await runTenantMigrations(seq, { tenantId: tenantCode });
  const gym = await models.Gym.create({ name: 'Repair Gym', gymListingId: 'listing-n127r' });
  await models.Branch.create({ gymId: gym.id, branchName: 'Main', gymListingId: 'listing-n127r' });
  await models.Branch.create({ gymId: gym.id, branchName: 'Second', gymListingId: 'listing-n127r' });
  await seq.query('DROP TABLE schema_migrations');
  await seq.query('ALTER TABLE branches DROP COLUMN currency');
  await alter(seq);
  const tenant = await factories.createTenant({ tenantCode, status: 'ACTIVE', connectionStringEncrypted: encrypt(url(db)) });
  await tenant.update({ dbName: db });
  return { tenant, tenantCode, db, seq };
};

/** Everything that would show a write: tables, columns of every table, row counts. */
const fingerprint = async (db) => {
  const conn = await getAdminConnection();
  const [cols] = await conn.query(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, COLUMN_NAME', [db]
  );
  const [[branches]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${db}\`.branches`);
  return { cols: JSON.stringify(cols), branches: Number(branches.n) };
};

const capture = () => {
  const lines = [];
  return { write: (s) => lines.push(String(s)), text: () => lines.join('') };
};

const recorded = async (seq) => (await seq.query('SELECT version FROM schema_migrations ORDER BY version', { type: Sequelize.QueryTypes.SELECT })).map((r) => Number(r.version));

describe('NEW-127 repair: baseline, then apply only what is missing', () => {
  test('every tenant migration has a baseline probe', () => {
    expect(Object.keys(PROBES).map(Number).sort((a, b) => a - b)).toEqual(ALL_VERSIONS);
  });

  test('on a database where every migration ran, every probe answers present', async () => {
    const { seq } = await legacyTenant(async (s) => {
      await s.query('ALTER TABLE branches ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT \'PKR\'');
    });
    try {
      const inspection = await inspectTenantSchema(seq);
      expect(inspection.probes.filter((p) => p.state !== 'present')).toEqual([]);
      expect(inspection.refusals).toEqual([]);
    } finally {
      await seq.close();
    }
  });

  test('dry run (the default): reports 18 present and 019 to run, changes nothing', async () => {
    const { tenantCode, db, seq } = await legacyTenant();
    try {
      const before = await fingerprint(db);
      const out = capture();
      const code = await main(['--tenant', tenantCode], { write: out.write });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/DRY RUN complete\. Nothing was changed/);
      expect(out.text()).toMatch(/Would run 1 migration\(s\): 019_add_branch_currency/);
      expect(out.text()).toMatch(/Would record 18 migration\(s\) as already applied/);
      expect(out.text()).toContain(`--apply --confirm ${tenantCode}`);
      expect(await fingerprint(db)).toEqual(before);
    } finally {
      await seq.close();
    }
  });

  test('--apply without the matching --confirm is refused before connecting', async () => {
    const { tenantCode, db, seq } = await legacyTenant();
    try {
      const before = await fingerprint(db);
      for (const argv of [['--tenant', tenantCode, '--apply'], ['--tenant', tenantCode, '--apply', '--confirm', 'GYM-OTHER']]) {
        const out = capture();
        expect(await main(argv, { write: out.write })).toBe(2);
        expect(out.text()).toMatch(/REFUSED: --apply needs --confirm/);
      }
      expect(await fingerprint(db)).toEqual(before);
    } finally {
      await seq.close();
    }
  });

  test('--apply --confirm: records 1-18 without running them, runs 019 only, every version recorded, rows kept', async () => {
    const { tenantCode, db, seq } = await legacyTenant();
    try {
      const ran = [];
      for (const m of MIGRATIONS) {
        const real = m.up;
        jest.spyOn(m, 'up').mockImplementation(async (...args) => { ran.push(m.version); return real(...args); });
      }
      const out = capture();
      const code = await main(['--tenant', tenantCode, '--apply', '--confirm', tenantCode], { write: out.write });
      expect(code).toBe(0);
      expect(out.text()).toMatch(/DONE: tenant .* is at v19, every migration recorded/);
      expect(ran).toEqual([19]);
      expect(await recorded(seq)).toEqual(ALL_VERSIONS);
      const [branches] = await seq.query('SELECT currency FROM branches');
      expect(branches.map((b) => b.currency)).toEqual(['PKR', 'PKR']);
      expect((await fingerprint(db)).branches).toBe(2);

      // A second repair is refused: the normal runner owns it now.
      const again = capture();
      expect(await main(['--tenant', tenantCode, '--apply', '--confirm', tenantCode], { write: again.write })).toBe(2);
      expect(again.text()).toMatch(/schema_migrations already exists: use node src\/scripts\/run-tenant-migrations\.js/);
    } finally {
      jest.restoreAllMocks();
      await seq.close();
    }
  });

  test('a migration missing in the middle (008, one column gone) runs too; nothing else does', async () => {
    const { tenantCode, seq } = await legacyTenant(async (s) => {
      await s.query('ALTER TABLE branches DROP COLUMN admin_suspended_at');
    });
    try {
      const inspection = await inspectTenantSchema(seq);
      expect(inspection.toApply).toEqual([8, 19]);
      expect(await main(['--tenant', tenantCode, '--apply', '--confirm', tenantCode], { write: () => {} })).toBe(0);
      expect(await recorded(seq)).toEqual(ALL_VERSIONS);
    } finally {
      await seq.close();
    }
  });
});

describe('NEW-127 repair: an unexpected schema is refused, nothing written', () => {
  const refusedCases = [
    ['branches.currency exists as INT (019 conflict)', async (s) => { await s.query('ALTER TABLE branches ADD COLUMN currency INT NULL'); }, /019_add_branch_currency: branches\.currency is int/],
    ['payouts exists without amount (012 conflict)', async (s) => { await s.query('ALTER TABLE payouts DROP COLUMN amount'); }, /012_create_payouts_table: table payouts exists without column amount/],
    ['a model column no migration adds is missing (NEW-126)', async (s) => { await s.query('ALTER TABLE branches DROP COLUMN tagline'); }, /no tenant migration adds .*branches\.tagline/],
    ['a model table no migration creates is missing', async (s) => { await s.query('DROP TABLE trainers'); }, /no tenant migration adds .*trainers/],
    ['schema_migrations already exists', async (s) => { await s.query('CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name VARCHAR(191) NOT NULL, applied_at DATETIME NOT NULL)'); }, /schema_migrations already exists/],
  ];

  test.each(refusedCases)('%s', async (_label, alter, reason) => {
    const { tenantCode, db, seq } = await legacyTenant(alter);
    try {
      const before = await fingerprint(db);
      for (const argv of [['--tenant', tenantCode], ['--tenant', tenantCode, '--apply', '--confirm', tenantCode]]) {
        const out = capture();
        expect(await main(argv, { write: out.write })).toBe(2);
        expect(out.text()).toMatch(/REFUSED, unexpected schema\. Nothing was changed/);
        expect(out.text()).toMatch(reason);
      }
      expect(await fingerprint(db)).toEqual(before);
    } finally {
      await seq.close();
    }
  });

  test('an unknown tenant code is refused', async () => {
    const out = capture();
    expect(await main(['--tenant', 'GYM-NOPE0000'], { write: out.write })).toBe(2);
    expect(out.text()).toMatch(/no tenant with code GYM-NOPE0000/);
  });
});

test('the CLI dry run ends on its own with exit 0 and prints no connection secret', async () => {
  const { tenantCode, seq } = await legacyTenant();
  await seq.close();
  const r = spawnSync(process.execPath, [SCRIPT, '--tenant', tenantCode], { env: process.env, encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  expect(r.signal).toBeNull();
  expect(r.status).toBe(0);
  expect(out).toMatch(/DRY RUN complete/);
  expect(out).not.toMatch(/mysql:\/\//);
  if (process.env.TENANT_DB_PASS) expect(out).not.toContain(process.env.TENANT_DB_PASS);
});
