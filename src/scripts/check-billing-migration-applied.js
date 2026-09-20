/**
 * READ-ONLY staging-verification helper. Confirms this session's schema
 * additions actually landed on the platform DB after deploy + restart —
 * run this BEFORE any provider test, since every other check's evidence is
 * only meaningful if the migration actually applied. Makes no writes.
 *
 * Usage: node src/scripts/check-billing-migration-applied.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

(async () => {
  console.log('--- Billing migration verification (read-only) ---\n');
  try {
    await sequelize.authenticate();
    console.log('[OK] Connected to platform DB.\n');

    const [tsCols] = await sequelize.query(
      "SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME IN ('status', 'status_note')"
    );
    console.log('tenant_subscriptions columns:');
    tsCols.forEach((c) => console.log(`  ${c.COLUMN_NAME}: ${c.COLUMN_TYPE}`));
    const statusCol = tsCols.find((c) => c.COLUMN_NAME === 'status');
    const statusWidened = statusCol && /PENDING_MIGRATION/.test(statusCol.COLUMN_TYPE) && /PENDING_CANCEL/.test(statusCol.COLUMN_TYPE) && /SCHEDULED/.test(statusCol.COLUMN_TYPE);
    console.log(`  status ENUM widened correctly: ${statusWidened ? 'YES' : '*** NO — MIGRATION DID NOT APPLY ***'}`);
    const hasStatusNote = tsCols.some((c) => c.COLUMN_NAME === 'status_note');
    console.log(`  status_note column present: ${hasStatusNote ? 'YES' : '*** NO ***'}\n`);

    const [bpCols] = await sequelize.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plans' AND COLUMN_NAME IN ('stripe_product_id','ios_sync_status','android_sync_status','stripe_sync_status','ios_last_synced_at','android_last_synced_at','stripe_last_synced_at')"
    );
    const expectedBpCols = ['stripe_product_id', 'ios_sync_status', 'android_sync_status', 'stripe_sync_status', 'ios_last_synced_at', 'android_last_synced_at', 'stripe_last_synced_at'];
    const foundBpCols = bpCols.map((c) => c.COLUMN_NAME);
    console.log('billing_plans new columns:');
    expectedBpCols.forEach((c) => console.log(`  ${c}: ${foundBpCols.includes(c) ? 'present' : '*** MISSING ***'}`));

    const [plans] = await sequelize.query(
      'SELECT branch_count, android_product_id, android_monthly_base_plan_id, stripe_monthly_price_id, ios_sync_status, android_sync_status, stripe_sync_status FROM billing_plans ORDER BY sort_order ASC'
    );
    console.log(`\nbilling_plans rows (${plans.length}):`);
    plans.forEach((p) => {
      console.log(
        `  branches=${p.branch_count}  android=${p.android_product_id}  ` +
          `stripeMonthly=${p.stripe_monthly_price_id || 'NULL'}  ` +
          `sync[ios=${p.ios_sync_status},android=${p.android_sync_status},stripe=${p.stripe_sync_status}]`
      );
    });
    const placeholderCount = plans.filter((p) => (p.android_product_id || '').startsWith('PLACEHOLDER_')).length;
    console.log(`\nTiers still on placeholder Android IDs: ${placeholderCount} / ${plans.length} ${placeholderCount > 0 ? '(replace before Android testing)' : '(OK — real IDs configured)'}`);
    const stripeConfiguredCount = plans.filter((p) => p.stripe_monthly_price_id).length;
    console.log(`Tiers with a Stripe monthly price configured: ${stripeConfiguredCount} / ${plans.length} ${stripeConfiguredCount === 0 ? '(run "Sync Stripe Price" in the CMS before Stripe testing)' : ''}`);

    const [routeCheck] = await sequelize.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_plans'"
    );
    console.log(`\n=== Summary: ${statusWidened && hasStatusNote && foundBpCols.length === expectedBpCols.length ? 'MIGRATION APPLIED CORRECTLY' : '*** MIGRATION INCOMPLETE — DO NOT PROCEED WITH TESTING YET ***'} ===\n`);
  } catch (err) {
    console.error('Check failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
