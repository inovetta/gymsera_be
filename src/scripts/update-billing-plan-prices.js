/**
 * ONE-TIME catalog re-price. Updates the 10 billing_plans rows to the new
 * PKR 2,000/branch/month ladder with a 40% annual discount (monthly * 12 *
 * 0.6), and marks iOS/Android sync status as SYNCED with last_synced_at =
 * now — both stores have just been manually configured to match these
 * figures (App Store Connect's own price-tier rounding means its actual
 * charged price is off by a few hundred PKR at most on a few tiers; that's
 * expected and fine, see BillingPlan.model.js's three-price-separation
 * note — the catalog holds the canonical reference price, not each store's
 * individually-rounded one). Stripe's sync status is left untouched —
 * nothing about Stripe has changed.
 *
 * Prints every row's old -> new price before writing, and re-reads after
 * to confirm. Safe to run only once as intended; re-running is harmless
 * (idempotent — same UPDATE, same values) but pointless after the first run.
 *
 * Usage: node src/scripts/update-billing-plan-prices.js
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

// branchCount -> { monthly, annual }. Monthly is the clean PKR 2000/branch
// ladder — no store-side rounding issue was ever hit there. Annual is the
// ACTUAL price now configured on both App Store Connect and Play Console
// (Apple's fixed price-tier list forced a few tiers off the exact "40% off"
// target by a few hundred PKR; Android was then updated to match Apple
// exactly rather than keep the untouched exact target) — using the real,
// now-identical-on-both-stores figure here instead of the theoretical exact
// target keeps TenantSubscription.amount accurate to what's actually
// charged everywhere, matching the three-price-separation rule.
const NEW_PRICES = {
  1: { monthly: 2000, annual: 14400 },
  2: { monthly: 4000, annual: 28900 },
  3: { monthly: 6000, annual: 43500 },
  4: { monthly: 8000, annual: 57900 },
  5: { monthly: 10000, annual: 71999 },
  6: { monthly: 12000, annual: 86900 },
  7: { monthly: 14000, annual: 100000 },
  8: { monthly: 16000, annual: 114900 },
  9: { monthly: 18000, annual: 129900 },
  10: { monthly: 20000, annual: 144900 },
};

(async () => {
  console.log('--- Billing plan catalog re-price (writes) ---\n');
  try {
    await sequelize.authenticate();

    const [before] = await sequelize.query(
      'SELECT id, branch_count, monthly_price, annual_price FROM billing_plans ORDER BY sort_order ASC'
    );

    console.log('Current -> new prices:');
    for (const row of before) {
      const next = NEW_PRICES[row.branch_count];
      if (!next) {
        console.warn(`  branches=${row.branch_count}: no new price defined, skipping`);
        continue;
      }
      console.log(
        `  branches=${row.branch_count}: monthly ${row.monthly_price} -> ${next.monthly}, ` +
          `annual ${row.annual_price} -> ${next.annual}`
      );
    }

    console.log('\nWriting...');
    for (const [branchCount, prices] of Object.entries(NEW_PRICES)) {
      await sequelize.query(
        `UPDATE billing_plans
         SET monthly_price = ?, annual_price = ?,
             ios_sync_status = 'SYNCED', ios_last_synced_at = NOW(),
             android_sync_status = 'SYNCED', android_last_synced_at = NOW()
         WHERE branch_count = ?`,
        { replacements: [prices.monthly, prices.annual, Number(branchCount)] }
      );
    }

    const [after] = await sequelize.query(
      'SELECT branch_count, monthly_price, annual_price, ios_sync_status, android_sync_status, stripe_sync_status FROM billing_plans ORDER BY sort_order ASC'
    );
    console.log('\n=== Confirmed rows after update ===');
    after.forEach((r) => {
      console.log(
        `  branches=${r.branch_count}  monthly=${r.monthly_price}  annual=${r.annual_price}  ` +
          `sync[ios=${r.ios_sync_status},android=${r.android_sync_status},stripe=${r.stripe_sync_status}]`
      );
    });
    console.log('\n=== Done ===\n');
  } catch (err) {
    console.error('Update failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
