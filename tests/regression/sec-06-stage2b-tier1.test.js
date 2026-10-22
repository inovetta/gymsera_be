/**
 * SEC-06 stage 2b: the tier-1 routes (auth, payments, billing, team, approvals, ledger) and the routes whose
 * clients send fields the validator did not declare now declare their body fields and run strict in LOG mode.
 *  - tests/fixtures/sec-06-stage2b-bodies.json pins, per route, the declared fields (a drift guard: changing
 *    one is a conscious edit) and the keys the clients send (which must stay accepted).
 *  - validate.allowBody is the guard for routes that have no validator yet.
 *  - PATCH /trainers/:id also checks the permission at the branch a trainer is moved TO.
 */
const request = require('supertest');
const fixture = require('../fixtures/sec-06-stage2b-bodies.json');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { teamMember } = require('../harness/two-branch-team');
const { GymListing } = require('../../src/models/platform');
const walk = require('../harness/route-walk');

const ENV = ['UNKNOWN_FIELDS_MODE', 'UNKNOWN_FIELDS_STAGE2_MODE'];
const saved = {};
beforeEach(() => ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

let personas;
let app;
let tenantDb;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  tenantDb = h.tenant1;
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('declared fields per route (fixture)', () => {
  const routes = walk(require('../../app')._router.stack);
  test.each(fixture.routes.map((r) => [`${r.method} ${r.path}`, r]))('%s', (key, r) => {
    const found = routes.filter((x) => x.key === key);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) {
      expect(f.stage).toBe(2);
      expect([...f.allowed].sort()).toEqual(r.allowed);
      expect(r.clientKeys.filter((k) => !f.allowed.includes(k))).toEqual([]);
    }
  });

  test('the fixture covers all 25 tier-1 routes', () => {
    const tier1 = fixture.routes.filter((r) =>
      /\/(auth\/(logout|sessions|tenant-invitations)|payments\/:p\/(action|printed|refund)|payments\/collection-action|billing\/(purchase-intent|ios\/sync|android\/sync|downgrade-choice|stripe\/(checkout-session|change-plan|portal-session))|team|approvals|ledger)/.test(r.path)
    );
    expect(tier1.length).toBeGreaterThanOrEqual(25);
  });
});

describe('validate.allowBody on a real route', () => {
  test('POST /billing/purchase-intent: an undeclared field is logged and the call still works', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('owner').post('/billing/purchase-intent', { platform: 'ios', tenantId: 'x', evil: 1 });
    expect(res.status).toBe(200);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('[unknown-fields]');
    expect(logged).toContain('tenantId');
    expect(logged).toContain('evil');
    warn.mockRestore();
  });

  test('with UNKNOWN_FIELDS_STAGE2_MODE=reject the same call is a 422', async () => {
    process.env.UNKNOWN_FIELDS_STAGE2_MODE = 'reject';
    const res = await asPersona('owner').post('/billing/purchase-intent', { platform: 'ios', evil: 1 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('unknown_field');
  });

  test('a declared-only body logs nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await asPersona('owner').post('/billing/purchase-intent', { platform: 'android', planId: null });
    expect(res.status).toBe(200);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('[unknown-fields]');
    warn.mockRestore();
  });
});

describe('PATCH /trainers/:id moving a trainer needs the permission at the target branch', () => {
  let branchA;
  let branchB;
  let managerA;
  let trainerAtA;

  beforeAll(async () => {
    const tenantId = personas.owner.tenantId;
    const listing = await GymListing.findOne({ where: { tenantId } });
    branchA = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
    branchB = await factories.createBranch(tenantDb, listing.id, { name: 'Branch B (stage2b)' });
    managerA = await teamMember({ tenantDb, tenantId, email: 'mgr-a@stage2b.test', roleKey: 'MANAGER', scopeType: 'BRANCH', branchIds: [branchA.id] });
    const u = await factories.createUser({ email: 'trainer@stage2b.test', role: 'MEMBER', fullName: 'Trainer' });
    trainerAtA = (await tenantDb.models.Trainer.create({ userId: u.id, branchId: branchA.id, status: 'ACTIVE' })).id;
  });

  const patch = (body) =>
    request(app).patch(`/api/v1/trainers/${trainerAtA}`).set('Authorization', `Bearer ${managerA.token}`).send(body);

  test('a manager of A cannot move their trainer to branch B', async () => {
    const res = await patch({ branchId: branchB.id });
    expect(res.status).toBe(403);
    expect((await tenantDb.models.Trainer.findByPk(trainerAtA)).branchId).toBe(branchA.id);
  });

  test('a manager of A can edit the trainer, with or without naming their own branch', async () => {
    expect((await patch({ bio: 'ok' })).status).toBe(200);
    expect((await patch({ branchId: branchA.id, bio: 'still ok' })).status).toBe(200);
  });

  test('the owner can move the trainer to B', async () => {
    const res = await request(app)
      .patch(`/api/v1/trainers/${trainerAtA}`)
      .set('Authorization', `Bearer ${personas.owner.token}`)
      .send({ branchId: branchB.id });
    expect(res.status).toBe(200);
    expect((await tenantDb.models.Trainer.findByPk(trainerAtA)).branchId).toBe(branchB.id);
  });
});
