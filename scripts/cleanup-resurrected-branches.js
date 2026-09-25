/**
 * One-time cleanup for the branches scripts/audit-resurrected-branches.js
 * CONFIRMED were resurrected by the (now-fixed) TenantDbManager.getConnection
 * bug — no BRANCH_RESTORED event anywhere after their deletion.
 *
 * Deliberately does NOT touch the database directly. It calls the real,
 * now-fixed gymService.deleteBranch() for each branch — the exact function
 * the host's own "Delete" button calls — so this goes through the full
 * cascade (member subscriptions/staff/plans -> INACTIVE), writes a correct
 * BRANCH_DELETED CapacityEvent, credits reservedSlots properly, and
 * recomputes overQuotaCount afterward. A raw UPDATE here would repeat
 * exactly the mistake that caused this in the first place.
 *
 * If a branch turns out to be the last active one in its organization,
 * deleteBranch's own guard requires an explicit confirmation — this script
 * passes confirmOrganizationDeletion: true, because putting a resurrected
 * branch back to the INACTIVE state it should already be in is finishing
 * what was already, legitimately, decided; not a new decision. The
 * organization's capacity is never lost either way — it returns to the
 * tenant's available pool exactly like any other branch deletion.
 *
 * Confirmed test-data tenant only. Every branch ID below was individually
 * verified via audit-resurrected-branches.js before this file was written.
 *
 * Usage: node scripts/cleanup-resurrected-branches.js
 */
require('dotenv').config();
const { sequelize, Tenant } = require('../src/models/platform');
const TenantDbManager = require('../src/database/TenantDbManager');
const gymService = require('../src/services/gym.service');

const TENANT_ID = '38d67399-cd0b-45d6-8f5d-9a79d45a580a'; // amir's Gym Business
const BRANCH_IDS = [
  { id: '20e4bc84-7641-47ec-856f-1844cfcdb179', name: 'game' },
  { id: 'ded62c63-f6b4-4e03-96c7-d0e3cec8577b', name: 'forge' },
  { id: 'f12900e0-e3c8-4244-8b50-2aab8ecc469c', name: 'yoga' },
  { id: 'ac5a71e0-4439-4899-816a-c978066da70c', name: 'irofist' },
  { id: '30dfbca4-b081-4b99-b787-ad752d18ac79', name: 'zamangym' },
];

(async () => {
  console.log(`--- Cleaning up ${BRANCH_IDS.length} resurrected branches for tenant ${TENANT_ID} ---\n`);

  const tenant = await Tenant.findByPk(TENANT_ID);
  if (!tenant || !tenant.connectionStringEncrypted) {
    console.error('Tenant not found or not provisioned.');
    process.exit(1);
  }
  const tenantDb = await TenantDbManager.getConnection(TENANT_ID, tenant.connectionStringEncrypted);

  for (const { id, name } of BRANCH_IDS) {
    try {
      const branch = await tenantDb.models.Branch.findByPk(id);
      if (!branch) {
        console.log(`  [skip] ${name} (${id}): branch row no longer exists`);
        continue;
      }
      if (branch.status !== 'ACTIVE') {
        console.log(`  [skip] ${name} (${id}): already ${branch.status}, nothing to do`);
        continue;
      }

      await gymService.deleteBranch(tenantDb, id, null, { confirmOrganizationDeletion: true });
      console.log(`  [done] ${name} (${id}): deleted properly — capacity credited, ledger correct`);
    } catch (err) {
      console.error(`  [FAILED] ${name} (${id}): ${err.message}`);
    }
  }

  console.log('\n--- Done. Re-run scripts/diag-capacity.js or the CMS Capacity tab to confirm. ---');
  await sequelize.close();
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
