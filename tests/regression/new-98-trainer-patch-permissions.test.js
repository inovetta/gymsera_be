/**
 * NEW-98 (P1): PATCH /trainers/:id had no permission and no branch check. Any team member (the
 * tenant-context shim reads every assignment as BRANCH_MANAGER, so a Cleaner too) could edit or
 * deactivate any trainer in any branch.
 *
 * Now: schedule.trainer.assign is required at the trainer's branch (organization-wide for a trainer
 * with no branch). Out of scope or key missing = 403, and nothing changes.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');

let app;
let dbHarness;
let personas;
let tenantId;
let branchA;
let branchB;
let trainers; // { a, b, none }
let people;

const patch = (token, id, body) =>
  request(app).patch(`/api/v1/trainers/${id}`).set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();
  const tenantDb = dbHarness.tenant1;
  tenantId = personas.owner.tenantId;
  const listing = await GymListing.findOne({ where: { tenantId } });
  branchA = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
  branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });

  const { Trainer } = tenantDb.models;
  const mk = async (label, branchId) => {
    const u = await factories.createUser({ email: `trainer-${label}@new98.test`, role: 'MEMBER', fullName: `Trainer ${label}` });
    return (await Trainer.create({ userId: u.id, branchId, specialization: 'Yoga', status: 'ACTIVE' })).id;
  };
  trainers = { a: await mk('a', branchA.id), b: await mk('b', branchB.id), none: await mk('none', null) };

  const make = (email, roleKey, scopeType, branchIds, allow) =>
    teamMember({ tenantDb, tenantId, email, roleKey, scopeType, branchIds, allow });
  people = {
    managerA: await make('mgr-a@new98.test', 'MANAGER', 'BRANCH', [branchA.id]),
    orgAdmin: await make('orgadmin@new98.test', 'ORG_ADMIN', 'ORG', []),
    desk: await make('desk@new98.test', 'DESK', 'BRANCH', [branchA.id]),
    cleaner: await make('cleaner@new98.test', 'CLEANER', 'BRANCH', [branchA.id]),
  };
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const specialization = async (id) => (await dbHarness.tenant1.models.Trainer.findByPk(id)).specialization;
const status = async (id) => (await dbHarness.tenant1.models.Trainer.findByPk(id)).status;

describe('NEW-98: PATCH /trainers/:id', () => {
  test('a branch manager editing a trainer at another branch gets 403 and nothing changes', async () => {
    const res = await patch(people.managerA.token, trainers.b, { specialization: 'Hijacked' });
    expect(res.status).toBe(403);
    expect(await specialization(trainers.b)).toBe('Yoga');
  });

  test('a branch manager deactivating a trainer at another branch gets 403', async () => {
    const res = await patch(people.managerA.token, trainers.b, { status: 'INACTIVE' });
    expect(res.status).toBe(403);
    expect(await status(trainers.b)).toBe('ACTIVE');
  });

  test('a branch manager can edit a trainer at their own branch', async () => {
    const res = await patch(people.managerA.token, trainers.a, { specialization: 'Pilates' });
    expect(res.status).toBe(200);
    expect(await specialization(trainers.a)).toBe('Pilates');
  });

  test('a trainer with no branch is for organization-wide holders only', async () => {
    expect((await patch(people.managerA.token, trainers.none, { bio: 'x' })).status).toBe(403);
    expect((await patch(people.orgAdmin.token, trainers.none, { bio: 'by org admin' })).status).toBe(200);
  });

  test('schedule.trainer.assign is required: a front desk clerk and a cleaner get 403 even at their own branch', async () => {
    for (const who of ['desk', 'cleaner']) {
      const res = await patch(people[who].token, trainers.a, { specialization: 'Nope' });
      expect(res.status).toBe(403);
    }
    expect(await specialization(trainers.a)).toBe('Pilates');
  });

  test('the org admin and the owner can edit any trainer', async () => {
    expect((await patch(people.orgAdmin.token, trainers.b, { specialization: 'Boxing' })).status).toBe(200);
    expect((await patch(personas.owner.token, trainers.a, { specialization: 'Spin' })).status).toBe(200);
  });

  test('an unknown trainer id is 404 for someone who could manage trainers', async () => {
    const res = await patch(personas.owner.token, '11111111-1111-4111-8111-111111111199', { bio: 'x' });
    expect(res.status).toBe(404);
  });
});
