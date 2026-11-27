/**
 * NEW-303 M3 (enterprise D4/D5, API contract G5, walkthrough W4): one capacity pool per ORGANIZATION.
 *  - GET /host/business-quota answers { pool { max, used, reserved, free }, canAddBusiness, blockingBusinessStatus };
 *  - a branch added to a business with no unbuilt unit takes one parked on another business (W4: was 403 at
 *    3 used / 4 paid), with a SLOT_TRANSFERRED pair then SLOT_CONSUMED_BUILD;
 *  - with the pool really full the branch is still refused (403 branch_limit_reached), nothing written.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { createGymListing } = require('../harness/factories');
const { GymListing, TenantSubscription, CapacityEvent } = require('../../src/models/platform');

let organizationId; let db1; let listing1; let donor;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  organizationId = personaManager.context.tenant1.id;
  db1 = personaManager.context.tenant1Db;
  listing1 = await GymListing.findOne({ where: { organizationId }, order: [['createdAt', 'ASC']] });
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const setPool = async (max) => TenantSubscription.update({ branchCount: max }, { where: { organizationId } });
const quota = async () => (await asPersona('owner').get('/host/business-quota')).body.data;
const addBranch = async (name) => asPersona('owner').post('/host/branches').send({ businessId: listing1.id, ...(await firstBranchInput({ branchName: name })) });

test('G5: the quota answers the organization pool', async () => {
  const used = await db1.models.Branch.count({ where: { status: 'ACTIVE' } });
  const reservedNow = Number(await GymListing.sum('reservedSlots', { where: { organizationId } })) || 0;
  await setPool(used + reservedNow + 2);
  const q = await quota();
  expect(Object.keys(q).sort()).toEqual(['blockingBusinessStatus', 'canAddBusiness', 'pool']);
  expect(q.pool).toEqual({ max: used + reservedNow + 2, used, reserved: reservedNow, free: 2 });
});

test('W4: a branch takes the unit parked on another business when the pool is otherwise full', async () => {
  donor = await createGymListing(organizationId, { name: 'Donor Business', reservedSlots: 1 });
  const used = await db1.models.Branch.count({ where: { status: 'ACTIVE' } });
  const reserved = Number(await GymListing.sum('reservedSlots', { where: { organizationId } })) || 0;
  await setPool(used + reserved); // full: nothing free, and listing1 holds no unit of its own
  await listing1.reload();
  expect(listing1.reservedSlots).toBe(0);
  expect((await quota()).pool.free).toBe(0);

  const res = await addBranch('Donated Unit');
  expect(res.status).toBe(201);
  await donor.reload();
  await listing1.reload();
  expect(donor.reservedSlots).toBe(0);
  expect(listing1.reservedSlots).toBe(0);
  const actions = (await CapacityEvent.findAll({ where: { organizationId, listingId: [donor.id, listing1.id] }, order: [['createdAt', 'ASC'], ['id', 'ASC']] })).map((e) => `${e.listingId === donor.id ? 'donor' : 'target'}:${e.action}:${e.delta}`);
  expect(actions).toEqual(expect.arrayContaining(['donor:SLOT_TRANSFERRED:-1', 'target:SLOT_TRANSFERRED:1', 'target:SLOT_CONSUMED_BUILD:-1']));
  expect((await quota()).pool).toMatchObject({ free: 0, used: used + 1 });
});

test('a really full pool still refuses the branch and writes nothing', async () => {
  const branches = await db1.models.Branch.count();
  const events = await CapacityEvent.count({ where: { organizationId } });
  const res = await addBranch('No Room');
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('branch_limit_reached');
  expect(await db1.models.Branch.count()).toBe(branches);
  expect(await CapacityEvent.count({ where: { organizationId } })).toBe(events);
});
