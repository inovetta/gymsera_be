/**
 * READ-ONLY staging-verification helper. Dumps a tenant's FULL entitlement
 * picture in one call — every TenantSubscription row (not just the ACTIVE
 * one, so PENDING_CANCEL/SCHEDULED/CANCELLED/EXPIRED rows are all visible
 * too), the tenant's real ACTIVE branch count, its GymListings' reservedSlots,
 * and the most recent capacity_events — exactly the evidence the billing
 * staging test plan (STAGING_TEST_PLAN.md) asks for after every scenario.
 * Makes no writes.
 *
 * Usage: node src/scripts/check-tenant-entitlement.js <tenantId>
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('Usage: node src/scripts/check-tenant-entitlement.js <tenantId>');
  process.exit(1);
}

(async () => {
  try {
    await sequelize.authenticate();

    const [subs] = await sequelize.query(
      `SELECT id, platform, status, branch_count, product_id,
              external_original_transaction_id, external_transaction_id, environment,
              amount, billing_cycle, start_date, end_date, auto_renew, over_quota_count,
              status_note, last_verified_at, created_at, updated_at
       FROM tenant_subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20`,
      { replacements: [tenantId] }
    );

    const activeCount = subs.filter((s) => s.status === 'ACTIVE').length;

    console.log(`\n=== TenantSubscription rows for tenant ${tenantId} ===`);
    console.log(`ACTIVE row count: ${activeCount}  ${activeCount === 1 ? '(OK — exactly one)' : activeCount === 0 ? '(no active entitlement)' : '*** VIOLATION: more than one ACTIVE row ***'}\n`);
    subs.forEach((s) => {
      console.log(
        `[${s.status}] platform=${s.platform} branchCount=${s.branch_count} amount=${s.amount} cycle=${s.billing_cycle} ` +
          `env=${s.environment} autoRenew=${s.auto_renew} overQuota=${s.over_quota_count}`
      );
      console.log(`   externalOriginalTransactionId=${s.external_original_transaction_id}`);
      console.log(`   externalTransactionId=${s.external_transaction_id}`);
      console.log(`   start=${s.start_date} end=${s.end_date} lastVerified=${s.last_verified_at}`);
      if (s.status_note) console.log(`   statusNote: ${s.status_note}`);
      console.log(`   id=${s.id}  updatedAt=${s.updated_at}\n`);
    });

    const [listings] = await sequelize.query(
      `SELECT id, name, status, reserved_slots FROM gym_listings WHERE tenant_id = ? ORDER BY created_at ASC`,
      { replacements: [tenantId] }
    );
    console.log(`=== GymListings (reservedSlots) for tenant ${tenantId} ===`);
    let reservedTotal = 0;
    listings.forEach((l) => {
      if (l.status !== 'INACTIVE') reservedTotal += l.reserved_slots;
      console.log(`[${l.status}] ${l.name}  reservedSlots=${l.reserved_slots}  id=${l.id}`);
    });
    console.log(`Total reservedSlots (non-INACTIVE): ${reservedTotal}\n`);

    const [events] = await sequelize.query(
      `SELECT action, delta, reserved_slots_before, reserved_slots_after, actor_type, reason, idempotency_key, created_at
       FROM capacity_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 15`,
      { replacements: [tenantId] }
    );
    console.log(`=== Last ${events.length} capacity_events for tenant ${tenantId} ===`);
    events.forEach((r) => {
      console.log(`${r.created_at}  ${r.action}  delta=${r.delta}  ${r.reserved_slots_before}->${r.reserved_slots_after}  actor=${r.actor_type}`);
      console.log(`   key=${r.idempotency_key}`);
      console.log(`   reason: ${r.reason}\n`);
    });

    console.log('=== Done. No writes were made. ===\n');
  } catch (err) {
    console.error('Check failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
