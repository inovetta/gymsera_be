/**
 * Phase 7 P5 — NEW-147 (found in P4; the BUG-22 New Organization walk goes through the same code).
 *
 * New Organization > "Build a brand new branch" (POST /host/listings) and Add Branch
 * (POST /host/branches) both build through gym.service.js#_createBranchRecord, which created every
 * plan with isPublic: true, so "Show to Travellers" off was ignored. After: isPublic is kept
 * (absent = visible, as provisioning does), and a branch whose plans are all hidden is refused
 * 422 visible_plan_required before anything is created (BUG-05 rule).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

let personas;
let tenantDb;
let primary; // the owner's first organization (harness)

const plan = (name, isPublic) => ({ name, price: 1500, durationType: 'MONTHLY', durationValue: 1, ...(isPublic === undefined ? {} : { isPublic }) });

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  primary = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId }, order: [['createdAt', 'ASC']] });
  // Room for the organizations and branches these tests build.
  const [updated] = await TenantSubscription.update({ branchCount: 50 }, { where: { tenantId: personas.owner.tenantId } });
  expect(updated).toBeGreaterThan(0);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

// A PENDING organization blocks creating the next one until an admin approves it.
const approvePending = () =>
  GymListing.update({ status: 'ACTIVE' }, { where: { tenantId: personas.owner.tenantId, status: 'PENDING' } });

const newOrg = async (gymName, packages = [plan(`${gymName} Monthly`)]) => {
  await approvePending();
  const res = await asPersona('owner').post('/host/listings', { gymName, branchSource: 'new', cityId: 1, packages });
  expect(res.status).toBe(201);
  await approvePending();
  return res.body.data;
};

const plansOf = async (branchId) =>
  tenantDb.models.MembershipPlan.findAll({ where: { branchId }, order: [['name', 'ASC']] });

describe('NEW-147: "Show to Travellers" is kept when a branch is built', () => {
  test('New Organization: a hidden plan stays hidden, a visible one stays visible', async () => {
    const org = await newOrg('P5 Mixed Org', [plan('A visible', true), plan('B hidden', false)]);
    const plans = await plansOf(org.branch.id);
    expect(plans.map((p) => [p.name, p.isPublic])).toEqual([['A visible', true], ['B hidden', false]]);
  });

  test('New Organization: no isPublic sent = visible (what provisioning does)', async () => {
    const org = await newOrg('P5 Default Org', [plan('Plain')]);
    expect((await plansOf(org.branch.id)).map((p) => p.isPublic)).toEqual([true]);
  });

  test('New Organization: every plan hidden = 422 visible_plan_required, nothing created', async () => {
    await approvePending();
    const before = await GymListing.count({ where: { tenantId: personas.owner.tenantId } });
    const res = await asPersona('owner').post('/host/listings', {
      gymName: 'P5 Hidden Org', branchSource: 'new', cityId: 1, packages: [plan('Hidden', false)],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('visible_plan_required');
    expect(await GymListing.count({ where: { tenantId: personas.owner.tenantId } })).toBe(before);
    expect(await tenantDb.models.Branch.count({ where: { branchName: 'P5 Hidden Org' } })).toBe(0);
    expect(await tenantDb.models.Gym.count({ where: { name: 'P5 Hidden Org' } })).toBe(0);
  });

  test('Add Branch: hidden plans stay hidden; all hidden = 422, no branch', async () => {
    const ok = await asPersona('owner').post('/host/branches', {
      branchName: 'P5 Add Branch', gymListingId: primary.id, address: '1 Mall Road', cityId: 1,
      packages: [plan('A visible', true), plan('B hidden', false)],
    });
    expect(ok.status).toBe(201);
    const branchId = (ok.body.data.branch || ok.body.data).id;
    expect((await plansOf(branchId)).map((p) => [p.name, p.isPublic])).toEqual([['A visible', true], ['B hidden', false]]);

    const refused = await asPersona('owner').post('/host/branches', {
      branchName: 'P5 Add Branch Hidden', gymListingId: primary.id, address: '1 Mall Road', cityId: 1,
      packages: [plan('Hidden', false)],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('visible_plan_required');
    expect(await tenantDb.models.Branch.count({ where: { branchName: 'P5 Add Branch Hidden' } })).toBe(0);
  });
});
