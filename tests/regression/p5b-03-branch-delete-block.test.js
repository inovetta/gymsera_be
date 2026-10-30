/**
 * P5b items 3, 4 and 5 (R-81 revised) — the branch lifecycle rules for money and members.
 *
 * Item 3: deleting a branch, or an organization (= deleting its branches in one tenant
 * transaction, all or nothing), is refused with 409 and counts when the branch still has
 * paid-up active memberships, upcoming bookings (a pending request, or a paid membership
 * that has not started), pending payments or cash-collected payments. No refund logic: the
 * host resolves them or waits, or pauses the branch instead.
 * Before: deleteBranch (gym.service.js) cancelled every ACTIVE/PENDING/FROZEN membership and
 * left pending payments behind; deleteOrganization deleted branch by branch, each in its
 * own transaction.
 *
 * Item 4: approving (or collecting) a payment at a branch that is not ACTIVE is refused.
 * Before: verifyPayment only checked the billing lock, so a pending payment at a deleted
 * branch could still be completed: money taken, no membership.
 *
 * Item 5: the memberships a delete cancels are cancelled in the platform copy
 * (UserGymMembership) too. Before: a bulk update in the tenant DB only.
 */
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const paymentService = require('../../src/services/payment.service');
const { ERROR_COPY } = require('../../src/constants/error-copy');

let dbHarness;
let personas;
let ctx;
let models;

const PASSWORD = 'Test@12345';
const day = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  ctx = require('../harness/personas').personaManager.context;
  models = dbHarness.tenant1.models;
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

/** A fresh organization with `count` branches, so the last-branch warning never gets in the way. */
const makeOrg = async (title, count = 2) => {
  const listing = await factories.createGymListing(ctx.tenant1.id, { title });
  const branches = [];
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    branches.push(await factories.createBranch(dbHarness.tenant1, listing.id, { name: `${title} ${i + 1}` }));
  }
  return { listing, branches };
};

const addMembership = async (branch, { status = 'ACTIVE', startDate = day(-10), endDate = day(20), mirror = false } = {}) => {
  const plan = await models.MembershipPlan.create({
    branchId: branch.id,
    gymId: branch.gymId,
    name: `Plan ${uuidv4().slice(0, 6)}`,
    price: 5000,
    durationType: 'MONTHLY',
    status: 'ACTIVE',
  });
  const member = await factories.createUser({ role: 'MEMBER', email: `m-${uuidv4().slice(0, 8)}@p5b.test` });
  const sub = await models.MemberSubscription.create({
    userId: member.id,
    branchId: branch.id,
    membershipPlanId: plan.id,
    startDate,
    endDate,
    status,
    subscribedAt: new Date(),
  });
  if (mirror) {
    const { UserGymMembership } = require('../../src/models/platform');
    await UserGymMembership.create({
      userId: member.id,
      tenantId: ctx.tenant1.id,
      gymListingId: branch.gymListingId,
      subscriptionId: sub.id,
      gymName: 'Alpha Fitness Club',
      planName: plan.name,
      status,
    });
  }
  return sub;
};

const deleteBranch = (branch) =>
  asPersona('owner').delete(`/gyms/branches/${branch.id}`, { password: PASSWORD, confirmOrganizationDeletion: true });

const statusOf = async (branch) => (await models.Branch.findByPk(branch.id)).status;

