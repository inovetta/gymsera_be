/**
 * NEW-282 (owner, build 27): creating a brand or a branch is safe to retry.
 *
 * Before: POST /host/listings, POST /host/branches and POST /gyms/branches had no idempotency.
 * When the answer was lost (timeout, network drop) and the app sent the same create again, the
 * server made a second brand or branch, with its plans, and spent a second capacity slot.
 *
 * Now: the existing idempotency middleware (src/middleware/idempotency.js, REL-01) runs on the three
 * routes. The app sends one Idempotency-Key per submit and the same key on a retry; the server
 * answers the retry with the first result and creates nothing more. Without the header (old
 * builds) nothing changes.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { Op } = require('sequelize');
const { GymListing } = require('../../src/models/platform');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');

describe('NEW-282: brand and branch creates are idempotent', () => {
  let tenantDb;
  let tenantId;
  let seq = 0;
  const key = () => `new282-${Date.now()}-${(seq += 1)}`;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    tenantDb = h.tenant1;
    tenantId = personaManager.personas.owner.tenantId;
    const sub = await subscriptionQuotaService.getActiveSubscription(tenantId);
    if (sub) await sub.update({ branchCount: 50, overQuotaCount: 0 });
    else await factories.createTenantSubscription(tenantId, { branchCount: 50, overQuotaCount: 0 });
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  const branches = () => tenantDb.models.Branch.count();
  const listingBody = (n) => ({
    gymName: `Idem Org ${n}`, branchSource: 'new', branchName: `Idem Org Branch ${n}`, address: `${n} Street`,
    packages: [{ name: 'Monthly', price: 50, durationType: 'MONTHLY', durationValue: 1 }],
  });
  const branchBody = (n) => ({ branchName: `Idem Branch ${n}`, address: `${n} Road`, packages: [{ name: 'Monthly', price: 50 }] });
  // A new organisation waits for admin review and the API refuses another one until then (403);
  // approve each one, as an admin would, so the next create in the test is allowed.
  const approvePending = () =>
    GymListing.update({ status: 'ACTIVE' }, { where: { tenantId, status: { [Op.in]: ['PENDING', 'DRAFT'] } } });
  const send = async (path, body, k) => {
    const req = asPersona('owner').post(path);
    if (k) req.set('Idempotency-Key', k);
    const res = await req.send(body);
    if (path === '/host/listings') await approvePending();
    return res;
  };

  describe.each([
    ['POST /host/listings', '/host/listings', listingBody],
    ['POST /host/branches', '/host/branches', branchBody],
    ['POST /gyms/branches', '/gyms/branches', branchBody],
  ])('%s', (_name, path, body) => {
    test('a retry with the same key answers the first result and creates nothing more', async () => {
      const k = key();
      const b = body(k);
      const before = await branches();

      const first = await send(path, b, k);
      expect([200, 201]).toContain(first.status);
      const afterFirst = await branches();
      expect(afterFirst).toBe(before + 1);

      const retry = await send(path, b, k);
      expect(retry.status).toBe(first.status);
      expect(retry.headers['x-idempotent-replay']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await branches()).toBe(afterFirst);
    });

    test('the same key with a different body is refused (422 idempotency_key_reuse)', async () => {
      const k = key();
      expect([200, 201]).toContain((await send(path, body(`${k}-a`), k)).status);
      const res = await send(path, body(`${k}-b`), k);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('idempotency_key_reuse');
    });

    test('without the header (old builds) every request still creates, as before', async () => {
      const before = await branches();
      expect([200, 201]).toContain((await send(path, body(key()), null)).status);
      expect([200, 201]).toContain((await send(path, body(key()), null)).status);
      expect(await branches()).toBe(before + 2);
    });
  });
});
