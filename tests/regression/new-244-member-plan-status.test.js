/**
 * NEW-244: GET /gyms/members (the CMS Members list) reports each member's plan status the way the
 * mobile app's branch member list shows it, not only the platform account status.
 *
 * Owner report (2026-11-13): branch "savvvv" had four members; the CMS Status column said "Active"
 * for all four (users.status, the account), while the app said Expired for two (end dates
 * 2026-10-13 and 2026-11-12). The app derives the badge from the subscription
 * (members_list_screen.dart _buildStatusBadge): ACTIVE whose end date has passed = Expired,
 * ACTIVE ending within 3 days = Expiring, FROZEN = On hold, PENDING = Pending,
 * EXPIRED / CANCELLED = Expired.
 *
 * Verifies:
 * 1. `membershipStatus` per member: ACTIVE, EXPIRING, EXPIRED (ACTIVE row past its end date, and
 *    an EXPIRED row the daily job already flipped), FROZEN, PENDING; CANCELLED reads as EXPIRED.
 * 2. Members whose only subscription is EXPIRED are in the list (they were left out before).
 * 3. `planName`, `endDate`, `branchName` and the raw `subscriptionStatus` come with it.
 * 4. A member with an expired and a current subscription shows the current one.
 * 5. `?membershipStatus=` filters on those values (count and pages agree); unknown value = 422.
 * 6. `status` stays the account status, and `?status=` still filters on it (app gym-wide tab).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');
const { daysFromToday } = require('../harness/dates');

let app;
let personas;
let tenantId;
let branch;
let plan;
const m = {};

const sub = (tenantDb, userId, status, startOffset, endOffset, extra = {}) =>
  tenantDb.models.MemberSubscription.create({
    userId,
    membershipPlanId: plan.id,
    branchId: branch.id,
    status,
    startDate: daysFromToday(startOffset),
    endDate: daysFromToday(endOffset),
    ...extra,
  });

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();

  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const listing = await GymListing.findOne({ where: { tenantId } });
  branch = await factories.createBranch(tenantDb, listing.id, { name: 'Savvvv Test' });

  plan = await tenantDb.models.MembershipPlan.create({
    gymId: branch.gymId,
    branchId: branch.id,
    name: 'Monthly 244',
    price: 3000,
    durationType: 'MONTHLY',
    durationValue: 1,
    status: 'ACTIVE',
  });

  const mk = (key, extra = {}) =>
    factories.createUser({ email: `${key}@new244.test`, fullName: `N244 ${key}`, role: 'MEMBER', ...extra });

  m.active = await mk('active');
  m.expiring = await mk('expiring');
  m.lapsed = await mk('lapsed'); // ACTIVE row, end date passed, daily job has not run
  m.expired = await mk('expired'); // row already EXPIRED
  m.frozen = await mk('frozen');
  m.pending = await mk('pending');
  m.cancelled = await mk('cancelled');
  m.renewed = await mk('renewed'); // old EXPIRED row updated after the new ACTIVE one
  m.suspended = await mk('suspended', { status: 'SUSPENDED' });

  await sub(tenantDb, m.active.id, 'ACTIVE', -10, 60);
  await sub(tenantDb, m.expiring.id, 'ACTIVE', -28, 2);
  await sub(tenantDb, m.lapsed.id, 'ACTIVE', -61, -31);
  await sub(tenantDb, m.expired.id, 'EXPIRED', -61, -31);
  await sub(tenantDb, m.frozen.id, 'FROZEN', -10, 60, { freezeFrom: daysFromToday(-1), freezeTo: daysFromToday(10) });
  await sub(tenantDb, m.pending.id, 'PENDING', 0, 30);
  await sub(tenantDb, m.cancelled.id, 'CANCELLED', -5, 25);
  await sub(tenantDb, m.renewed.id, 'ACTIVE', -2, 28);
  const old = await sub(tenantDb, m.renewed.id, 'ACTIVE', -32, -3);
  await old.update({ status: 'EXPIRED' }); // the newest updatedAt is the expired row
  await sub(tenantDb, m.suspended.id, 'ACTIVE', -10, 60);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const getMembers = (query = '') =>
  request(app)
    .get(`/api/v1/gyms/members${query}`)
    .set('Authorization', `Bearer ${personas.owner.token}`)
    .set('X-Tenant-Id', tenantId);

const byId = (res) => new Map(res.body.data.members.map((row) => [row.id, row]));
const ours = (res) => res.body.data.members.filter((row) => row.email.endsWith('@new244.test'));

describe('NEW-244: GET /gyms/members reports the plan status like the app', () => {
  test('each member carries the plan status the app shows', async () => {
    const res = await getMembers(`?branchId=${branch.id}&limit=100`);
    expect(res.status).toBe(200);
    const rows = byId(res);
    const statusOf = (u) => rows.get(u.id)?.membershipStatus;

    expect(statusOf(m.active)).toBe('ACTIVE');
    expect(statusOf(m.expiring)).toBe('EXPIRING');
    expect(statusOf(m.lapsed)).toBe('EXPIRED');
    expect(statusOf(m.expired)).toBe('EXPIRED');
    expect(statusOf(m.frozen)).toBe('FROZEN');
    expect(statusOf(m.pending)).toBe('PENDING');
    expect(statusOf(m.cancelled)).toBe('EXPIRED');
    expect(statusOf(m.renewed)).toBe('ACTIVE');
    expect(statusOf(m.suspended)).toBe('ACTIVE');
  });

  test('plan name, end date, branch and the raw subscription status come with it', async () => {
    const res = await getMembers(`?branchId=${branch.id}&limit=100`);
    const lapsed = byId(res).get(m.lapsed.id);
    expect(lapsed.planName).toBe('Monthly 244');
    expect(String(lapsed.endDate).slice(0, 10)).toBe(daysFromToday(-31));
    expect(lapsed.branchName).toBe(branch.branchName);
    expect(lapsed.subscriptionStatus).toBe('ACTIVE');
    expect(byId(res).get(m.cancelled.id).subscriptionStatus).toBe('CANCELLED');
  });

  test('status stays the account status', async () => {
    const res = await getMembers(`?branchId=${branch.id}&limit=100`);
    const rows = byId(res);
    expect(rows.get(m.suspended.id).status).toBe('SUSPENDED');
    expect(rows.get(m.lapsed.id).status).toBe('ACTIVE');
  });

  test.each([
    ['ACTIVE', ['active', 'renewed', 'suspended']],
    ['EXPIRING', ['expiring']],
    ['EXPIRED', ['lapsed', 'expired', 'cancelled']],
    ['FROZEN', ['frozen']],
    ['PENDING', ['pending']],
  ])('?membershipStatus=%s lists exactly those members', async (value, keys) => {
    const res = await getMembers(`?branchId=${branch.id}&membershipStatus=${value}&limit=100`);
    expect(res.status).toBe(200);
    const got = ours(res).map((row) => row.id).sort();
    expect(got).toEqual(keys.map((k) => m[k].id).sort());
    expect(res.body.data.members.every((row) => row.membershipStatus === value)).toBe(true);
    expect(res.body.pagination.total).toBe(res.body.data.members.length);
  });

  test('the filter pages on the filtered set', async () => {
    const res = await getMembers(`?branchId=${branch.id}&membershipStatus=EXPIRED&limit=2&page=2`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.data.members).toHaveLength(1);
  });

  test('an unknown plan status is refused', async () => {
    const res = await getMembers('?membershipStatus=SOMETHING');
    expect(res.status).toBe(422);
  });

  test('?status= still filters on the account status (app gym-wide members tab)', async () => {
    const res = await getMembers(`?branchId=${branch.id}&status=SUSPENDED&limit=100`);
    expect(res.status).toBe(200);
    expect(ours(res).map((row) => row.id)).toEqual([m.suspended.id]);
  });

  test('search still works together with the plan status filter', async () => {
    const res = await getMembers(`?branchId=${branch.id}&membershipStatus=EXPIRED&q=lapsed`);
    expect(res.status).toBe(200);
    expect(res.body.data.members.map((row) => row.id)).toEqual([m.lapsed.id]);
  });

  test('no member data leaks beyond the fields the list already had', async () => {
    const res = await getMembers(`?branchId=${branch.id}&limit=1`);
    const keys = Object.keys(res.body.data.members[0]).sort();
    expect(keys).toEqual(
      ['id', 'fullName', 'email', 'phone', 'status', 'profileImageUrl', 'createdAt',
        'membershipStatus', 'subscriptionStatus', 'planName', 'endDate', 'branchName'].sort()
    );
  });
});
