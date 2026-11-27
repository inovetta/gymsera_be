/**
 * A tenant with two branches and a team whose account role is MEMBER (the way team
 * members exist since RBAC-07), built through the real models and the real
 * membership sync. Used by the NEW-44 route-permission tests.
 */
const { factories } = require('./index');
const { signToken } = require('../../src/utils/jwt.utils');
const membershipService = require('../../src/services/membership.service');

const teamMember = async ({ tenantDb, organizationId, email, roleKey, scopeType, branchIds = [], allow = [] }) => {
  const user = await factories.createUser({ email, role: 'MEMBER', fullName: email.split('@')[0] });
  const assignment = await factories.createRoleAssignment(
    { ...tenantDb, organizationId },
    { userId: user.id, roleKey, scopeType, branchIds, overrides: { organizationId } }
  );
  for (const permissionKey of allow) {
    await tenantDb.models.AssignmentOverride.create({
      assignmentId: assignment.id,
      permissionKey,
      effect: 'ALLOW',
      createdBy: user.id,
    });
  }
  await membershipService.syncUserOrgIndex(organizationId, user.id, tenantDb);
  const token = signToken({ sub: user.id, id: user.id, email, role: 'MEMBER', isVerified: true, organizationId });
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
  const organizationId = personas.owner.organizationId;
  const listing = await GymListing.findOne({ where: { organizationId } });
  const branchA = await tenantDb.models.Branch.findOne({ where: { businessId: listing.id } });
  const branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });

  const now = new Date();
  await factories.createPayment(tenantDb, branchA.id, { amount: 1000, paidAt: now });
  await factories.createPayment(tenantDb, branchB.id, { amount: 7000, paidAt: now });

  const make = (email, roleKey, scopeType, branchIds, allow) =>
    teamMember({ tenantDb, organizationId, email, roleKey, scopeType, branchIds, allow });

  return {
    organizationId,
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
