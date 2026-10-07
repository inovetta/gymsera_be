/**
 * A tenant with two branches and a team whose account role is MEMBER (the way team
 * members exist since RBAC-07), built through the real models and the real
 * membership sync. Used by the NEW-44 route-permission tests.
 */
const { factories } = require('./index');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');

const teamMember = async ({ tenantDb, tenantId, email, roleKey, scopeType, branchIds = [], allow = [] }) => {
  const user = await factories.createUser({ email, role: 'MEMBER', fullName: email.split('@')[0] });
  const assignment = await factories.createRoleAssignment(
    { ...tenantDb, tenantId },
    { userId: user.id, roleKey, scopeType, branchIds, overrides: { tenantId } }
  );
  for (const permissionKey of allow) {
    await tenantDb.models.AssignmentOverride.create({
      assignmentId: assignment.id,
      permissionKey,
      effect: 'ALLOW',
      createdBy: user.id,
    });
  }
  await membershipService.syncUserOrgIndex(tenantId, user.id, tenantDb);
  const token = signToken({ sub: user.id, id: user.id, email, role: 'MEMBER', isVerified: true, tenantId });
  return { user, token, assignment };
};

/**
 * @param {object} dbHarness  from setupTestDatabases()
 * @param {object} personas   from setupPersonas()
 * @returns two branches (A = persona branch1, B = new), COMPLETED payments of 1,000 at A
 *          and 7,000 at B, and team members: frontDeskOff, frontDeskOn (revenue ALLOW at A),
 *          managerA, orgAdmin, plus the owner token.
 */
const buildTwoBranchTeam = async (dbHarness, personas) => {
  const { GymListing } = require('../../src/models/platform');
  const tenantDb = dbHarness.tenant1;
  const tenantId = personas.owner.tenantId;
  const listing = await GymListing.findOne({ where: { tenantId } });
  const branchA = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
  const branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });

  const now = new Date();
  await factories.createPayment(tenantDb, branchA.id, { amount: 1000, paidAt: now });
  await factories.createPayment(tenantDb, branchB.id, { amount: 7000, paidAt: now });

  const make = (email, roleKey, scopeType, branchIds, allow) =>
    teamMember({ tenantDb, tenantId, email, roleKey, scopeType, branchIds, allow });

  return {
    tenantId,
    branchA,
    branchB,
    ownerToken: personas.owner.token,
    frontDeskOff: await make('fd-off@new44.test', 'DESK', 'BRANCH', [branchA.id]),
    frontDeskOn: await make('fd-on@new44.test', 'DESK', 'BRANCH', [branchA.id], ['dashboard.revenue.view']),
    managerA: await make('mgr-a@new44.test', 'MANAGER', 'BRANCH', [branchA.id]),
    orgAdmin: await make('orgadmin@new44.test', 'ORG_ADMIN', 'ORG', []),
  };
};

module.exports = { buildTwoBranchTeam, teamMember };
