/**
 * NEW-265 Part A (R-108, R-109): the admin queue (spec §13 A6), approval carry-over (A9 rule 3) and the
 * area travellers see (A5, A9 rule 4).
 *
 * Before: no queue existed (a typed area had no path); provisioning gave the first branch
 * `mainBranchData.areaId || tenants.area_id` whatever the cities (tenant-provisioning.service.js:475);
 * discovery took `branch || listing || tenant` area (discovery.service.js:213) and showed the listing's
 * area object first (:255), so a branch in another city than its organisation was filed under the
 * organisation's area.
 *
 * After: admins list requests grouped by city and spelling, approve (new area with coordinates; typed
 * spelling kept as an alias), merge (alias to an existing area) or reject (marker `rejected`, host told).
 * A decision writes the area to every linked row, platform and tenant database, records what failed, and
 * can be retried; the same decision twice is a no-op, a different one 409. Approval moves the links:
 * tenant → listing, main_branch → branch; a draft without its own area falls back to the tenant's area
 * only in the same city. Travellers see: the branch's own area; a branch link (pending / rejected) = no
 * area; else the tenant's area in the same city only; never the listing's; never a pending one.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');

let M; // platform models
let ctx;
let ownerUserId;
let admin;
let peshawar;
let lahore;
let hayatabad;
let universityTown;
let gulberg;

const keyOf = (name) => name.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
const makeRequest = (userId, city, name, extra = {}) => M.AreaRequest.create({
  cityId: city.id, name, nameKey: keyOf(name), source: 'typed', status: 'pending_review',
  requestedByUserId: userId, openKey: `${userId}:${city.id}:${keyOf(name)}`, ...extra,
});
const link = (request, tenantId, target, targetId) => M.AreaRequestLink.create({
  areaRequestId: request.id, tenantId, target, targetId: String(targetId),
});
const linkOf = (target, tenantId, targetId) => M.AreaRequestLink.findOne({ where: { target, tenantId, targetId: String(targetId) } });

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  M = require('../../src/models/platform');
  ctx = personaManager.context;
  ownerUserId = personaManager.personas.owner.user.id;
  admin = personaManager.personas.platformAdmin.user;
  // As in production: a provisioned tenant has its database name; approvals write only to that database.
  await M.Tenant.update({ dbName: 'gymsera_test_tenant_1' }, { where: { id: ctx.tenant1.id } });
  peshawar = await M.City.create({ name: 'Peshawar265a', isActive: true });
  lahore = await M.City.create({ name: 'Lahore265a', isActive: true });
  hayatabad = await M.Area.create({ cityId: peshawar.id, name: 'Hayatabad' });
  universityTown = await M.Area.create({ cityId: peshawar.id, name: 'University Town' });
  gulberg = await M.Area.create({ cityId: lahore.id, name: 'Gulberg' });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('A6: the admin queue', () => {
  let draft; // a DRAFT tenant waiting on r1 (organisation and draft first branch)
  let r1;
  let r2;
  let host2;

  beforeAll(async () => {
    host2 = await factories.createUser({ email: `h2-${Date.now()}@new265a.test`, role: 'GYM_HOST', fullName: 'Second Host' });
    draft = await factories.createTenant({
      ownerUserId: host2.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING', cityId: peshawar.id,
      gymName: 'Draft Gym', latitude: 34.01, longitude: 71.51,
      mainBranchDataJson: { name: 'Main', cityId: peshawar.id, areaId: null, areaRequestId: null, areaStatus: 'pending_review' },
    });
    r1 = await makeRequest(host2.id, peshawar, 'Shinwari Town');
    r2 = await makeRequest(ownerUserId, peshawar, 'shinwari  town');
    await draft.update({ areaStatus: 'pending_review', areaRequestId: r1.id, mainBranchDataJson: { ...draft.mainBranchDataJson, areaRequestId: r1.id } });
    await link(r1, draft.id, 'tenant', draft.id);
    await link(r1, draft.id, 'main_branch', draft.id);
    await ctx.tenant1Db.models.Branch.update({ cityId: peshawar.id, areaId: null }, { where: { id: ctx.branch1.id } });
    await M.GymListing.update({ cityId: peshawar.id, areaId: null, areaStatus: 'pending_review', areaRequestId: r2.id }, { where: { id: ctx.listing1.id } });
    await link(r2, ctx.tenant1.id, 'listing', ctx.listing1.id);
    await link(r2, ctx.tenant1.id, 'branch', ctx.branch1.id);
  });

  test('only platform admins', async () => {
    expect((await asPersona('owner').get('/admin/area-requests')).status).toBe(403);
  });

  test('GET /admin/area-requests groups by city and spelling, with the gyms, requesters and similar names', async () => {
    const res = await asPersona('platformAdmin').get(`/admin/area-requests?cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    const groups = res.body.data.groups;
    const g = groups.find((x) => x.requestIds.includes(r1.id));
    expect(g.requestIds.sort()).toEqual([r1.id, r2.id].sort());
    expect(g).toMatchObject({ cityId: peshawar.id, cityName: 'Peshawar265a', name: 'Shinwari Town', source: 'typed', gymCount: 4 });
    expect(g.requestedBy.map((u) => u.userId).sort()).toEqual([host2.id, ownerUserId].sort());
    expect(g.gyms).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: draft.id, listingId: null, branchId: null, title: 'Draft Gym', latitude: 34.01, longitude: 71.51 }),
      expect.objectContaining({ tenantId: ctx.tenant1.id, listingId: ctx.listing1.id }),
      expect.objectContaining({ tenantId: ctx.tenant1.id, branchId: ctx.branch1.id }),
    ]));
    expect(res.body.data.pagination).toMatchObject({ page: 1 });
    expect(Array.isArray(g.similar)).toBe(true);
  });

  test('approve: a new area with coordinates; the typed spelling becomes an alias; every linked row gets the area (platform and tenant DB)', async () => {
    const res = await asPersona('platformAdmin').post(`/admin/area-requests/${r1.id}/approve`).send({ name: 'Shinwari', latitude: 34.02, longitude: 71.6 });
    expect(res.status).toBe(200);
    const area = await M.Area.findByPk(res.body.data.area.id);
    expect(area).toMatchObject({ cityId: peshawar.id, name: 'Shinwari' });
    expect(Number(area.latitude)).toBeCloseTo(34.02);
    expect(res.body.data).toMatchObject({ decided: 2, propagated: 4, failed: [] });
    expect(await M.AreaAlias.findOne({ where: { cityId: peshawar.id, aliasKey: 'shinwaritown', areaId: area.id } })).not.toBeNull();

    for (const r of [r1, r2]) {
      expect(await M.AreaRequest.findByPk(r.id)).toMatchObject({ status: 'approved', resolvedAreaId: area.id, openKey: null, decidedBy: admin.id });
    }
    expect(await M.Tenant.findByPk(draft.id)).toMatchObject({ areaId: area.id, areaStatus: null, areaRequestId: null });
    const mb = (await M.Tenant.findByPk(draft.id)).mainBranchDataJson;
    expect(mb.areaId).toBe(area.id);
    expect(mb.areaRequestId).toBeUndefined();
    expect(mb.areaStatus).toBeUndefined();
    expect(await M.GymListing.findByPk(ctx.listing1.id)).toMatchObject({ areaId: area.id, areaStatus: null, areaRequestId: null });
    expect((await ctx.tenant1Db.models.Branch.findByPk(ctx.branch1.id)).areaId).toBe(area.id);
    expect((await linkOf('branch', ctx.tenant1.id, ctx.branch1.id)).propagatedAt).not.toBeNull();

    // Audit and the requesters told.
    expect(await M.PlatformAuditLog.count({ where: { action: 'areas.request.approve' } })).toBeGreaterThanOrEqual(1);
    const notes = await M.Notification.findAll({ where: { type: 'area_request_decided' } });
    expect(notes.map((n) => n.userId).sort()).toEqual([host2.id, ownerUserId].sort());
    expect(notes[0].message).toContain('was added');

    // The typed spelling now maps to the area.
    const { signToken } = require('../../src/utils/jwt.utils');
    const token = signToken({ sub: host2.id, id: host2.id, email: host2.email, role: 'GYM_HOST', isVerified: true });
    const again = await asPersona('anonymous', { Authorization: `Bearer ${token}` }).post('/places/area-requests').send({ cityId: peshawar.id, name: 'Shinwari Town' });
    expect(again.body.data).toEqual({ area: { id: area.id, name: 'Shinwari' } });
  });

  test('the same decision twice: 200, no change; a different decision: 409 area_request_decided', async () => {
    const before = await M.Area.count();
    const same = await asPersona('platformAdmin').post(`/admin/area-requests/${r1.id}/approve`).send({ name: 'Shinwari', latitude: 34.02, longitude: 71.6 });
    expect(same.status).toBe(200);
    expect(same.body.data).toMatchObject({ decided: 0, propagated: 0 });
    expect(await M.Area.count()).toBe(before);
    const other = await asPersona('platformAdmin').post(`/admin/area-requests/${r1.id}/reject`).send({ reason: 'Changed my mind' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('area_request_decided');
  });

  test('approve with a name that is already an area → 409 area_exists { areaId }; bad name / coordinates → 422', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Hayatabad Old');
    const exists = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'hayatabad', latitude: 34, longitude: 71 });
    expect(exists.status).toBe(409);
    expect(exists.body).toMatchObject({ code: 'area_exists', data: { areaId: hayatabad.id } });
    expect((await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'x', latitude: 34, longitude: 71 })).body.code).toBe('area_name_invalid');
    expect((await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'Fine Name', latitude: 134, longitude: 71 })).body.code).toBe('area_coordinates_invalid');
    // R-110: one coordinate without the other is refused; the pin as a whole is optional (next test).
    expect((await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'Fine Name', latitude: 34 })).body.code).toBe('area_coordinates_invalid');
    expect((await asPersona('platformAdmin').post('/admin/area-requests/99999999/approve').send({ name: 'Fine Name', latitude: 34, longitude: 71 })).status).toBe(404);
  });

  test('R-110: approval without a pin creates the area with no coordinates', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'No Pin Town');
    const res = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'No Pin Town' });
    expect(res.status).toBe(200);
    const area = await M.Area.findByPk(res.body.data.area.id);
    expect(area).toMatchObject({ name: 'No Pin Town', latitude: null, longitude: null });
    expect(await M.AreaRequest.findByPk(r.id)).toMatchObject({ status: 'approved', resolvedAreaId: area.id });
  });

  test('two approvals at the same time create one area', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Race Town');
    const body = { name: 'Race Town', latitude: 34.1, longitude: 71.6 };
    const [a, b] = await Promise.all([
      asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send(body),
      asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send(body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await M.Area.count({ where: { cityId: peshawar.id, name: 'Race Town' } })).toBe(1);
  });

  test('merge: the spelling becomes an alias of the area; links get the area; another city\'s area → 422', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Universty Twn');
    const lahoreTry = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/merge`).send({ areaId: gulberg.id });
    expect(lahoreTry.status).toBe(422);
    expect(lahoreTry.body.code).toBe('area_not_listed');
    const b = await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { cityId: peshawar.id });
    await link(r, ctx.tenant1.id, 'branch', b.id);
    const res = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/merge`).send({ areaId: universityTown.id });
    expect(res.status).toBe(200);
    expect(await M.AreaRequest.findByPk(r.id)).toMatchObject({ status: 'merged', resolvedAreaId: universityTown.id });
    expect(await M.AreaAlias.findOne({ where: { cityId: peshawar.id, aliasKey: 'universtytwn' } })).toMatchObject({ areaId: universityTown.id });
    expect((await ctx.tenant1Db.models.Branch.findByPk(b.id)).areaId).toBe(universityTown.id);
    const notes = await M.Notification.findAll({ where: { type: 'area_request_decided', userId: ownerUserId } });
    const note = notes.find((n) => (n.metadataJson || {}).areaRequestId === r.id);
    expect(note.message).toBe('Universty Twn was matched to University Town');
  });

  test('reject: requests rejected, markers rejected (tenant, listing, draft first branch), links stay, host told the reason', async () => {
    const host3 = await factories.createUser({ email: `h3-${Date.now()}@new265a.test`, role: 'GYM_HOST' });
    const t = await factories.createTenant({
      ownerUserId: host3.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING', cityId: peshawar.id,
    });
    const r = await makeRequest(host3.id, peshawar, 'Fake Place');
    await t.update({ areaStatus: 'pending_review', areaRequestId: r.id, mainBranchDataJson: { name: 'M', areaRequestId: r.id, areaStatus: 'pending_review' } });
    await link(r, t.id, 'tenant', t.id);
    await link(r, t.id, 'main_branch', t.id);
    expect((await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/reject`).send({ reason: 'x' })).status).toBe(422);

    const res = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/reject`).send({ reason: 'Not an area of Peshawar' });
    expect(res.status).toBe(200);
    expect(await M.AreaRequest.findByPk(r.id)).toMatchObject({ status: 'rejected', rejectReason: 'Not an area of Peshawar', openKey: null });
    await t.reload();
    expect(t).toMatchObject({ areaStatus: 'rejected', areaId: null, areaRequestId: r.id });
    expect(t.mainBranchDataJson.areaStatus).toBe('rejected');
    expect(await linkOf('tenant', t.id, t.id)).not.toBeNull();
    const note = await M.Notification.findOne({ where: { type: 'area_request_decided', userId: host3.id } });
    expect(note.message).toContain('was not accepted: Not an area of Peshawar. Please pick your area again.');
    expect(await M.PlatformAuditLog.count({ where: { action: 'areas.request.reject' } })).toBe(1);
    // Repeat = no change.
    expect((await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/reject`).send({ reason: 'Not an area of Peshawar' })).status).toBe(200);
  });

  test('a failed tenant-database write is reported, kept for retry, and retry finishes it', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Retry Town');
    const missingBranchId = require('uuid').v4();
    await link(r, ctx.tenant1.id, 'branch', missingBranchId);
    const res = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/approve`).send({ name: 'Retry Town', latitude: 34, longitude: 71.5 });
    expect(res.status).toBe(200);
    expect(res.body.data.failed).toEqual([{ tenantId: ctx.tenant1.id, error: expect.any(String) }]);
    const l = await linkOf('branch', ctx.tenant1.id, missingBranchId);
    expect(l.propagatedAt).toBeNull();
    expect(l.propagationError).toBeTruthy();

    await factories.createBranch(ctx.tenant1Db, ctx.listing1.id, { id: missingBranchId, cityId: peshawar.id });
    const retry = await asPersona('platformAdmin').post(`/admin/area-requests/${r.id}/retry`).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ propagated: 1, failed: [] });
    expect((await ctx.tenant1Db.models.Branch.findByPk(missingBranchId)).areaId).toBe(res.body.data.area.id);
    expect((await linkOf('branch', ctx.tenant1.id, missingBranchId)).propagationError).toBeNull();
  });

  test('aliases: list per area, delete one (audited); unknown → 404', async () => {
    const shinwari = await M.Area.findOne({ where: { name: 'Shinwari' } });
    const list = await asPersona('platformAdmin').get(`/admin/areas/${shinwari.id}/aliases`);
    expect(list.status).toBe(200);
    const alias = list.body.data.aliases.find((a) => a.aliasKey === 'shinwaritown');
    expect(alias).toBeDefined();
    expect((await asPersona('platformAdmin').delete(`/admin/area-aliases/${alias.id}`)).status).toBe(200);
    expect(await M.AreaAlias.findByPk(alias.id)).toBeNull();
    expect(await M.PlatformAuditLog.count({ where: { action: 'areas.alias.delete' } })).toBe(1);
    expect((await asPersona('platformAdmin').delete(`/admin/area-aliases/${alias.id}`)).status).toBe(404);
  });

  test('status filter: approved groups are listed with status=approved, not by default', async () => {
    const pending = await asPersona('platformAdmin').get(`/admin/area-requests?cityId=${peshawar.id}`);
    expect(pending.body.data.groups.find((g) => g.requestIds.includes(r1.id))).toBeUndefined();
    const approved = await asPersona('platformAdmin').get(`/admin/area-requests?cityId=${peshawar.id}&status=approved`);
    expect(approved.body.data.groups.find((g) => g.requestIds.includes(r1.id))).toBeDefined();
  });
});

describe('A9 rule 3: approval carries the areas and links over', () => {
  const dbNames = [];
  const adminService = () => require('../../src/services/admin.service');
  const TenantDbManager = () => require('../../src/database/TenantDbManager');
  const plans = [{ name: 'Monthly', price: 3000 }];

  afterAll(async () => {
    const conn = await getAdminConnection();
    for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  });

  const pendingTenant = async (key, overrides) => {
    const tenantCode = `test_n265_${key}_${Date.now().toString(36)}`;
    dbNames.push(`gymsera_${tenantCode}`);
    const owner = await factories.createUser({ email: `${key}-${Date.now()}@new265p.test`, role: 'GYM_HOST' });
    return factories.createTenant({
      tenantCode, ownerUserId: owner.id, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER',
      cityId: peshawar.id, gymName: `Gym ${key}`, ...overrides,
    });
  };
  const approve = async (tenant) => {
    await adminService().approveTenant(tenant.id, admin.id);
    await tenant.reload();
    const db = await TenantDbManager().getConnection(tenant.id, tenant.connectionStringEncrypted);
    const listing = await M.GymListing.findOne({ where: { tenantId: tenant.id } });
    const branch = await db.models.Branch.findOne();
    return { listing, branch };
  };

  test('the draft branch\'s own area wins; the listing takes the tenant\'s', async () => {
    const t = await pendingTenant('own', { areaId: hayatabad.id, mainBranchDataJson: { name: 'Main', plans, cityId: peshawar.id, areaId: universityTown.id } });
    const { listing, branch } = await approve(t);
    expect(listing.areaId).toBe(hayatabad.id);
    expect(branch.areaId).toBe(universityTown.id);
  });

  test('links move: tenant → listing (marker on the listing), main_branch → branch', async () => {
    const t = await pendingTenant('links', { mainBranchDataJson: { name: 'Main', plans, cityId: peshawar.id } });
    const rt = await makeRequest(t.ownerUserId, peshawar, 'Org Pending Town');
    const rb = await makeRequest(t.ownerUserId, peshawar, 'Branch Pending Town');
    await t.update({ areaStatus: 'pending_review', areaRequestId: rt.id, mainBranchDataJson: { ...t.mainBranchDataJson, areaRequestId: rb.id, areaStatus: 'pending_review' } });
    await link(rt, t.id, 'tenant', t.id);
    await link(rb, t.id, 'main_branch', t.id);
    const { listing, branch } = await approve(t);
    expect(listing).toMatchObject({ areaId: null, areaStatus: 'pending_review', areaRequestId: rt.id });
    expect(await linkOf('listing', t.id, listing.id)).toMatchObject({ areaRequestId: rt.id });
    expect(branch.areaId).toBeNull();
    expect(await linkOf('branch', t.id, branch.id)).toMatchObject({ areaRequestId: rb.id });
    expect(await linkOf('main_branch', t.id, t.id)).toBeNull();
  });

  test('a draft without its own area takes the tenant\'s only in the same city', async () => {
    const same = await pendingTenant('same', { areaId: hayatabad.id, mainBranchDataJson: { name: 'Main', plans, cityId: peshawar.id } });
    expect((await approve(same)).branch.areaId).toBe(hayatabad.id);
    const other = await pendingTenant('other', { areaId: hayatabad.id, mainBranchDataJson: { name: 'Main', plans, cityId: lahore.id } });
    const res = await approve(other);
    expect(res.branch.cityId).toBe(lahore.id);
    expect(res.branch.areaId).toBeNull();
  });

  test('a tenant link also covers the branch in the old-data fallback (same city)', async () => {
    const t = await pendingTenant('fallback', { mainBranchDataJson: { name: 'Main', plans, cityId: peshawar.id } });
    const rt = await makeRequest(t.ownerUserId, peshawar, 'Fallback Town');
    await t.update({ areaStatus: 'pending_review', areaRequestId: rt.id });
    await link(rt, t.id, 'tenant', t.id);
    const { listing, branch } = await approve(t);
    expect(await linkOf('listing', t.id, listing.id)).toMatchObject({ areaRequestId: rt.id });
    expect(await linkOf('branch', t.id, branch.id)).toMatchObject({ areaRequestId: rt.id });
    expect(branch.areaId).toBeNull();
  });
});

describe('A5 / A9 rule 4: the area a traveller sees', () => {
  const cache = () => require('../../src/services/discovery-cache.service');
  const gyms = async () => {
    cache().invalidate();
    const res = await asPersona('anonymous').get('/discovery/gyms?page=1&limit=50');
    expect(res.status).toBe(200);
    const list = res.body.data.gyms || res.body.data.items || res.body.data;
    return new Map(list.map((g) => [g.branchId || g.id, g]));
  };
  let b;

  beforeAll(async () => {
    const { tenant1Db, listing1, tenant1 } = ctx;
    await M.Tenant.update({ cityId: peshawar.id, areaId: hayatabad.id, areaStatus: null, areaRequestId: null }, { where: { id: tenant1.id } });
    // The listing has an area of its own: it is no longer a step of the chain (R-109 reading (a)).
    await M.GymListing.update({ cityId: lahore.id, areaId: gulberg.id, areaStatus: null, areaRequestId: null }, { where: { id: listing1.id } });
    const mk = async (over) => factories.makeBranchLive(tenant1Db, await factories.createBranch(tenant1Db, listing1.id, over));
    b = {
      sameCity: await mk({ cityId: peshawar.id, areaId: null }),
      otherCity: await mk({ cityId: lahore.id, areaId: null }),
      ownArea: await mk({ cityId: peshawar.id, areaId: universityTown.id }),
      pending: await mk({ cityId: peshawar.id, areaId: null }),
    };
    const r = await makeRequest(ownerUserId, peshawar, 'Discovery Pending Town');
    await link(r, tenant1.id, 'branch', b.pending.id);
  });

  test('own area; same-city tenant fallback; other city = none; own pending link = none; never the listing\'s', async () => {
    const map = await gyms();
    expect(map.get(b.ownArea.id)).toMatchObject({ areaId: universityTown.id, area: expect.objectContaining({ id: universityTown.id }) });
    expect(map.get(b.sameCity.id)).toMatchObject({ areaId: hayatabad.id, area: expect.objectContaining({ id: hayatabad.id }) });
    expect(map.get(b.otherCity.id)).toMatchObject({ areaId: null, area: null });
    expect(map.get(b.pending.id)).toMatchObject({ areaId: null, area: null });
  });

  test('a pending tenant area is never shown: the fallback gives no area', async () => {
    await M.Tenant.update({ areaId: null, areaStatus: 'pending_review', areaRequestId: 1 }, { where: { id: ctx.tenant1.id } });
    const map = await gyms();
    expect(map.get(b.sameCity.id)).toMatchObject({ areaId: null, area: null });
    expect(map.get(b.ownArea.id).areaId).toBe(universityTown.id);
  });
});
