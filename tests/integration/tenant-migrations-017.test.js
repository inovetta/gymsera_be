const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

describe('Tenant migration 017 (payments.pending_change_json, FLOW-08)', () => {
  let tenantSeq;
  const M017 = '017_add_payment_pending_change';

  const column = async () => {
    const [col] = await tenantSeq.query(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'pending_change_json'",
      { type: QueryTypes.SELECT }
    );
    return col;
  };
  const recorded = async () => {
    const [row] = await tenantSeq.query('SELECT version FROM schema_migrations WHERE version = 17', { type: QueryTypes.SELECT });
    return row;
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    tenantSeq = h.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run lists 017 and writes nothing', async () => {
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 17');
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `pending_change_json`').catch(() => {});

    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', dryRun: true, targetVersion: 17 });
    expect(res.dryRun).toBe(true);
    expect(res.wouldRun).toContain(M017);
    expect(await column()).toBeUndefined();
    expect(await recorded()).toBeUndefined();
  });

  test('skips (not recorded) when the column exists with another type', async () => {
    await tenantSeq.query('ALTER TABLE `payments` ADD COLUMN `pending_change_json` INT NULL');
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 17 });
    expect(res.applied).not.toContain(M017);
    expect(await recorded()).toBeUndefined();
    expect((await column()).DATA_TYPE).toBe('int');
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `pending_change_json`');
  });

  test('applies, then a re-run does nothing', async () => {
    const res1 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 17 });
    expect(res1.applied).toContain(M017);
    expect((await column()).DATA_TYPE).toBe('text');
    expect(await recorded()).toBeDefined();

    const res2 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 17 });
    expect(res2.applied).not.toContain(M017);
  });
});