describe('P5b item 3: a branch with members or money in progress is not deleted', () => {
  test('a paid-up active membership → 409 branch_delete_blocked with counts; nothing changes', async () => {
    const { branches: [branch] } = await makeOrg('Block Active');
    const sub = await addMembership(branch);

    const res = await deleteBranch(branch);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('branch_delete_blocked');
    expect(res.body.data.branchId).toBe(branch.id);
    expect(res.body.data.counts).toEqual({ activeMemberships: 1, upcomingBookings: 0, pendingPayments: 0, cashCollectedPayments: 0 });
    expect(res.body.data.reasons.map((r) => r.code)).toEqual(['active_memberships']);
    expect(res.body.data.canPause).toBe(true);
    expect(await statusOf(branch)).toBe('ACTIVE');
    expect((await models.MemberSubscription.findByPk(sub.id)).status).toBe('ACTIVE');
  });

  test('a frozen membership with time left counts as active', async () => {
    const { branches: [branch] } = await makeOrg('Block Frozen');
    await addMembership(branch, { status: 'FROZEN' });
    const res = await deleteBranch(branch);
    expect(res.status).toBe(409);
    expect(res.body.data.counts.activeMemberships).toBe(1);
  });

  test('a pending booking request and a paid membership that has not started are upcoming bookings', async () => {
    const { branches: [branch] } = await makeOrg('Block Upcoming');
    await addMembership(branch, { status: 'PENDING', startDate: day(1), endDate: day(31) });
    await addMembership(branch, { status: 'ACTIVE', startDate: day(3), endDate: day(33) });
    const res = await deleteBranch(branch);
    expect(res.status).toBe(409);
    expect(res.body.data.counts).toEqual({ activeMemberships: 0, upcomingBookings: 2, pendingPayments: 0, cashCollectedPayments: 0 });
    expect(res.body.data.reasons).toEqual([{ code: 'upcoming_bookings', count: 2 }]);
  });

  test('pending and cash-collected payments block it', async () => {
    const { branches: [branch] } = await makeOrg('Block Payments');
    await factories.createPayment(dbHarness.tenant1, branch.id, { status: 'PENDING', method: 'BANK_TRANSFER' });
    await factories.createPayment(dbHarness.tenant1, branch.id, { status: 'STAFF_COLLECTED' });
    const res = await deleteBranch(branch);
    expect(res.status).toBe(409);
    expect(res.body.data.counts).toEqual({ activeMemberships: 0, upcomingBookings: 0, pendingPayments: 1, cashCollectedPayments: 1 });
    expect(res.body.data.reasons.map((r) => r.code)).toEqual(['pending_payments', 'cash_collected_payments']);
  });

  test('completed, failed and expired payments and lapsed memberships do not block it', async () => {
    const { branches: [branch] } = await makeOrg('Clean Branch');
    await factories.createPayment(dbHarness.tenant1, branch.id, { status: 'COMPLETED' });
    await factories.createPayment(dbHarness.tenant1, branch.id, { status: 'EXPIRED' });
    await addMembership(branch, { status: 'EXPIRED', endDate: day(-5) });
    const res = await deleteBranch(branch);
    expect(res.status).toBe(200);
    expect(await statusOf(branch)).toBe('INACTIVE');
  });

  test('the block is checked after the password (a wrong password is still 401)', async () => {
    const { branches: [branch] } = await makeOrg('Block After Reauth');
    await addMembership(branch);
    const res = await asPersona('owner').delete(`/gyms/branches/${branch.id}`, { password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('P5b item 6: the last-branch copy says the organization is deleted too, not that it cannot be deleted', () => {
    expect(ERROR_COPY.last_branch_in_organization.en).toMatch(/also deletes the organization/);
    expect(ERROR_COPY.last_branch_in_organization.en).not.toMatch(/cannot delete/i);
  });

  test('the error code has copy in every language', () => {
    for (const code of ['branch_delete_blocked', 'organization_delete_blocked', 'branch_inactive']) {
      expect(ERROR_COPY[code]).toBeDefined();
      expect(ERROR_COPY[code].en).toBeTruthy();
      expect(ERROR_COPY[code].ur).toBeTruthy();
      expect(ERROR_COPY[code].ar).toBeTruthy();
    }
  });
});

describe('P5b item 5: memberships a delete cancels are cancelled in the platform copy', () => {
  test('a lapsed ACTIVE membership is cancelled in the tenant DB and in UserGymMembership', async () => {
    const { UserGymMembership } = require('../../src/models/platform');
    const { branches: [branch] } = await makeOrg('Mirror Sync');
    const lapsed = await addMembership(branch, { status: 'ACTIVE', startDate: day(-40), endDate: day(-2), mirror: true });

    const res = await deleteBranch(branch);
    expect(res.status).toBe(200);
    expect((await models.MemberSubscription.findByPk(lapsed.id)).status).toBe('CANCELLED');
    expect((await UserGymMembership.findOne({ where: { subscriptionId: lapsed.id } })).status).toBe('CANCELLED');
  });
});

describe('P5b item 3: deleting an organization is all or nothing', () => {
  test('one blocked branch → 409 organization_delete_blocked; no branch and not the organization is deleted', async () => {
    const { GymListing } = require('../../src/models/platform');
    const { listing, branches: [clean, busy] } = await makeOrg('Org Partly Busy');
    await addMembership(busy);

    const res = await asPersona('owner').delete(`/host/listings/${listing.id}`, { password: PASSWORD, strategy: 'deleteBranches' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('organization_delete_blocked');
    expect(res.body.data.listingId).toBe(listing.id);
    expect(res.body.data.counts.activeMemberships).toBe(1);
    expect(res.body.data.branches).toEqual([
      expect.objectContaining({ branchId: busy.id, branchName: busy.branchName, counts: expect.objectContaining({ activeMemberships: 1 }) }),
    ]);
    expect(res.body.data.canPause).toBe(true);
    expect(await statusOf(clean)).toBe('ACTIVE');
    expect(await statusOf(busy)).toBe('ACTIVE');
    expect((await GymListing.findByPk(listing.id)).status).toBe('ACTIVE');
  });

  test('every branch clean → all branches and the organization are deleted', async () => {
    const { GymListing } = require('../../src/models/platform');
    const { listing, branches } = await makeOrg('Org All Clean', 3);
    const res = await asPersona('owner').delete(`/host/listings/${listing.id}`, { password: PASSWORD, strategy: 'deleteBranches' });
    expect(res.status).toBe(200);
    for (const b of branches) {
      // eslint-disable-next-line no-await-in-loop
      expect(await statusOf(b)).toBe('INACTIVE');
    }
    expect((await GymListing.findByPk(listing.id)).status).toBe('INACTIVE');
  });

  test('a failure while deleting the second branch rolls back the first', async () => {
    const gymService = require('../../src/services/gym.service');
    const { listing, branches: [first, second] } = await makeOrg('Org Rollback');
    const { Announcement } = models;
    const original = Announcement.destroy.bind(Announcement);
    let calls = 0;
    const spy = jest.spyOn(Announcement, 'destroy').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated failure on the second branch');
      return original(...args);
    });
    try {
      await expect(
        gymService.deleteOrganization(dbHarness.tenant1, ctx.tenant1.id, listing.id, { strategy: 'deleteBranches', deletedByUserId: personas.owner.user.id })
      ).rejects.toThrow('simulated failure');
    } finally {
      spy.mockRestore();
    }
    expect(await statusOf(first)).toBe('ACTIVE');
    expect(await statusOf(second)).toBe('ACTIVE');
  });
});

describe('P5b item 4: no payment is approved at a branch that is not ACTIVE', () => {
  const inactiveBranchWithPayment = async (status) => {
    const { listing } = await makeOrg('Inactive Pay', 1);
    const branch = await factories.createBranch(dbHarness.tenant1, listing.id, { name: 'Closed Branch', status: 'INACTIVE' });
    const payment = await factories.createPayment(dbHarness.tenant1, branch.id, { status, method: 'BANK_TRANSFER' });
    return { branch, payment };
  };

  test('verify (final approval) → 409 branch_inactive, payment unchanged', async () => {
    const { payment } = await inactiveBranchWithPayment('PENDING');
    await expect(paymentService.verifyPayment(dbHarness.tenant1, payment.id, personas.owner.user.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'branch_inactive',
    });
    expect((await models.Payment.findByPk(payment.id)).status).toBe('PENDING');
  });

  test('cash collect → 409 branch_inactive, payment unchanged', async () => {
    const { payment } = await inactiveBranchWithPayment('PENDING');
    await expect(
      paymentService.verifyOrRejectPayment(dbHarness.tenant1, payment.id, personas.owner.user.id, 'GYM_HOST', { action: 'collect' })
    ).rejects.toMatchObject({ statusCode: 409, code: 'branch_inactive' });
    expect((await models.Payment.findByPk(payment.id)).status).toBe('PENDING');
  });

  test('rejecting it is still allowed, so the host can clear it', async () => {
    const { payment } = await inactiveBranchWithPayment('STAFF_COLLECTED');
    await paymentService.verifyOrRejectPayment(dbHarness.tenant1, payment.id, personas.owner.user.id, 'GYM_HOST', {
      action: 'reject',
      rejectedReason: 'Branch closed',
    });
    expect((await models.Payment.findByPk(payment.id)).status).not.toBe('STAFF_COLLECTED');
  });

  test('an ACTIVE branch still approves normally', async () => {
    const { branches: [branch] } = await makeOrg('Open Pay', 1);
    const payment = await factories.createPayment(dbHarness.tenant1, branch.id, { status: 'PENDING', method: 'BANK_TRANSFER' });
    await paymentService.verifyPayment(dbHarness.tenant1, payment.id, personas.owner.user.id);
    expect((await models.Payment.findByPk(payment.id)).status).toBe('COMPLETED');
  });
});
