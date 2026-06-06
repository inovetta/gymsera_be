/**
 * repair-subscription-index.js
 *
 * One-time repair for UserGymMembership records whose subscriptionId was set
 * to a random UUID by seed.js and never linked to a real MemberSubscription.
 *
 * For each UserGymMembership, this script:
 *   1. Connects to the tenant DB
 *   2. Finds the MemberSubscription for that userId in that tenant
 *   3. Updates subscriptionId + status + dates to match the real record
 *
 * Safe to re-run — only updates records where subscriptionId is wrong.
 *
 * Run: node src/scripts/repair-subscription-index.js
 */
require('dotenv').config();

const { connect: initPlatformDb } = require('../database/platform');
const { UserGymMembership, Tenant } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');

async function main() {
  await initPlatformDb();
  console.log('✅  Platform DB connected\n');

  const memberships = await UserGymMembership.findAll();
  console.log(`📋  Found ${memberships.length} UserGymMembership record(s) to check\n`);

  let fixed = 0;
  let alreadyOk = 0;
  let failed = 0;

  for (const mem of memberships) {
    try {
      const tenant = await Tenant.findOne({
        where: { id: mem.tenantId, status: 'ACTIVE' },
        attributes: ['id', 'connectionStringEncrypted'],
      });

      if (!tenant) {
        console.log(`  ⚠️  Tenant ${mem.tenantId} not found/active — skipping`);
        failed++;
        continue;
      }

      const { models } = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { MemberSubscription } = models;

      // Find the member's subscription in this tenant DB
      const sub = await MemberSubscription.findOne({
        where: { userId: mem.userId },
        order: [['created_at', 'DESC']],
      });

      if (!sub) {
        // No MemberSubscription exists — create one using the UserGymMembership data
        const { MembershipPlan, Branch } = models;

        // Try exact name match, then any active plan, then any plan at all
        const plan = (mem.planName
          ? await MembershipPlan.findOne({ where: { name: mem.planName } })
          : null)
          ?? await MembershipPlan.findOne({ where: { status: 'ACTIVE' }, order: [['price', 'DESC']] })
          ?? await MembershipPlan.findOne({ order: [['created_at', 'ASC']] });

        const branch = await Branch.findOne({ where: { status: 'ACTIVE' }, order: [['created_at', 'ASC']] })
          ?? await Branch.findOne({ order: [['created_at', 'ASC']] });

        if (!plan || !branch) {
          console.log(`  ⚠️  Cannot create subscription for user ${mem.userId} — no plan or branch in tenant ${mem.tenantId}`);
          failed++;
          continue;
        }

        const { v4: uuidv4 } = require('uuid');
        const newSub = await MemberSubscription.create({
          userId:           mem.userId,
          branchId:         branch.id,
          membershipPlanId: plan.id,
          startDate:        mem.startDate || new Date().toISOString().split('T')[0],
          endDate:          mem.endDate   || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
          status:           mem.status || 'ACTIVE',
          autoRenew:        false,
          qrCode:           `GE-${mem.userId.replace(/-/g, '').toUpperCase()}`,
          subscribedAt:     mem.startDate ? new Date(mem.startDate) : new Date(),
          sourceChannel:    'WALK_IN',
          remainingVisits:  null,
        });

        await mem.update({ subscriptionId: newSub.id });
        console.log(`  ✅  Created + linked subscription ${newSub.id} for user ${mem.userId} in tenant ${mem.tenantId}`);
        fixed++;
        continue;
      }

      if (mem.subscriptionId === sub.id) {
        alreadyOk++;
        continue;
      }

      await mem.update({
        subscriptionId: sub.id,
        status: sub.status,
        startDate: sub.startDate,
        endDate: sub.endDate,
      });

      console.log(`  ✅  Fixed user ${mem.userId}: ${mem.subscriptionId} → ${sub.id}`);
      fixed++;
    } catch (err) {
      console.error(`  ❌  Error processing membership ${mem.id}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊  Done: ${fixed} fixed, ${alreadyOk} already correct, ${failed} failed/skipped`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
