/**
 * READ-ONLY pre-deploy diagnostic. Checks the platform DB's current schema
 * against what this session's migrations assume, before they run for real
 * on staging. Makes no writes.
 *
 * Usage (on the staging server, from the repo root): node src/scripts/check-staging-schema.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

(async () => {
  console.log('--- Staging schema pre-deploy check (read-only) ---\n');
  try {
    await sequelize.authenticate();
    console.log('[OK] Connected to platform DB.\n');

    // 1. Does capacity_events already exist? (it shouldn't yet)
    const [capEventsTable] = await sequelize.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'capacity_events'"
    );
    console.log(`capacity_events table exists already: ${capEventsTable.length > 0 ? 'YES' : 'no'}`);
    if (capEventsTable.length > 0) {
      const [cols] = await sequelize.query('SHOW FULL COLUMNS FROM capacity_events');
      console.log('  Existing columns:', cols.map((c) => c.Field).join(', '));
      const actionCol = cols.find((c) => c.Field === 'action');
      if (actionCol) console.log('  action ENUM definition:', actionCol.Type);
    }

    // 2. Collation of billing_plans.id (only matters if this table exists)
    const [billingPlansTable] = await sequelize.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plans'"
    );
    console.log(`\nbilling_plans table exists: ${billingPlansTable.length > 0 ? 'YES' : 'no'}`);
    if (billingPlansTable.length > 0) {
      const [cols] = await sequelize.query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plans' AND COLUMN_NAME = 'id'"
      );
      console.log('  id column:', JSON.stringify(cols[0]));
      const [count] = await sequelize.query('SELECT COUNT(*) as c FROM billing_plans');
      console.log('  row count:', count[0].c);
    }

    // 3. Collation of tenant_subscriptions.platform_package_id and row count
    const [tenantSubTable] = await sequelize.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions'"
    );
    console.log(`\ntenant_subscriptions table exists: ${tenantSubTable.length > 0 ? 'YES' : 'no'}`);
    if (tenantSubTable.length > 0) {
      const [cols] = await sequelize.query(
        "SELECT COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME IN ('platform_package_id', 'branch_count', 'over_quota_count')"
      );
      cols.forEach((c) => console.log(' ', JSON.stringify(c)));
      const [count] = await sequelize.query('SELECT COUNT(*) as c FROM tenant_subscriptions');
      console.log('  row count:', count[0].c);
      const [activeIap] = await sequelize.query(
        "SELECT COUNT(*) as c FROM tenant_subscriptions WHERE status = 'ACTIVE' AND branch_count IS NOT NULL"
      );
      console.log('  ACTIVE store-verified (IAP) subscriptions:', activeIap[0].c);
    }

    // 4. Any existing FK on tenant_subscriptions.platform_package_id, and its current definition
    const [fks] = await sequelize.query(
      `SELECT kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = 'tenant_subscriptions' AND kcu.COLUMN_NAME = 'platform_package_id'`
    );
    console.log('\nExisting FK on tenant_subscriptions.platform_package_id:', fks.length > 0 ? JSON.stringify(fks[0]) : 'none found');

    // 5. gym_listings row count and reserved_slots presence (sanity, not a migration risk)
    const [glCols] = await sequelize.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gym_listings' AND COLUMN_NAME = 'reserved_slots'"
    );
    console.log(`\ngym_listings.reserved_slots already exists: ${glCols.length > 0 ? 'YES' : 'no'}`);

    console.log('\n--- Done. No writes were made. ---');
  } catch (err) {
    console.error('Check failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
