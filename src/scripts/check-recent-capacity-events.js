/**
 * READ-ONLY. Dumps the most recent capacity_events rows for one tenant, to
 * confirm the smoke test's delete/restore/concurrent-delete actions each
 * wrote exactly the audit rows expected. Makes no writes.
 *
 * Usage: node src/scripts/check-recent-capacity-events.js <tenantId>
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('Usage: node src/scripts/check-recent-capacity-events.js <tenantId>');
  process.exit(1);
}

(async () => {
  try {
    await sequelize.authenticate();
    const [rows] = await sequelize.query(
      `SELECT action, delta, reserved_slots_before, reserved_slots_after, actor_type, reason, idempotency_key, created_at
       FROM capacity_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 15`,
      { replacements: [tenantId] }
    );
    console.log(`--- Last ${rows.length} capacity_events for tenant ${tenantId} ---\n`);
    rows.forEach((r) => {
      console.log(`${r.created_at}  ${r.action}  delta=${r.delta}  ${r.reserved_slots_before}->${r.reserved_slots_after}  actor=${r.actor_type}  key=${r.idempotency_key}`);
      console.log(`   reason: ${r.reason}\n`);
    });
  } catch (err) {
    console.error('Check failed:', err.message);
  } finally {
    process.exit(0);
  }
})();
