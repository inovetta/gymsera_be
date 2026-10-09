/**
 * NEW-47 — Tenant owners whose account role is MEMBER get all branches, members,
 * reports, bank details, search, enroll and image routes. Front Desk still does not.
 *
 * Before:
 * - hasAllBranches was synchronous and only checked req.user.role === 'GYM_HOST' / PLATFORM_ADMIN.
 * - For an owner whose account role is MEMBER, hasAllBranches was false.
 * - branchIdsWithAnyGrant fell back to resolving grants per branch, but ownerGrants() has
 *   map: {}, so grants.keys().length === 0, returning [] (0 branches).
 * - GET /gyms/branches returned 0 branches.
 * - Other routes using hasAllBranches / branchIdsWithAnyGrant / can.atAnyBranch failed or were restricted.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { signToken } = require('../../src/utils/jwt.utils');
const { hasAllBranches, branchIdsWithAnyGrant } = require('../../src/utils/branchAccess.utils');

let app;
let team;
let dbHarness;
let personas;
let memberRoleOwnerToken;
let memberRoleOwnerUser;
let subPlan;
let trainer;

const BANK = { bankName: 'Standard Chartered', accountTitle: 'Owner Member Corp', accountNumber: '1234-5678-9012' };
const thisMonth = () => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date().getMonth()];

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);

  const { Tenant, User, GymListing } = require('../../src/models/platform');
  const { teamMember } = require('../harness/two-branch-team');

  // Set bank details on team's tenant
  await Tenant.update({ paymentDetailsJson: BANK }, { where: { id: team.tenantId } });

  // Create a tenant owner user whose account role is MEMBER (users.role = 'MEMBER')
  memberRoleOwnerUser = await factories.createUser({
    email: 'owner-member-role@new47.test',
    role: 'MEMBER',
    fullName: 'Owner Member',
  });

  // Transfer tenant ownership to this MEMBER-role user
  await Tenant.update({ ownerUserId: memberRoleOwnerUser.id }, { where: { id: team.tenantId } });

  // Update listing hostUserId to match
  await GymListing.update({ hostUserId: memberRoleOwnerUser.id }, { where: { tenantId: team.tenantId } });

  // Sign token for the owner with role: 'MEMBER'
  memberRoleOwnerToken = signToken({
    sub: memberRoleOwnerUser.id,
    id: memberRoleOwnerUser.id,
    email: memberRoleOwnerUser.email,
    role: 'MEMBER',
    isVerified: true,
    tenantId: team.tenantId,
  });

  // Create a Trainer at branch A (has no members.create)
  trainer = await teamMember({
    tenantDb: dbHarness.tenant1,
    tenantId: team.tenantId,
    email: 'trainer@new47.test',
    roleKey: 'TRAINER',
    scopeType: 'BRANCH',
    branchIds: [team.branchA.id],
  });

  // Create member in branch A and member in branch B
  const now = new Date();
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const memberAUser = await factories.createUser({ email: 'member-a@new47.test', role: 'MEMBER' });
  const memberBUser = await factories.createUser({ email: 'member-b@new47.test', role: 'MEMBER' });

  subPlan = await dbHarness.tenant1.models.MembershipPlan.create({
    gymId: team.branchA.gymId,
    branchId: team.branchA.id,
    name: 'Sub Plan',
    price: 3000,
    durationType: 'MONTHLY',
    durationValue: 1,
    status: 'ACTIVE',
  });
  await dbHarness.tenant1.models.MemberSubscription.create({
    userId: memberAUser.id,
    branchId: team.branchA.id,
    membershipPlanId: subPlan.id,
    startDate: now,
    endDate: future,
    status: 'ACTIVE',
  });
  await dbHarness.tenant1.models.MemberSubscription.create({
    userId: memberBUser.id,
    branchId: team.branchB.id,
    membershipPlanId: subPlan.id,
    startDate: now,
    endDate: future,
    status: 'ACTIVE',
  });

  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const reqGet = (path, token) =>
  request(app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId);

const reqPost = (path, token, body = {}) =>
  request(app).post(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId).send(body);

const reqPatch = (path, token, body = {}) =>
  request(app).patch(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId).send(body);

const reqDelete = (path, token, body = {}) =>
  request(app).delete(`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId).send(body);

describe('NEW-47: tenant owner with account role MEMBER access', () => {
  describe('Direct utility checks', () => {
    test('hasAllBranches returns true for tenant owner with role MEMBER', async () => {
      const req = {
        user: { id: memberRoleOwnerUser.id, role: 'MEMBER', tenantId: team.tenantId },
        tenantDb: dbHarness.tenant1,
        tenantId: team.tenantId,
      };
      const res = await hasAllBranches(req);
      expect(res).toBe(true);
    });

    test('branchIdsWithAnyGrant returns null (all branches) for tenant owner with role MEMBER', async () => {
      const req = {
        user: { id: memberRoleOwnerUser.id, role: 'MEMBER', tenantId: team.tenantId },
        tenantDb: dbHarness.tenant1,
        tenantId: team.tenantId,
      };
      const res = await branchIdsWithAnyGrant(req);
      expect(res).toBeNull();
    });
  });

  describe('Branches listing (GET /gyms/branches)', () => {
    test('owner with role MEMBER sees every branch (A and B)', async () => {
      const res = await reqGet('/gyms/branches', memberRoleOwnerToken);
      expect(res.status).toBe(200);
      const branchIds = res.body.data.branches.map((b) => b.id).sort();
      expect(branchIds).toEqual([team.branchA.id, team.branchB.id].sort());
    });

    test('listBranches directly with req.user.role = MEMBER returns all branches', async () => {
      const { listBranches } = require('../../src/controllers/gyms.controller');
      const req = {
        user: { id: memberRoleOwnerUser.id, role: 'MEMBER', tenantId: team.tenantId },
        tenantDb: dbHarness.tenant1,
        params: {},
        query: {},
      };
      let resData;
      const res = {
        status: () => res,
        json: (d) => { resData = d; return res; },
      };
      await listBranches(req, res, (err) => { if (err) throw err; });
      expect(resData.data.branches.length).toBe(2);
    });

    test('Front Desk clerk at branch A sees only branch A', async () => {
      const res = await reqGet('/gyms/branches', team.frontDeskOff.token);
      expect(res.status).toBe(200);
      const branchIds = res.body.data.branches.map((b) => b.id);
      expect(branchIds).toEqual([team.branchA.id]);
    });
  });

  describe('Members listing (GET /gyms/members)', () => {
    test('owner with role MEMBER sees all members across all branches', async () => {
      const res = await reqGet('/gyms/members', memberRoleOwnerToken);
      expect(res.status).toBe(200);
      expect(res.body.data.members.length).toBeGreaterThanOrEqual(2);
    });

    test('Front Desk clerk sees only members of their assigned branch A', async () => {
      const res = await reqGet('/gyms/members', team.frontDeskOff.token);
      expect(res.status).toBe(200);
      expect(res.body.data.members.length).toBe(1);
    });
  });

  describe('Reports (GET /reports/dashboard and GET /reports/yearly)', () => {
    test('owner with role MEMBER sees total revenue across all branches (1,000 + 7,000 = 8,000)', async () => {
      const resDash = await reqGet('/reports/dashboard', memberRoleOwnerToken);
      expect(resDash.status).toBe(200);
      expect(Number(resDash.body.data.revenue.allTime)).toBe(8000);

      const resYearly = await reqGet('/reports/yearly', memberRoleOwnerToken);
      expect(resYearly.status).toBe(200);
      const mRev = resYearly.body.data.data.find((m) => m.month === thisMonth())?.revenue;
      expect(Number(mRev)).toBe(8000);
    });

    test('Front Desk clerk cannot access revenue reports (403 Forbidden)', async () => {
      const resDash = await reqGet('/reports/dashboard', team.frontDeskOff.token);
      expect(resDash.status).toBe(403);

      const resYearly = await reqGet('/reports/yearly', team.frontDeskOff.token);
      expect(resYearly.status).toBe(403);
    });
  });

  describe('Gym Profile & Bank Details (GET /gyms/profile and PATCH /gyms/profile)', () => {
    test('owner with role MEMBER gets paymentDetailsJson on GET /gyms/profile', async () => {
      const res = await reqGet('/gyms/profile', memberRoleOwnerToken);
      expect(res.status).toBe(200);
      expect(res.body.data.gym.paymentDetailsJson).toEqual(BANK);
    });

    test('Front Desk clerk gets profile WITHOUT paymentDetailsJson', async () => {
      const res = await reqGet('/gyms/profile', team.frontDeskOff.token);
      expect(res.status).toBe(200);
      expect(res.body.data.gym).not.toHaveProperty('paymentDetailsJson');
    });

    test('owner with role MEMBER can update paymentDetailsJson on PATCH /gyms/profile with re-auth', async () => {
      const updatedBank = { bankName: 'Meezan Bank', accountTitle: 'Owner Member Corp', accountNumber: '9999-8888-7777' };
      const res = await reqPatch('/gyms/profile', memberRoleOwnerToken, {
        paymentDetailsJson: updatedBank,
        password: 'Test@12345',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.gym.paymentDetailsJson).toEqual(updatedBank);
    });

    test('Front Desk clerk cannot update bank details (403 Forbidden)', async () => {
      const res = await reqPatch('/gyms/profile', team.frontDeskOff.token, {
        paymentDetailsJson: { bankName: 'Hacker Bank' },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('Member search (GET /gyms/members/search)', () => {
    test('owner with role MEMBER can search members by email', async () => {
      const res = await reqGet('/gyms/members/search?email=member-a@new47.test', memberRoleOwnerToken);
      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('member-a@new47.test');
    });

    test('Trainer without members.create cannot search members (403 Forbidden)', async () => {
      const res = await reqGet('/gyms/members/search?email=member-a@new47.test', trainer.token);
      expect(res.status).toBe(403);
    });
  });

  describe('Member enroll (POST /gyms/members/enroll)', () => {
    test('owner with role MEMBER gets direct 201 Created enrolment', async () => {
      const res = await reqPost('/gyms/members/enroll', memberRoleOwnerToken, {
        branchId: team.branchA.id,
        planId: subPlan.id,
        email: 'walkin-owner@new47.test',
        fullName: 'Walk In Owner',
        startDate: new Date().toISOString().split('T')[0],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.subscription).toBeTruthy();
    });

    test('Front Desk clerk enrolment returns 202 Accepted (pending approval)', async () => {
      const res = await reqPost('/gyms/members/enroll', team.frontDeskOff.token, {
        branchId: team.branchA.id,
        planId: subPlan.id,
        email: 'walkin-desk@new47.test',
        fullName: 'Walk In Desk',
        startDate: new Date().toISOString().split('T')[0],
      });
      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe('PENDING');
    });
  });

  describe('Image routes permissions (can guards)', () => {
    test('owner with role MEMBER passes permission check on profile image upload (422 no file, not 403)', async () => {
      const resLogo = await reqPost('/gyms/profile/logo', memberRoleOwnerToken);
      expect(resLogo.status).toBe(422);

      const resCover = await reqPost('/gyms/profile/cover', memberRoleOwnerToken);
      expect(resCover.status).toBe(422);

      const resGymImages = await reqPost('/gyms/profile/images', memberRoleOwnerToken);
      expect(resGymImages.status).toBe(422);

      const resBranchImages = await reqPost(`/gyms/branches/${team.branchA.id}/images`, memberRoleOwnerToken);
      expect(resBranchImages.status).toBe(422);
    });

    test('Front Desk clerk gets 403 Forbidden on profile image and other-branch image routes', async () => {
      const resLogo = await reqPost('/gyms/profile/logo', team.frontDeskOff.token);
      expect(resLogo.status).toBe(403);

      const resCover = await reqPost('/gyms/profile/cover', team.frontDeskOff.token);
      expect(resCover.status).toBe(403);

      const resGymImages = await reqPost('/gyms/profile/images', team.frontDeskOff.token);
      expect(resGymImages.status).toBe(403);

      const resBranchBImages = await reqPost(`/gyms/branches/${team.branchB.id}/images`, team.frontDeskOff.token);
      expect(resBranchBImages.status).toBe(403);
    });
  });

  describe('Branch details & edit (GET & PATCH /gyms/branches/:branchId)', () => {
    test('owner with role MEMBER can view and update branch detail', async () => {
      const resGet = await reqGet(`/gyms/branches/${team.branchA.id}`, memberRoleOwnerToken);
      expect(resGet.status).toBe(200);
      expect(resGet.body.data.branch.id).toBe(team.branchA.id);

      const resPatch = await reqPatch(`/gyms/branches/${team.branchA.id}`, memberRoleOwnerToken, {
        branchName: 'Branch A Updated By Owner Member',
      });
      expect(resPatch.status).toBe(200);
      expect(resPatch.body.data.branch.branchName).toBe('Branch A Updated By Owner Member');
    });

    test('Front Desk clerk at branch A cannot view or edit branch B (404 not found)', async () => {
      const resGet = await reqGet(`/gyms/branches/${team.branchB.id}`, team.frontDeskOff.token);
      expect(resGet.status).toBe(404);

      const resPatch = await reqPatch(`/gyms/branches/${team.branchB.id}`, team.frontDeskOff.token, {
        branchName: 'Hacked Branch B',
      });
      expect(resPatch.status).toBe(404);
    });
  });
});
