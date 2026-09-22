/**
 * ONE-TIME catalog fix. Replaces the placeholder Android product/base-plan
 * IDs (platform.js's own backfill: PLACEHOLDER_branches_N / _monthly /
 * _annual) with the REAL ones now configured in Play Console — product ID
 * `branches_N`, base plan IDs `monthly` and `annual`, exactly as created
 * this session. Without this, google-play-billing.service.js#findPlanForProductId
 * can never match a real purchase to a BillingPlan row — every Android
 * sync would fail with "No BillingPlan is configured for Android product...".
 *
 * Prints every row's old -> new IDs before writing, and re-reads after to
 * confirm. Idempotent — safe to re-run, just pointless after the first time.
 *
 * Usage: node src/scripts/update-android-product-ids.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

(async () => {
  console.log('--- Android product/base-plan ID fix (writes) ---\n');
  try {
    await sequelize.authenticate();

    const [before] = await sequelize.query(
      'SELECT branch_count, android_product_id, android_monthly_base_plan_id, android_annual_base_plan_id ' +
        'FROM billing_plans ORDER BY sort_order ASC'
    );

    console.log('Current -> new Android IDs:');
    before.forEach((row) => {
      const newProductId = `branches_${row.branch_count}`;
      console.log(
        `  branches=${row.branch_count}: productId ${row.android_product_id} -> ${newProductId}, ` +
          `monthlyBasePlan ${row.android_monthly_base_plan_id} -> monthly, ` +
          `annualBasePlan ${row.android_annual_base_plan_id} -> annual`
      );
    });

    console.log('\nWriting...');
    for (const row of before) {
      await sequelize.query(
        `UPDATE billing_plans
         SET android_product_id = ?, android_monthly_base_plan_id = 'monthly', android_annual_base_plan_id = 'annual'
         WHERE branch_count = ?`,
        { replacements: [`branches_${row.branch_count}`, row.branch_count] }
      );
    }

    const [after] = await sequelize.query(
      'SELECT branch_count, android_product_id, android_monthly_base_plan_id, android_annual_base_plan_id ' +
        'FROM billing_plans ORDER BY sort_order ASC'
    );
    console.log('\n=== Confirmed rows after update ===');
    after.forEach((r) => {
      console.log(
        `  branches=${r.branch_count}  productId=${r.android_product_id}  ` +
          `monthly=${r.android_monthly_base_plan_id}  annual=${r.android_annual_base_plan_id}`
      );
    });
    console.log('\n=== Done ===\n');
  } catch (err) {
    console.error('Update failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
