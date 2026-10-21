/**
 * NEW-100 / NEW-99: every /trainers route is guarded by can(), not the legacy authorize().
 *
 * Before: POST /trainers and POST /trainers/:id/assign were owner-only (authorize('GYM_HOST')) although
 * schedule.trainer.assign is Direct for Org Admin and Manager; the rest sat behind
 * authorize('GYM_HOST','BRANCH_MANAGER'), which the compatibility shim satisfies for any team member.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');

let app;
let dbHarness;
let personas;
let branchA;
let branchB;
let people;

const call = (method, token, url, body) =>
  request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body || {});

const newUser = async (label) =>
  (await factories.createUser({ email: `${label}@new100.test`, role: 'MEMBER', fullName: label })).id;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  app = await startTestServer();
  const tenantDb = dbHarness.tenant1;
  const tenantId = personas.owner.tenantId;
  const listing = await GymListing.findOne({ where: { tenantId } });
  branchA = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
  branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B' });
  const make = (email, roleKey, scopeType, branchIds) =>
    teamMember({ tenantDb, tenantId, email, roleKey, scopeType, branchIds });
  people = {
    managerA: await make('mgr-a@new100.test', 'MANAGER', 'BRANCH', [branchA.id]),
    orgAdmin: await make('orgadmin@new100.test', 'ORG_ADMIN', 'ORG', []),
    desk: await make('desk@new100.test', 'DESK', 'BRANCH', [branchA.id]),
  };
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-100: the router no longer uses the legacy authorize()', () => {
  test('src/routes/trainers.routes.js has no authorize( call', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/trainers.routes.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bauthorize\s*\(/);
  });
});

describe('NEW-99: POST /trainers', () => {
  test('a branch manager can add a trainer at their branch', async () => {
    const res = await call('post', people.managerA.token, '/trainers', { userId: await newUser('t1'), branchId: branchA.id, specialization: 'Yoga' });
    expect(res.status).toBe(201);
  });

  test('a branch manager cannot add a trainer at another branch, or one with no branch', async () => {
    expect((await call('post', people.managerA.token, '/trainers', { userId: await newUser('t2'), branchId: branchB.id })).status).toBe(403);
    expect((await call('post', people.managerA.token, '/trainers', { userId: await newUser('t3') })).status).toBe(403);
  });

  test('an org admin can add one anywhere, with or without a branch', async () => {
    expect((await call('post', people.orgAdmin.token, '/trainers', { userId: await newUser('t4'), branchId: branchB.id })).status).toBe(201);
    expect((await call('post', people.orgAdmin.token, '/trainers', { userId: await newUser('t5') })).status).toBe(201);
  });

  test('a front desk clerk cannot', async () => {
    expect((await call('post', people.desk.token, '/trainers', { userId: await newUser('t6'), branchId: branchA.id })).status).toBe(403);
  });
});

describe('NEW-99: POST /trainers/:id/assign needs the key at the trainer and at the target branch', () => {
  let trainerAtA;
  beforeAll(async () => {
    trainerAtA = (await dbHarness.tenant1.models.Trainer.create({ userId: await newUser('assign-me'), branchId: branchA.id, status: 'ACTIVE' })).id;
  });

  test('a manager of branch A cannot move a trainer to branch B', async () => {
    const res = await call('post', people.managerA.token, `/trainers/${trainerAtA}/assign`, { branchId: branchB.id });
    expect(res.status).toBe(403);
    expect((await dbHarness.tenant1.models.Trainer.findByPk(trainerAtA)).branchId).toBe(branchA.id);
  });

  test('an org admin can', async () => {
    const res = await call('post', people.orgAdmin.token, `/trainers/${trainerAtA}/assign`, { branchId: branchB.id });
    expect(res.status).toBe(200);
    expect((await dbHarness.tenant1.models.Trainer.findByPk(trainerAtA)).branchId).toBe(branchB.id);
  });

  test('a front desk clerk cannot', async () => {
    expect((await call('post', people.desk.token, `/trainers/${trainerAtA}/assign`, { branchId: branchA.id })).status).toBe(403);
  });
});

describe('listing still works for team members who hold team.view', () => {
  test('a manager lists trainers', async () => {
    expect((await call('get', people.managerA.token, '/trainers')).status).toBe(200);
  });
});
