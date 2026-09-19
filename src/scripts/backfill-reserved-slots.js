/**
 * One-off backfill for tenants who bought more branches than they've built
 * (e.g. a 2-branch plan with only 1 real branch) before
 * tenant-provisioning.service.js started attributing the leftover capacity
 * as reservedSlots on their first organization. Without this, that capacity
 * is real (already paid for, already counted as "used" by getUsedCapacity)
 * but invisible — no organization's Gyms tab ever shows it as a buildable
 * slot.
 *
 * For each tenant, attributes any unattributed capacity
 * (maxBranches - realActiveBranches - alreadyReservedSlots) to their
 * oldest-created organization — matching where the original purchase
 * actually happened, since a tenant's first organization is always the one
 * created during onboarding.
 *
 * Usage: node scripts/backfill-reserved-slots.js
 */
require('dotenv').config();
const { Tenant, GymListing } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const subscriptionQuotaService = require('../services/subscription-quota.service');

(async () => {
  console.log('--- Backfilling reserved slots ---');
  let updated = 0;
  let skipped = 0;

  try {
    const tenants = await Tenant.findAll({ where: { status: 'ACTIVE' } });
    console.log(`Found ${tenants.length} active tenants.`);

    for (const tenant of tenants) {
      if (!tenant.connectionStringEncrypted) continue;

      try {
        const activeSub = await subscriptionQuotaService.getActiveSubscription(tenant.id);
        const maxBranches = await subscriptionQuotaService.resolveMaxBranches(tenant, activeSub);

        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const realBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });

        const listings = await GymListing.findAll({
          where: { tenantId: tenant.id, status: { [require('sequelize').Op.ne]: 'INACTIVE' } },
          order: [['createdAt', 'ASC']],
        });
        if (listings.length === 0) continue;

        const alreadyReserved = listings.reduce((sum, l) => sum + (l.reservedSlots || 0), 0);
        const unattributed = maxBranches - realBranches - alreadyReserved;

        if (unattributed > 0) {
          const target = listings[0]; // oldest organization — where the original purchase happened
          await subscriptionQuotaService.recordCapacityEvent(
            {
              tenantId: tenant.id,
              listingId: target.id,
              action: 'SLOT_ATTRIBUTED_UPGRADE',
              delta: unattributed,
              reservedSlotsBefore: target.reservedSlots,
              reservedSlotsAfter: target.reservedSlots + unattributed,
              actorType: 'SYSTEM',
              reason: `Backfill: ${unattributed} previously-unattributed slot(s) found and attributed to oldest organization`,
              idempotencyKey: `slot_attribute_backfill:${tenant.id}:${target.id}:${require('crypto').randomUUID()}`,
            },
            { transaction: null }
          );
          await target.increment('reservedSlots', { by: unattributed });
          console.log(`[Backfill] Tenant ${tenant.businessName || tenant.id}: attributed ${unattributed} slot(s) to "${target.title}" (${target.id})`);
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn(`[Backfill] Skipped tenant ${tenant.id}: ${err.message}`);
        skipped++;
      }
    }

    console.log('-----------------------------------');
    console.log(`Backfill complete. Updated ${updated} tenant(s), skipped ${skipped}.`);
  } catch (err) {
    console.error('Backfill failed:', err);
  } finally {
    process.exit(0);
  }
})();
