/**
 * Integration Test: Mixed Collation Tenant Database Migrations (Step 2.10)
 *
 * Verifies that:
 * 1. A tenant database with mixed collations (payments.branch_id utf8mb4_general_ci vs branches.id utf8mb4_unicode_ci)
 *    fails when performing a direct SQL JOIN on MySQL 5.7 with "Illegal mix of collations".
 * 2. Migration 004 without a SQL join successfully backfills business_date in branch timezone.
 * 3. Migration 007 aligns all tables and columns to utf8mb4_unicode_ci, touching only what differs, safely and idempotently.
 * 4. After Migration 007, a direct SQL join payments.branch_id = branches.id works cleanly without error.
 */
const { createMixedCollationTenantDb } = require('../harness');
const { QueryTypes } = require('sequelize');

describe('Step 2.10: Mixed Collation Tenant Database Migrations', () => {
  let fixture;

  beforeEach(async () => {
    // Recreate fresh mixed fixture before test
    fixture = await createMixedCollationTenantDb('gymsera_test_mixed_collate');
  });

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
  });

  test('FAILS: direct SQL join between payments.branch_id/ledger_days.branch_id and branches.id throws "Illegal mix of collations" on MySQL 5.7', async () => {
    // Proves the production failure: payments.branch_id (utf8mb4_general_ci) = branches.id (utf8mb4_unicode_ci)
    await expect(
      fixture.sequelize.query(`
        SELECT p.id, b.timezone 
        FROM payments p 
        LEFT JOIN branches b ON p.branch_id = b.id 
        WHERE p.business_date IS NULL
      `, { type: QueryTypes.SELECT })
    ).rejects.toThrow(/Illegal mix of collations/i);

    // Proves ledger_days join failure as well
    await expect(
      fixture.sequelize.query(`
        SELECT ld.id, ld.business_date, b.branch_name
        FROM ledger_days ld
        JOIN branches b ON ld.branch_id = b.id
      `, { type: QueryTypes.SELECT })
    ).rejects.toThrow(/Illegal mix of collations/i);
  });

  test('Migration 004 successfully backfills NULL business_date rows without SQL join when collation is mixed', async () => {
    const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');
    await runTenantMigrations(fixture.sequelize, { tenantId: 'mixed-tenant', targetVersion: 4 });

    const [result] = await fixture.sequelize.query(
      'SELECT COUNT(*) as null_count FROM payments WHERE business_date IS NULL',
      { type: QueryTypes.SELECT }
    );
    expect(Number(result.null_count)).toBe(0);

    // Verify payments received the branch timezone date
    const [cashRow] = await fixture.sequelize.query(
      "SELECT business_date FROM payments WHERE id = 'pmt-cash-001'",
      { type: QueryTypes.SELECT }
    );
    expect(cashRow.business_date).toBe('2026-03-15');
  });

  test('Runner dry-run prints what WOULD run with ZERO writes', async () => {
    const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

    const result = await runTenantMigrations(fixture.sequelize, {
      tenantId: 'mixed-tenant',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.initialVersion).toBe(3);
    expect(result.wouldRun).toContain('004_backfill_payments_business_date');
    expect(result.wouldRun).toContain('007_align_tenant_collations');

    // Verify zero writes: schema_migrations still only has 3 rows
    const schemaRows = await fixture.sequelize.query(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
      { type: QueryTypes.SELECT }
    );
    expect(schemaRows.map((r) => r.version)).toEqual([1, 2, 3]);

    // Verify payments still have NULL business_date (no DML writes)
    const [nullResult] = await fixture.sequelize.query(
      'SELECT COUNT(*) as null_count FROM payments WHERE business_date IS NULL',
      { type: QueryTypes.SELECT }
    );
    expect(Number(nullResult.null_count)).toBe(2);
  });

  test('Migration 007 aligns collations and allows direct SQL join between payments and branches', async () => {
    const { runTenantMigrations } = require('../../src/database/tenant-migration-runner');

    // Run all migrations through v7
    const result = await runTenantMigrations(fixture.sequelize, {
      tenantId: 'mixed-tenant',
      targetVersion: 7,
    });

    expect(result.finalVersion).toBe(7);
    expect(result.applied).toContain('007_align_tenant_collations');

    // Verify that information_schema shows 0 differing columns in this database
    const differingCols = await fixture.sequelize.query(`
      SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND COLLATION_NAME IS NOT NULL 
        AND COLLATION_NAME != 'utf8mb4_unicode_ci'
    `, { type: QueryTypes.SELECT });
    expect(differingCols.length).toBe(0);

    // Verify that direct SQL join now SUCCEEDS on MySQL 5.7 without collation error!
    const joinRows = await fixture.sequelize.query(`
      SELECT p.id, p.amount, b.branch_name, b.timezone
      FROM payments p
      JOIN branches b ON p.branch_id = b.id
    `, { type: QueryTypes.SELECT });

    expect(joinRows.length).toBe(2);
    expect(joinRows[0].branch_name).toBe('Karachi Central');

    // Verify that direct SQL join between ledger_days and branches also SUCCEEDS!
    const ledgerRows = await fixture.sequelize.query(`
      SELECT ld.id, ld.business_date, ld.status, b.branch_name
      FROM ledger_days ld
      JOIN branches b ON ld.branch_id = b.id
    `, { type: QueryTypes.SELECT });

    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].branch_name).toBe('Karachi Central');
    expect(ledgerRows[0].status).toBe('OPEN');

    // Test safe to re-run (idempotency): re-running makes 0 changes
    const rerunResult = await runTenantMigrations(fixture.sequelize, {
      tenantId: 'mixed-tenant',
      targetVersion: 7,
    });
    expect(rerunResult.applied.length).toBe(0);
    expect(rerunResult.finalVersion).toBe(7);
  });
});
