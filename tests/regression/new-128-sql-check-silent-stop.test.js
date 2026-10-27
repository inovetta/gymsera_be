/**
 * NEW-128 — on production, `node src/scripts/run-sql-check.js docs/sql/new-124-tenant-schema-check.sql`
 * printed grid 1 and then stopped: no grid 2, no "Done" line, no error. Production has a tenant
 * database with no `schema_migrations` table (GYM-4814C134, NEW-127). Reproduced here with the
 * same state, through the real CLI in a child process (exit code and output as the owner sees them).
 *
 * Expected: either both grids and "Done" with exit 0, or an ERROR line and a non-zero exit; never
 * an exit with neither. Grid 2 reports a tenant without the migration table instead of skipping it.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'scripts', 'run-sql-check.js');
const CHECK_SQL = path.join(__dirname, '..', '..', 'docs', 'sql', 'new-124-tenant-schema-check.sql');
const PRELOAD = path.join(__dirname, '..', 'fixtures', 'sql-check-link-vanishes.js');

let h;
let tenant;

beforeAll(async () => {
  h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  const team = await buildTwoBranchTeam(h, personas);
  await h.platform.sequelize.query('UPDATE tenants SET db_name = :db WHERE id = \'test-tenant-1\' OR tenant_code = \'GYM-TENANT1\'', { replacements: { db: h.tenant1.database } });
  await h.platform.sequelize.query('UPDATE tenants SET db_name = :db WHERE id = \'test-tenant-2\' OR tenant_code = \'GYM-TENANT2\'', { replacements: { db: h.tenant2.database } });
  // Tenant 1 as GYM-4814C134: no schema_migrations, no branches.currency.
  await h.tenant1.sequelize.query('DROP TABLE `schema_migrations`');
  await h.tenant1.sequelize.query('ALTER TABLE `branches` DROP COLUMN `currency`');
  [tenant] = await h.platform.sequelize.query('SELECT tenant_code, db_name FROM tenants WHERE id = :id', {
    replacements: { id: team.tenantId },
    type: h.platform.sequelize.QueryTypes.SELECT,
  });
});

afterAll(async () => {
  await teardownTestDatabases();
});

const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout || ''}${r.stderr || ''}` };
};

test('the NEW-124 check runs to the end on a tenant without schema_migrations: both grids, Done, exit 0', () => {
  const { status, out } = cli([CHECK_SQL]);
  expect(out).toMatch(/Grid 1 \(line \d+\)/);
  expect(out).toMatch(/Grid 2 \(line \d+\)/);
  expect(out).toMatch(/^Done: 2 grids\./m);
  expect(status).toBe(0);
});

test('grid 2 reports the tenant that has no schema_migrations table, and its missing branches.currency', () => {
  const { out } = cli([CHECK_SQL]);
  const grid2 = out.slice(out.indexOf('Grid 2'));
  const row = (table, column) => new RegExp(`\\|\\s*${tenant.tenant_code}\\s*\\|\\s*${tenant.db_name}\\s*\\|\\s*${table}\\s*\\|\\s*${column}\\s*\\|`);
  expect(grid2).toMatch(row('schema_migrations', '\\(table\\)'));
  expect(grid2).toMatch(row('branches', 'currency'));
  // The tenant that has everything is not listed.
  expect(grid2).not.toContain(h.tenant2.database);
});

test('the NEW-127 history check passes the guard and runs to Done (four grids; grid 4 lists the tenant without schema_migrations)', () => {
  const { status, out } = cli([path.join(__dirname, '..', '..', 'docs', 'sql', 'new-127-tenant-history.sql')]);
  expect(out).toMatch(/^Done: 4 grids\./m);
  expect(status).toBe(0);
  const grid4 = out.slice(out.indexOf('Grid 4'));
  expect(grid4).toMatch(new RegExp(`\\|\\s*${tenant.tenant_code}\\s*\\|`));
});

test('the link vanishing during grid 2 (no error event; the process would just end) prints an ERROR naming the statement and exits non-zero', () => {
  const r = spawnSync(process.execPath, ['-r', PRELOAD, SCRIPT, CHECK_SQL], {
    env: { ...process.env, SQL_CHECK_VANISH_ON: 'missing_column' },
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  expect(out).toMatch(/Grid 1 \(line \d+\)/);
  expect(out).not.toMatch(/^Done:/m);
  expect(out).toMatch(/^ERROR: the run ended before it finished, while running line \d+ \(statement 2 of 2\)/m);
  expect(r.signal).toBeNull();
  expect(r.status).toBe(1);
});
