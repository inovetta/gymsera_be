const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

describe('Tenant migration 019 (branches.currency, GLB-02)', () => {
  let tenantSeq;
  const M019 = '019_add_branch_currency';

  const col = async () => {
    const [c] = await tenantSeq.query(
      "SELECT DATA_TYPE, COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME = 'currency'",
      { type: QueryTypes.SELECT }
    );
    return c;
  };
  const recorded = async () => {
    const [row] = await tenantSeq.query('SELECT version FROM schema_migrations WHERE version = 19', { type: QueryTypes.SELECT });
    return row;
  };
  const toPre019 = async () => {
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 19');
    await tenantSeq.query('ALTER TABLE `branches` DROP COLUMN `currency`').catch(() => {});
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    tenantSeq = h.tenant2.sequelize;
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run lists 019 and writes nothing', async () => {
    await toPre019();
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', dryRun: true, targetVersion: 19 });
    expect(res.wouldRun).toContain(M019);
    expect(await col()).toBeUndefined();
    expect(await recorded()).toBeUndefined();
  });

  test('skips (not recorded) when branches.currency exists with another type', async () => {
    await toPre019();
    await tenantSeq.query('ALTER TABLE `branches` ADD COLUMN `currency` INT NULL');
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 19 });
    expect(res.applied).not.toContain(M019);
    expect(await recorded()).toBeUndefined();
    expect((await col()).DATA_TYPE).toBe('int');
  });

  test('adds the column with PKR for every existing branch, then a re-run does nothing', async () => {
    await toPre019();
    const res1 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 19 });
    expect(res1.applied).toContain(M019);
    const c = await col();
    expect(c.DATA_TYPE).toBe('varchar');
    expect(c.COLUMN_DEFAULT).toBe('PKR');
    expect(c.IS_NULLABLE).toBe('NO');
    const [{ n }] = await tenantSeq.query("SELECT COUNT(*) AS n FROM branches WHERE currency <> 'PKR'", { type: QueryTypes.SELECT });
    expect(Number(n)).toBe(0);

    const res2 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 19 });
    expect(res2.applied).not.toContain(M019);
  });
});
