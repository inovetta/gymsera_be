/**
 * NEW-265 Part A, owner's pre-merge self-review (2026-11-17): authorization, limits under concurrency,
 * and the tenant-database writes of an approval.
 *
 * Found by the review: (1) the per-person limits were counted and then inserted without a lock, so
 * requests sent at the same moment could pass the count together; (2) an approval wrote to the tenant
 * database through the tenant's stored connection without checking it is the database named in
 * tenants.db_name; (3) an approval could write an area of the request's city into a branch an admin had
 * since moved to another city; (4) POST /tenants/register did not type-check areaRequestId.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');

let M;
let ctx;
let peshawar;
let lahore;
let karachi;

const keyOf = (n) => n.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
const makeRequest = (userId, city, name) => M.AreaRequest.create({
  cityId: city.id, name, nameKey: keyOf(name), source: 'typed', status: 'pending_review', requestedByUserId: userId, openKey: `${userId}:${city.id}:${keyOf(name)}`,
});
const newHost = async () => {
  const user = await factories.createUser({ email: `sr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@new265sr.test`, role: 'GYM_HOST', isHost: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
  return { user, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  M = require('../../src/models/platform');
  ctx = personaManager.context;
  // As in production: a provisioned tenant has its database name (tenant-provisioning.service.js).
  await M.Tenant.update({ dbName: 'gymsera_test_tenant_1' }, { where: { id: ctx.tenant1.id } });
  peshawar = await M.City.create({ name: 'Peshawar265sr', isActive: true });
  lahore = await M.City.create({ name: 'Lahore265sr', isActive: true });
  karachi = await M.City.create({ name: 'Karachi265sr', isActive: true });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('authorization', () => {
  test('another tenant\'s owner can neither read nor use a request of tenant 1', async () => {
    const ownerId = personaManager.personas.owner.user.id;
    const r = await makeRequest(ownerId, peshawar, 'Private Town');
    await M.AreaRequestLink.create({ areaRequestId: r.id, tenantId: ctx.tenant1.id, target: 'branch', targetId: ctx.branch1.id });
    const read = await asPersona('otherTenantOwner').get(`/places/area-requests/${r.id}`);
    expect([read.status, read.body.code]).toEqual([404, 'area_request_not_found']);
    const use = await asPersona('otherTenantOwner').patch(`/gyms/branches/${ctx.branch2.id}`).send({ cityId: peshawar.id, areaRequestId: r.id });
    expect([use.status, use.body.code]).toEqual([404, 'area_request_not_found']);
    // The owner's own team reads it (a request of the caller's tenant).
    expect((await asPersona('owner').get(`/places/area-requests/${r.id}`)).status).toBe(200);
  });

  test('every admin area-request route refuses a host (403)', async () => {
    const calls = [
      ['get', '/admin/area-requests'], ['post', '/admin/area-requests/1/approve'], ['post', '/admin/area-requests/1/merge'],
      ['post', '/admin/area-requests/1/reject'], ['post', '/admin/area-requests/1/retry'], ['get', '/admin/areas/1/aliases'],
      ['delete', '/admin/area-aliases/1'],
    ];
    for (const [method, path] of calls) expect((await asPersona('owner')[method](path).send({})).status).toBe(403);
  });

  test('POST /tenants/register: a non-integer areaRequestId is 422 validation_error', async () => {
    const h = await newHost();
    const res = await h.as().post('/tenants/register').send({ businessName: 'X', email: `x${Date.now()}@new265sr.test`, cityId: peshawar.id, areaRequestId: 'abc' });
    expect([res.status, res.body.code]).toEqual([422, 'validation_error']);
  });
});

describe('limits hold for requests sent at the same moment', () => {
  test('12 at once over 3 cities: at most 5 created in total and at most 3 per city', async () => {
    const h = await newHost();
    const cities = [peshawar, lahore, karachi];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      h.as().post('/places/area-requests').send({ cityId: cities[i % 3].id, name: `Burst Place ${'abcdefghijkl'[i]}`, confirmNotListed: true })));
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBe(5);
    expect(results.filter((r) => r.status === 429).length).toBe(7);
    for (const c of cities) {
      expect(await M.AreaRequest.count({ where: { requestedByUserId: h.user.id, cityId: c.id, status: 'pending_review' } })).toBeLessThanOrEqual(3);
    }
    expect(await M.AreaRequest.count({ where: { requestedByUserId: h.user.id } })).toBe(5);
  });
});

describe('approval writes into tenant databases', () => {
  const approve = (id) => asPersona('platformAdmin').post(`/admin/area-requests/${id}/approve`).send({});

  test('a branch whose tenant database is not the one in tenants.db_name is refused, reported and left untouched', async () => {
    const branch = await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { cityId: peshawar.id });
    const ownerId = personaManager.personas.owner.user.id;
    const r = await makeRequest(ownerId, peshawar, 'Mismatch Town');
    // A second tenant row whose stored connection points at tenant 1's database, but whose db_name differs.
    const odd = await factories.createTenant({ dbName: 'gymsera_test_tenant_other', connectionStringEncrypted: ctx.tenant1.connectionStringEncrypted, cityId: peshawar.id });
    await M.AreaRequestLink.create({ areaRequestId: r.id, tenantId: odd.id, target: 'branch', targetId: branch.id });
    const res = await approve(r.id);
    expect(res.status).toBe(200);
    expect(res.body.data.failed).toEqual([{ tenantId: odd.id, error: 'tenant_database_mismatch' }]);
    expect((await ctx.tenant1Db.models.Branch.findByPk(branch.id)).areaId).toBeNull();
    expect((await M.AreaRequestLink.findOne({ where: { areaRequestId: r.id } })).propagatedAt).toBeNull();
  });

  test('a branch moved to another city since it was linked is refused (city_changed), reported and left untouched', async () => {
    const branch = await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { cityId: lahore.id });
    const ownerId = personaManager.personas.owner.user.id;
    const r = await makeRequest(ownerId, peshawar, 'Moved Town');
    await M.AreaRequestLink.create({ areaRequestId: r.id, tenantId: ctx.tenant1.id, target: 'branch', targetId: branch.id });
    const res = await approve(r.id);
    expect(res.body.data.failed).toEqual([{ tenantId: ctx.tenant1.id, error: 'city_changed' }]);
    expect((await ctx.tenant1Db.models.Branch.findByPk(branch.id)).areaId).toBeNull();
  });

  test('an unreachable tenant database: the decision stands, that write is reported, kept for retry, and nothing else is lost', async () => {
    const ownerId = personaManager.personas.owner.user.id;
    const r = await makeRequest(ownerId, peshawar, 'Offline Town');
    const { encrypt } = require('../../src/utils/crypto.utils');
    const down = await factories.createTenant({
      dbName: 'gymsera_no_such_db_265', cityId: peshawar.id,
      connectionStringEncrypted: encrypt(`mysql://root:@${process.env.TENANT_DB_HOST || '127.0.0.1'}:${process.env.TENANT_DB_PORT}/gymsera_no_such_db_265`),
    });
    const ok = await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { cityId: peshawar.id });
    await M.AreaRequestLink.create({ areaRequestId: r.id, tenantId: down.id, target: 'branch', targetId: 'b-offline' });
    await M.AreaRequestLink.create({ areaRequestId: r.id, tenantId: ctx.tenant1.id, target: 'branch', targetId: ok.id });
    const res = await approve(r.id);
    expect(res.status).toBe(200);
    expect(res.body.data.propagated).toBe(1);
    expect(res.body.data.failed).toEqual([{ tenantId: down.id, error: expect.any(String) }]);
    expect((await ctx.tenant1Db.models.Branch.findByPk(ok.id)).areaId).toBe(res.body.data.area.id);
    expect(await M.AreaRequest.findByPk(r.id)).toMatchObject({ status: 'approved' });
    const failedLink = await M.AreaRequestLink.findOne({ where: { areaRequestId: r.id, tenantId: down.id } });
    expect(failedLink.propagatedAt).toBeNull();
    expect(failedLink.propagationError).toBeTruthy();
  });
});
