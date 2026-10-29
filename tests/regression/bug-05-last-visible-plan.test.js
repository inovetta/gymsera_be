/**
 * BUG-05 (Phase 7 P4) — a branch always keeps at least one plan travellers can see.
 *
 * Discovery hides a branch with no ACTIVE, public plan (discovery.service.js), so a host who hides,
 * deactivates or deletes the last one takes the gym off the traveller side without being told.
 * A plan counts for a branch when it is ACTIVE, not deactivated, public, and either for that branch
 * or for every branch (branchId null).
 *
 * Before: membership-plan.service.js#_validateRemainingPlansForBranch skipped gym-wide plans,
 * counted only branch plans (so a gym-wide visible plan did not count), answered 400 without a
 * code, refused a save of a plan that was already hidden, and had no lock (two hides at once could
 * both pass). Onboarding submit checked the plan count only, so every plan could be hidden.
 * After: one rule, 422 `last_visible_plan` / `visible_plan_required`, checked under a branch lock.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing, Tenant } = require('../../src/models/platform');

let tenantDb;
let personas;
let listing;
let branch1; // the personas' branch (manager and front desk are scoped to it)

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
  branch1 = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

let n = 0;
const plan = async (branchId, overrides = {}) => {
  const { MembershipPlan, Gym } = tenantDb.models;
  const gym = await Gym.findOne();
  n += 1;
  return MembershipPlan.create({
    gymId: gym.id,
    branchId,
    name: `B05 plan ${n}`,
    price: 1000 + n,
    durationType: 'MONTHLY',
    durationValue: 1,
    status: 'ACTIVE',
    isDeactivated: false,
    isPublic: true,
    ...overrides,
  });
};

// A fresh branch per scenario, so plans from one scenario never count in another.
const freshBranch = (overrides = {}) => factories.createBranch(tenantDb, listing.id, overrides);

const reload = (p) => tenantDb.models.MembershipPlan.findByPk(p.id);

const expectRefused = (res) => {
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('last_visible_plan');
};

describe('BUG-05: the last traveller-visible plan of a branch cannot be hidden, deactivated or deleted', () => {
  test('hide (POST /:id/public) the only visible plan: 422, still public', async () => {
    const b = await freshBranch();
    const p = await plan(b.id);
    expectRefused(await asPersona('owner').post(`/membership-plans/${p.id}/public`).send({}));
    expect((await reload(p)).isPublic).toBe(true);
  });

  test('deactivate (POST /:id/status) the only visible plan: 422, still active', async () => {
    const b = await freshBranch();
    const p = await plan(b.id);
    expectRefused(await asPersona('owner').post(`/membership-plans/${p.id}/status`).send({}));
    expect((await reload(p)).isDeactivated).toBe(false);
  });

  test('delete (DELETE /:id) the only visible plan: 422, still ACTIVE', async () => {
    const b = await freshBranch();
    const p = await plan(b.id);
    expectRefused(await asPersona('owner').delete(`/membership-plans/${p.id}`));
    expect((await reload(p)).status).toBe('ACTIVE');
  });

  test.each([
    ['isPublic false', { isPublic: false }],
    ['status INACTIVE', { status: 'INACTIVE' }],
  ])('PATCH %s on the only visible plan: 422, unchanged', async (_label, body) => {
    const b = await freshBranch();
    const p = await plan(b.id);
    expectRefused(await asPersona('owner').patch(`/membership-plans/${p.id}`).send(body));
    const after = await reload(p);
    expect([after.isPublic, after.isDeactivated, after.status]).toEqual([true, false, 'ACTIVE']);
  });

  test('PATCH isDeactivated is not accepted at all (deactivation goes through POST /:id/status)', async () => {
    const b = await freshBranch();
    const p = await plan(b.id);
    const res = await asPersona('owner').patch(`/membership-plans/${p.id}`).send({ isDeactivated: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_error');
    expect((await reload(p)).isDeactivated).toBe(false);
  });

  test('two visible plans: the first can be hidden, the second cannot', async () => {
    const b = await freshBranch();
    const p1 = await plan(b.id);
    const p2 = await plan(b.id);
    const first = await asPersona('owner').post(`/membership-plans/${p1.id}/public`).send({});
    expect(first.status).toBe(200);
    expect(first.body.data.plan.isPublic).toBe(false);
    expectRefused(await asPersona('owner').post(`/membership-plans/${p2.id}/public`).send({}));
    expect((await reload(p2)).isPublic).toBe(true);
  });

  test('a gym-wide plan that is some branch\'s only visible plan cannot be hidden', async () => {
    // branch1 and every other branch already have visible plans from other scenarios or none at all;
    // this branch has nothing of its own, so the gym-wide plan is what travellers see there.
    const b = await freshBranch();
    const gymWide = await plan(null);
    expectRefused(await asPersona('owner').post(`/membership-plans/${gymWide.id}/public`).send({}));
    expect((await reload(gymWide)).isPublic).toBe(true);
    await gymWide.update({ isPublic: false }); // leave no gym-wide plan behind for the other scenarios
    await b.update({ status: 'INACTIVE' });
  });

  test('a visible gym-wide plan counts: the branch plan can then be hidden', async () => {
    const b = await freshBranch();
    const own = await plan(b.id);
    const gymWide = await plan(null);
    const res = await asPersona('owner').post(`/membership-plans/${own.id}/public`).send({});
    expect(res.status).toBe(200);
    await gymWide.update({ isPublic: false });
    await b.update({ status: 'INACTIVE' });
  });

  test('saving a plan that is already hidden is not refused (nothing becomes hidden)', async () => {
    // A branch that already has no visible plan (data from before this rule) must still be editable.
    const b = await freshBranch();
    const hidden = await plan(b.id, { isPublic: false });
    const res = await asPersona('owner').patch(`/membership-plans/${hidden.id}`).send({ price: 2500, isPublic: false });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.plan.price)).toBe(2500);
  });

  test('hiding a plan that is already hidden by another flag (deactivated) is not refused', async () => {
    const b = await freshBranch();
    await plan(b.id);
    const off = await plan(b.id, { isDeactivated: true, isPublic: false });
    const res = await asPersona('owner').delete(`/membership-plans/${off.id}`);
    expect(res.status).toBe(200);
  });

  test('a branch that was deleted (INACTIVE) is not protected', async () => {
    const b = await freshBranch();
    const p = await plan(b.id);
    await b.update({ status: 'INACTIVE' });
    const res = await asPersona('owner').post(`/membership-plans/${p.id}/public`).send({});
    expect(res.status).toBe(200);
  });

  test('two hides at the same time on the last two visible plans: exactly one passes', async () => {
    const b = await freshBranch();
    const p1 = await plan(b.id);
    const p2 = await plan(b.id);
    const results = await Promise.all([
      asPersona('owner').post(`/membership-plans/${p1.id}/public`).send({}),
      asPersona('owner').post(`/membership-plans/${p2.id}/public`).send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const visible = await tenantDb.models.MembershipPlan.count({ where: { branchId: b.id, isPublic: true } });
    expect(visible).toBe(1);
  });
});

describe('BUG-05: personas on the hide route', () => {
  let only;

  beforeAll(async () => {
    // branch1 gets exactly one visible plan of its own; no gym-wide visible plan exists here.
    await tenantDb.models.MembershipPlan.update({ isPublic: false }, { where: { branchId: branch1.id } });
    only = await plan(branch1.id);
  });

  test('owner: 422', async () => {
    expectRefused(await asPersona('owner').post(`/membership-plans/${only.id}/public`).send({}));
  });

  test('manager of that branch: 422 (same rule for staff)', async () => {
    expectRefused(await asPersona('manager').post(`/membership-plans/${only.id}/public`).send({}));
  });

  test('member naming this gym: 404 from tenantContext (not a member; existence not revealed)', async () => {
    const res = await asPersona('member', { 'X-Tenant-Id': personas.owner.tenantId })
      .post(`/membership-plans/${only.id}/public`).send({});
    expect(res.status).toBe(404);
  });

  test('owner of another gym: 404 (the plan is not in their gym), plan unchanged', async () => {
    const res = await asPersona('otherTenantOwner').post(`/membership-plans/${only.id}/public`).send({});
    expect(res.status).toBe(404);
  });

  afterAll(async () => {
    expect((await reload(only)).isPublic).toBe(true);
  });
});

describe('BUG-05: onboarding submit needs at least one plan shown to travellers', () => {
  const host = async (key, plans) => {
    const user = await factories.createUser({ email: `${key}@bug05.test`, role: 'GYM_HOST', isHost: true });
    const tenant = await factories.createTenant({
      ownerUserId: user.id,
      gymName: `${key} Gym`,
      status: 'DRAFT',
      connectionStringEncrypted: 'PENDING_PROVISIONING',
      mainBranchDataJson: { branchName: 'Main', plans },
    });
    const { signToken } = require('../../src/utils/jwt.utils');
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
    return { tenant, token };
  };

  const finalize = ({ tenant, token }) => asPersona('anonymous', { Authorization: `Bearer ${token}` })
    .post(`/tenants/${tenant.id}/finalize`)
    .send({ paymentMethod: 'IN_APP_PURCHASE' });

  test('every plan hidden: 422 visible_plan_required, not submitted', async () => {
    const h = await host('allhidden', [
      { name: 'Monthly', price: 5000, isPublic: false },
      { name: 'Daily', price: 500, isPublic: false },
    ]);
    const res = await finalize(h);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('visible_plan_required');
    expect((await Tenant.findByPk(h.tenant.id)).status).toBe('DRAFT');
  });

  test('one plan shown (isPublic true or not sent): submitted', async () => {
    const shown = await finalize(await host('oneshown', [
      { name: 'Monthly', price: 5000, isPublic: false },
      { name: 'Daily', price: 500, isPublic: true },
    ]));
    expect(shown.status).toBe(200);
    // Provisioning treats a plan without isPublic as visible (tenant-provisioning.service.js), so does submit.
    const unset = await finalize(await host('unset', [{ name: 'Monthly', price: 5000 }]));
    expect(unset.status).toBe(200);
  });
});
