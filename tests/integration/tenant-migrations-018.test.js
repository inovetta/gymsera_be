const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

describe('Tenant migration 018 (payments EXPIRED status + expires_at, PAY-08)', () => {
  let tenantSeq;
  const M018 = '018_add_payment_expiry';
  const OLD_ENUM = "ENUM('PENDING','STAFF_COLLECTED','COMPLETED','FAILED','REFUNDED')";

  const col = async (name) => {
    const [c] = await tenantSeq.query(
      `SELECT COLUMN_TYPE, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = '${name}'`,
      { type: QueryTypes.SELECT }
    );
    return c;
  };
  const recorded = async () => {
    const [row] = await tenantSeq.query('SELECT version FROM schema_migrations WHERE version = 18', { type: QueryTypes.SELECT });
    return row;
  };
  const toPre018 = async () => {
    await tenantSeq.query('DELETE FROM schema_migrations WHERE version >= 18');
    await tenantSeq.query('ALTER TABLE `payments` DROP INDEX `payments_status_expires_at`').catch(() => {});
    await tenantSeq.query('ALTER TABLE `payments` DROP COLUMN `expires_at`').catch(() => {});
    await tenantSeq.query(`ALTER TABLE \`payments\` MODIFY COLUMN \`status\` ${OLD_ENUM} NOT NULL DEFAULT 'PENDING'`);
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    tenantSeq = h.tenant2.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('--dry-run lists 018 and writes nothing', async () => {
    await toPre018();
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', dryRun: true, targetVersion: 18 });
    expect(res.wouldRun).toContain(M018);
    expect(await col('expires_at')).toBeUndefined();
    expect((await col('status')).COLUMN_TYPE).not.toContain('EXPIRED');
    expect(await recorded()).toBeUndefined();
  });

  test('skips (not recorded) when the payments.status ENUM lacks a known value', async () => {
    await toPre018();
    await tenantSeq.query("ALTER TABLE `payments` MODIFY COLUMN `status` ENUM('PENDING','COMPLETED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING'");
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res.applied).not.toContain(M018);
    expect(await recorded()).toBeUndefined();
    expect(await col('expires_at')).toBeUndefined();
    expect((await col('status')).COLUMN_TYPE).not.toContain('EXPIRED');
  });

  test('an ENUM in another order: EXPIRED appended, order, NOT NULL and default kept', async () => {
    await toPre018();
    await tenantSeq.query("ALTER TABLE `payments` MODIFY COLUMN `status` ENUM('PENDING','COMPLETED','FAILED','REFUNDED','STAFF_COLLECTED') NOT NULL DEFAULT 'PENDING'");
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res.applied).toContain(M018);
    const [c] = await tenantSeq.query(
      "SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'status'",
      { type: QueryTypes.SELECT }
    );
    expect(c.COLUMN_TYPE).toBe("enum('PENDING','COMPLETED','FAILED','REFUNDED','STAFF_COLLECTED','EXPIRED')");
    expect(c.IS_NULLABLE).toBe('NO');
    expect(c.COLUMN_DEFAULT).toBe('PENDING');
  });

  test('a VARCHAR status (older tenants) is left as is; expires_at is added', async () => {
    await toPre018();
    await tenantSeq.query("ALTER TABLE `payments` MODIFY COLUMN `status` VARCHAR(50) NOT NULL DEFAULT 'PENDING'");
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res.applied).toContain(M018);
    expect((await col('status')).COLUMN_TYPE).toBe('varchar(50)');
    expect((await col('expires_at')).DATA_TYPE).toBe('datetime');
  });

  test('skips (not recorded) when payments.expires_at exists with another type', async () => {
    await toPre018();
    await tenantSeq.query('ALTER TABLE `payments` ADD COLUMN `expires_at` INT NULL');
    const res = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res.applied).not.toContain(M018);
    expect(await recorded()).toBeUndefined();
    expect((await col('status')).COLUMN_TYPE).not.toContain('EXPIRED');
  });

  test('applies, then a re-run does nothing', async () => {
    await toPre018();
    const res1 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res1.applied).toContain(M018);
    expect((await col('status')).COLUMN_TYPE).toBe("enum('PENDING','STAFF_COLLECTED','COMPLETED','FAILED','REFUNDED','EXPIRED')");
    expect((await col('expires_at')).DATA_TYPE).toBe('datetime');
    expect(await recorded()).toBeDefined();

    const res2 = await runTenantMigrations(tenantSeq, { tenantId: 'test-tenant-2', targetVersion: 18 });
    expect(res2.applied).not.toContain(M018);
  });
});
