/**
 * BUG-09 (Phase 7 P4) — every plan the API sends carries the currency it is sold in.
 *
 * The app labelled every plan price "PKR" because no plan payload had a currency: a plan has no
 * currency column, its branch does (GLB-02, tenant migration 019). Rule: a branch plan uses its
 * branch's currency; a gym-wide plan (branchId null) uses the branch it is shown for, else the
 * organization's first branch (the branch a new branch copies its currency from).
 *
 * Become a Host has no branch yet: the tenant payload says which currency approval will give the
 * first branch (`mainBranchCurrency`, R-80: PKR today), and provisioning uses that same value.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');

let tenantDb;
let personas;
let listing;
let first; // the organization's first branch (PKR)
let usd; // a second branch sold in USD
let usdPlan;
let pkrPlan;
let gymWide;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
  first = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id }, order: [['createdAt', 'ASC']] });
  await first.update({ currency: 'PKR' });
  usd = await factories.createBranch(tenantDb, listing.id, { name: 'USD branch', currency: 'USD' });
  // created_at has 1-second precision; make "first" unambiguous rather than relying on test timing.
  await tenantDb.sequelize.query('UPDATE branches SET created_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?', { replacements: [first.id] });

  const { MembershipPlan, Gym } = tenantDb.models;
  const gym = await Gym.findOne();
  const base = { gymId: gym.id, durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true };
  usdPlan = await MembershipPlan.create({ ...base, branchId: usd.id, name: 'USD monthly', price: 30 });
  pkrPlan = await MembershipPlan.create({ ...base, branchId: first.id, name: 'PKR monthly', price: 5000 });
  gymWide = await MembershipPlan.create({ ...base, branchId: null, name: 'Everywhere', price: 7000 });
  // Phase 7 P7a (NEW-159): the gym detail opens only for a live branch (R-77).
  await factories.makeBranchLive(tenantDb, usd);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const byId = (plans) => Object.fromEntries(plans.map((p) => [p.id, p.currency]));

describe('BUG-09: plan payloads carry the branch currency', () => {
  test('host list: branch plans use their branch, a gym-wide plan the first branch', async () => {
    const res = await asPersona('owner').get('/membership-plans/host');
    expect(res.status).toBe(200);
    const c = byId(res.body.data.plans);
    expect(c[usdPlan.id]).toBe('USD');
    expect(c[pkrPlan.id]).toBe('PKR');
    expect(c[gymWide.id]).toBe('PKR');
  });

  test('host list for one branch: a gym-wide plan uses that branch', async () => {
    const res = await asPersona('owner').get(`/membership-plans/host?branchId=${usd.id}`);
    expect(res.status).toBe(200);
    const c = byId(res.body.data.plans);
    expect(c[usdPlan.id]).toBe('USD');
    expect(c[gymWide.id]).toBe('USD');
  });

  test('create, update and toggle answers carry the currency', async () => {
    const created = await asPersona('owner').post('/membership-plans').send({
      branchId: usd.id, name: 'USD weekly', durationType: 'WEEKLY', durationValue: 1, price: 10, isPublic: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.plan.currency).toBe('USD');

    const id = created.body.data.plan.id;
    const updated = await asPersona('owner').patch(`/membership-plans/${id}`).send({ price: 12 });
    expect(updated.status).toBe(200);
    expect(updated.body.data.plan.currency).toBe('USD');

    const toggled = await asPersona('owner').post(`/membership-plans/${id}/public`).send({});
    expect(toggled.status).toBe(200);
    expect(toggled.body.data.plan.currency).toBe('USD');
  });

  test('public list for a branch and the public plan carry the currency', async () => {
    const list = await asPersona('anonymous').get(`/membership-plans?gymListingId=${listing.id}&branchId=${usd.id}`);
    expect(list.status).toBe(200);
    const c = byId(list.body.data.plans);
    expect(c[usdPlan.id]).toBe('USD');
    expect(c[gymWide.id]).toBe('USD');

    const one = await asPersona('anonymous').get(`/membership-plans/${usdPlan.id}?gymListingId=${listing.id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.plan.currency).toBe('USD');
  });

  test('discovery gym detail of the USD branch: its plans are USD', async () => {
    const res = await asPersona('anonymous').get(`/discovery/gyms/${usd.id}`);
    expect(res.status).toBe(200);
    const c = byId(res.body.data.membershipPlans);
    expect(c[usdPlan.id]).toBe('USD');
    expect(c[gymWide.id]).toBe('USD');
    expect(c[pkrPlan.id]).toBeUndefined(); // another branch's plan is not shown here
  });
});

describe('BUG-09: Become a Host says which currency the first branch will get', () => {
  test('GET /tenants/me carries mainBranchCurrency, the value provisioning uses', async () => {
    const user = await factories.createUser({ email: 'draft@bug09.test', role: 'GYM_HOST', isHost: true });
    await factories.createTenant({
      ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING',
      mainBranchDataJson: { branchName: 'Main', plans: [{ name: 'Monthly', price: 5000 }] },
    });
    const { signToken } = require('../../src/utils/jwt.utils');
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
    const res = await asPersona('anonymous', { Authorization: `Bearer ${token}` }).get('/tenants/me');
    expect(res.status).toBe(200);
    const { firstBranchCurrency } = require('../../src/utils/currency.utils');
    expect(firstBranchCurrency()).toBe('PKR');
    expect(res.body.data.tenant.mainBranchCurrency).toBe(firstBranchCurrency());
  });
});
