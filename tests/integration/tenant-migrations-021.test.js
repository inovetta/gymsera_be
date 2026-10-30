const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

describe('Tenant migration 021 (branches.paused_at / paused_by, P5b item 2)', () => {
  let tenantSeq;
  const M021 = '021_add_branch_pause_columns';

  const cols = async () => {
    const rows = await tenantSeq.query(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'branches' AND COLUMN_NAME IN ('paused_at', 'paused_by')",
      { type: QueryTypes.SELECT }
    );
    return Object.fromEntries(rows.map((r) => [r.name, `${r.type} ${r.nullable}`]));
  };
  const recorded = async () => {
    const [row] = await tenantSeq.query('SELECT version FROM schema_migrations WHERE version = 21', { type: QueryTypes.SELECT });
    return row;
  };
  const toPre021 = async () => {
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 21');
    await tenantSeq.query('ALTER TABLE `branches` DROP COLUMN `paused_at`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `branches` DROP COLUMN `paused_by`').catch(() => {});
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    tenantSeq = h.tenant2.sequelize;
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run lists 021 and writes nothing', async () => {
    await toPre021();
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', dryRun: true, targetVersion: 21 });
    expect(res.wouldRun).toContain(M021);
    expect(await cols()).toEqual({});
    expect(await recorded()).toBeUndefined();
  });

  test('skips (not recorded) when branches.paused_at exists with another type', async () => {
    await toPre021();
    await tenantSeq.query('ALTER TABLE `branches` ADD COLUMN `paused_at` INT NULL');
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 21 });
    expect(res.applied).not.toContain(M021);
    expect(await recorded()).toBeUndefined();
    expect((await cols()).paused_at).toBe('int YES');
  });

  test('adds both nullable columns (no branch is paused), then a re-run does nothing', async () => {
    await toPre021();
    const res1 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 21 });
    expect(res1.applied).toContain(M021);
    expect(await cols()).toEqual({ paused_at: 'datetime YES', paused_by: 'char YES' });
    const [{ n }] = await tenantSeq.query('SELECT COUNT(*) AS n FROM branches WHERE paused_at IS NOT NULL', { type: QueryTypes.SELECT });
    expect(Number(n)).toBe(0);

    const res2 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 21 });
    expect(res2.applied).not.toContain(M021);
  });
});
