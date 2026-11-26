/**
 * S4: GET /host/businesses (and GET /host/businesses/:businessId) includes `branchCount`
 * (the count of ACTIVE branches belonging to each business; 0 when none or held).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

let tenant1;
let tenantDb;
let listing1;

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  tenant1 = personaManager.context.tenant1;
  tenantDb = h.tenant1;
  listing1 = personaManager.context.listing1;
  await TenantSubscription.update({ branchCount: 20 }, { where: { organizationId: tenant1.id } });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test('GET /host/businesses returns branchCount per business (counting ACTIVE branches only)', async () => {
  const { Branch, Gym } = tenantDb.models;
  const second = await factories.createGymListing(tenant1.id, { title: 'Second Active Biz', status: 'ACTIVE' });
  await Gym.create({ id: second.id, name: 'Second Active Biz' });
  await Branch.create({ businessId: second.id, branchName: 'Second B1', status: 'ACTIVE' });
  await Branch.create({ businessId: second.id, branchName: 'Second B2', status: 'ACTIVE' });
  await Branch.create({ businessId: second.id, branchName: 'Second Inactive', status: 'INACTIVE' });

  await GymListing.update({ status: 'REJECTED' }, { where: { organizationId: tenant1.id, status: 'PENDING' } });
  const pendingRes = await asPersona('owner').post('/host/businesses').send({
    businessName: 'Held Biz',
    firstBranch: await firstBranchInput({ branchName: 'Held Site' }),
  });
  expect(pendingRes.status).toBe(201);
  const heldId = pendingRes.body.data.business.id;

  const list = await asPersona('owner').get('/host/businesses');
  expect(list.status).toBe(200);
  const byId = Object.fromEntries(list.body.data.map((b) => [b.id, b]));
  expect(byId[listing1.id].branchCount).toBe(1);
  expect(byId[second.id].branchCount).toBe(2);
  expect(byId[heldId].branchCount).toBe(0);

  const single = await asPersona('owner').get(`/host/businesses/${second.id}`);
  expect(single.status).toBe(200);
  expect(single.body.data.branchCount).toBe(2);
});

