/**
 * NEW-297 (owner 2026-11-20, decision R-117): POST /host/listings (another organisation) and the old
 * opening / closing pair.
 *
 * Before: createListing read only `hours` (host.controller.js:432, :680) and the route did not declare
 * openingTime / closingTime, so a pair sent there was dropped silently (SEC-06 stage 2 only logs it):
 * the first branch of the new organisation had no hours.
 * After: the pair is declared, checked by the same rules (branchHours.resolveWrite, H5) before the
 * organisation is created, and stored as a uniform week plus the pair. `hours` with the pair is 422.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');
const { GymListing } = require('../../src/models/platform');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const uniform = (open, close) => ({ v: 1, days: Object.fromEntries(DAYS.map((d) => [d, { closed: false, slots: [{ open, close, for: 'all' }] }])) });

let ctx;
let seq = 0;
const listingBody = (extra = {}) => ({ gymName: `NEW297 Org ${Date.now()}-${(seq += 1)}`, packages: [{ name: 'Monthly', price: 50 }], ...extra });
const Branch = () => ctx.tenant1Db.models.Branch;
const listingCount = () => GymListing.count({ where: { organizationId: ctx.tenant1.id } });
// One organisation at a time may be DRAFT / PENDING (the sequential gate): each one made here is set
// INACTIVE once checked, so the next create is judged on its hours only.
const create = async (body) => {
  const res = await asPersona('owner').post('/host/listings').send(body);
  if (res.status === 201) {
    const row = await Branch().findByPk(res.body.data.branch.id);
    await GymListing.update({ status: 'INACTIVE' }, { where: { id: row.gymListingId } });
  }
  return res;
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ctx = personaManager.context;
  const sub = await subscriptionQuotaService.getActiveSubscription(ctx.tenant1.id);
  if (sub) await sub.update({ branchCount: 50, overQuotaCount: 0 });
  else await factories.createTenantSubscription(ctx.tenant1.id, { branchCount: 50, overQuotaCount: 0 });
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-297: POST /host/listings keeps the old pair', () => {
  test('06:00-00:00 (12 AM closing) is stored on the first branch as the pair and a uniform week', async () => {
    const res = await create(listingBody({ openingTime: '06:00', closingTime: '00:00' }));
    expect(res.status).toBe(201);
    const row = await Branch().findByPk(res.body.data.branch.id);
    expect([row.openingTime, row.closingTime]).toEqual(['06:00', '00:00']);
    expect(row.hoursJson).toEqual(uniform('06:00', '00:00'));
  });

  test('a refused pair is 422 hours_invalid before anything is created', async () => {
    const before = await listingCount();
    const res = await create(listingBody({ openingTime: '18:00', closingTime: '14:00' }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('hours_invalid');
    expect(JSON.stringify(res.body)).toContain('Check AM/PM');
    expect(await listingCount()).toBe(before);
  });

  test('the week and the pair together are refused (as on every other route)', async () => {
    const res = await create(listingBody({ hours: uniform('06:00', '22:00'), openingTime: '06:00', closingTime: '22:00' }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('hours_invalid');
  });

  test('the week alone still works (R-113 H4), and no hours at all leaves the branch without hours', async () => {
    const week = await create(listingBody({ hours: uniform('00:00', '24:00') }));
    expect(week.status).toBe(201);
    expect((await Branch().findByPk(week.body.data.branch.id)).hoursJson).toEqual(uniform('00:00', '24:00'));
    const none = await create(listingBody());
    expect(none.status).toBe(201);
    const row = await Branch().findByPk(none.body.data.branch.id);
    expect([row.hoursJson, row.openingTime, row.closingTime]).toEqual([null, null, null]);
  });
});
