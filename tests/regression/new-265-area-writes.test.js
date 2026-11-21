/**
 * NEW-265 Part A (R-108, R-109): gym writes take an `areaRequestId` (spec §13 A4) and reads show `pendingArea`.
 *
 * Before: every gym write took a real `areaId` only; a host whose area was missing could save no area at
 * all, and a draft first branch lost its area on every save that did not repeat it (F1). PATCH /tenants/me
 * refused every draft tenant (F3), and nothing told the host an area was under review or refused.
 *
 * After: register, gym-profile (mainBranchData), PATCH /tenants/me (DRAFT / PENDING_REVIEW), the host
 * listing and branch routes take `areaRequestId`: the record's area_id is NULL, the gym's marker is
 * pending_review and a link row ties the record to the request (POST /host/listings writes two). A field not
 * sent keeps its value; only `null` or a new real area clears it. Reads carry `pendingArea`; /host/status
 * carries `area` for "Choose your area again". Admin routes take real areas only, and saving one clears the
 * record's link. `areaId` behaviour is unchanged for every build.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');

let City;
let Area;
let AreaRequest;
let AreaRequestLink;
let Tenant;
let GymListing;
let peshawar;
let lahore;
let hayatabad;
let gulberg;
let ctx;
let ownerUserId;

let seq = 0;
const newHost = async () => {
  seq += 1;
  const user = await factories.createUser({ email: `w${seq}-${Date.now()}@new265w.test`, role: 'GYM_HOST', isHost: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
  return { user, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
};
const draftTenant = (user, overrides = {}) => factories.createTenant({
  ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING', cityId: peshawar.id, ...overrides,
});

const makeRequest = (userId, city, name, status = 'pending_review', extra = {}) => {
  const key = name.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  return AreaRequest.create({
    cityId: city.id, name, nameKey: key, source: 'typed', status, requestedByUserId: userId,
    openKey: status === 'pending_review' ? `${userId}:${city.id}:${key}` : null, ...extra,
  });
};
const linkOf = (target, tenantId, targetId) => AreaRequestLink.findOne({ where: { target, tenantId, targetId: String(targetId) } });

const expectCode = (res, status, code) => {
  expect({ status: res.status, code: res.body.code }).toEqual({ status, code });
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ({ City, Area, AreaRequest, AreaRequestLink, Tenant, GymListing } = require('../../src/models/platform'));
  ctx = personaManager.context;
  ownerUserId = personaManager.personas.owner.user.id;
  peshawar = await City.create({ name: 'Peshawar265w', isActive: true });
  lahore = await City.create({ name: 'Lahore265w', isActive: true });
  hayatabad = await Area.create({ cityId: peshawar.id, name: 'Hayatabad' });
  gulberg = await Area.create({ cityId: lahore.id, name: 'Gulberg' });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('A4: the common checks (POST /gyms/branches)', () => {
  const branchBody = (extra) => ({ branchName: `Br ${Date.now()}${Math.random()}`, cityId: peshawar.id, packages: [{ name: 'Monthly', price: 50 }], ...extra });

  test('areaId and areaRequestId together → 422 area_choice_conflict', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Conflict Town');
    expectCode(await asPersona('owner').post('/gyms/branches').send(branchBody({ areaId: hayatabad.id, areaRequestId: r.id })), 422, 'area_choice_conflict');
  });

  test('a request that is neither the caller\'s nor of the caller\'s tenant → 404 area_request_not_found', async () => {
    const stranger = await factories.createUser({ email: `s-${Date.now()}@new265w.test` });
    const r = await makeRequest(stranger.id, peshawar, 'Stranger Town');
    expectCode(await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: r.id })), 404, 'area_request_not_found');
    expectCode(await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: 99999999 })), 404, 'area_request_not_found');
  });

  test('a request of another city → 422 area_not_listed; a rejected one → 422 area_request_rejected', async () => {
    const other = await makeRequest(ownerUserId, lahore, 'Lahore Request');
    expectCode(await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: other.id })), 422, 'area_not_listed');
    const rejected = await makeRequest(ownerUserId, peshawar, 'Refused Town', 'rejected', { rejectReason: 'Not a real area' });
    const res = await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: rejected.id }));
    expectCode(res, 422, 'area_request_rejected');
    expect(res.body.message).toBe('That area was not accepted. Please pick your area again.');
  });

  test('an approved / merged request saves its area instead (no error, no link)', async () => {
    const approved = await makeRequest(ownerUserId, peshawar, 'Approved Town', 'approved', { resolvedAreaId: hayatabad.id });
    const res = await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: approved.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.branch.areaId).toBe(hayatabad.id);
    expect(await linkOf('branch', ctx.tenant1.id, res.body.data.branch.id)).toBeNull();
  });

  test('a request made by the tenant\'s owner can be used by the tenant (POST /gyms/branches writes the branch link)', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Owner Town');
    const res = await asPersona('owner').post('/gyms/branches').send(branchBody({ areaRequestId: r.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.branch.areaId).toBeNull();
    const link = await linkOf('branch', ctx.tenant1.id, res.body.data.branch.id);
    expect(link).toMatchObject({ areaRequestId: r.id, propagatedAt: null });
  });
});

describe('A4: Become a Host (tenant and draft first branch)', () => {
  test('POST /tenants/register with areaRequestId: no area, marker pending_review, a tenant link', async () => {
    const h = await newHost();
    const r = await makeRequest(h.user.id, peshawar, 'Register Town');
    const res = await h.as().post('/tenants/register').send({ businessName: 'Reg Gym', email: `reg${seq}@new265w.test`, cityId: peshawar.id, areaRequestId: r.id });
    expect(res.status).toBe(201);
    const tenant = await Tenant.findOne({ where: { ownerUserId: h.user.id } });
    expect(tenant).toMatchObject({ areaId: null, areaStatus: 'pending_review', areaRequestId: r.id });
    expect(await linkOf('tenant', tenant.id, tenant.id)).toMatchObject({ areaRequestId: r.id });
    expect(res.body.data.tenant.pendingArea).toEqual({ requestId: r.id, name: 'Register Town', status: 'pending_review', rejectReason: null });
  });

  test('POST /tenants/register with areaId keeps working as before (builds 21 to 24)', async () => {
    const h = await newHost();
    const res = await h.as().post('/tenants/register').send({ businessName: 'Old Gym', email: `old${seq}@new265w.test`, cityId: peshawar.id, areaId: hayatabad.id });
    expect(res.status).toBe(201);
    expect(await Tenant.findOne({ where: { ownerUserId: h.user.id } })).toMatchObject({ areaId: hayatabad.id, areaStatus: null, areaRequestId: null });
  });

  test('gym-profile: mainBranchData.areaRequestId → main_branch link; a save without area keys keeps it; areaId: null clears it (R-109, F1)', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user);
    const r = await makeRequest(h.user.id, peshawar, 'Branch Town');
    const first = await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { name: 'Main', cityId: peshawar.id, areaRequestId: r.id } });
    expect(first.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson).toMatchObject({ areaId: null, areaRequestId: r.id, areaStatus: 'pending_review' });
    expect(await linkOf('main_branch', tenant.id, tenant.id)).toMatchObject({ areaRequestId: r.id });

    // Step 6 (plans) without area keys: kept.
    const plans = await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { plans: [{ name: 'Monthly', price: 10 }] } });
    expect(plans.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson).toMatchObject({ areaRequestId: r.id, areaStatus: 'pending_review' });
    expect(await linkOf('main_branch', tenant.id, tenant.id)).not.toBeNull();

    // An explicit clear (what builds 21 to 24 send without an area): link and marker go.
    const cleared = await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { address: 'x', areaId: null } });
    expect(cleared.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson.areaId).toBeNull();
    expect(tenant.mainBranchDataJson.areaRequestId).toBeUndefined();
    expect(tenant.mainBranchDataJson.areaStatus).toBeUndefined();
    expect(await linkOf('main_branch', tenant.id, tenant.id)).toBeNull();
  });

  test('gym-profile: a real area replaces a link; a request of another city than the branch → 422', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user);
    const r = await makeRequest(h.user.id, peshawar, 'Swap Town');
    await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { cityId: peshawar.id, areaRequestId: r.id } });
    const swap = await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { areaId: hayatabad.id } });
    expect(swap.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson).toMatchObject({ areaId: hayatabad.id });
    expect(tenant.mainBranchDataJson.areaRequestId).toBeUndefined();
    expect(await linkOf('main_branch', tenant.id, tenant.id)).toBeNull();
    const lahoreReq = await makeRequest(h.user.id, lahore, 'Lahore Branch Town');
    expectCode(await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { areaRequestId: lahoreReq.id } }), 422, 'area_not_listed');
  });

  test('GET /tenants/me: pendingArea for the tenant and mainBranchDataJson.pendingArea for the draft first branch', async () => {
    const h = await newHost();
    const r1 = await makeRequest(h.user.id, peshawar, 'Org Town');
    const r2 = await makeRequest(h.user.id, peshawar, 'Draft Branch Town');
    await h.as().post('/tenants/register').send({ businessName: 'Me Gym', email: `me${seq}@new265w.test`, cityId: peshawar.id, areaRequestId: r1.id });
    const tenant = await Tenant.findOne({ where: { ownerUserId: h.user.id } });
    await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { areaRequestId: r2.id } });
    const res = await h.as().get('/tenants/me');
    expect(res.status).toBe(200);
    expect(res.body.data.tenant.pendingArea).toEqual({ requestId: r1.id, name: 'Org Town', status: 'pending_review', rejectReason: null });
    expect(res.body.data.tenant.mainBranchDataJson.pendingArea).toEqual({ requestId: r2.id, name: 'Draft Branch Town', status: 'pending_review', rejectReason: null });
  });
});

describe('A4: PATCH /tenants/me area (R-109, F3)', () => {
  test('DRAFT: a real area, then a request, then a real area again', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user);
    const real = await h.as().patch('/tenants/me').send({ areaId: hayatabad.id });
    expect(real.status).toBe(200);
    expect(await Tenant.findByPk(tenant.id)).toMatchObject({ areaId: hayatabad.id, areaStatus: null });

    const r = await makeRequest(h.user.id, peshawar, 'Patch Town');
    const pending = await h.as().patch('/tenants/me').send({ areaRequestId: r.id });
    expect(pending.status).toBe(200);
    expect(await Tenant.findByPk(tenant.id)).toMatchObject({ areaId: null, areaStatus: 'pending_review', areaRequestId: r.id });
    expect(await linkOf('tenant', tenant.id, tenant.id)).toMatchObject({ areaRequestId: r.id });
    expect(pending.body.data.tenant.pendingArea).toMatchObject({ requestId: r.id, status: 'pending_review' });

    await h.as().patch('/tenants/me').send({ areaId: hayatabad.id });
    expect(await Tenant.findByPk(tenant.id)).toMatchObject({ areaId: hayatabad.id, areaStatus: null, areaRequestId: null });
    expect(await linkOf('tenant', tenant.id, tenant.id)).toBeNull();
  });

  test('PENDING_REVIEW works too; other fields stay ACTIVE-only (not saved)', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user, { status: 'PENDING_REVIEW', businessName: 'Before Name' });
    const res = await h.as().patch('/tenants/me').send({ areaId: hayatabad.id, businessName: 'After Name' });
    expect(res.status).toBe(200);
    expect(await Tenant.findByPk(tenant.id)).toMatchObject({ areaId: hayatabad.id, businessName: 'Before Name' });
  });

  test('a rejected request, another city\'s area or request → 422; the tenant keeps its area', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user, { areaId: hayatabad.id });
    const rejected = await makeRequest(h.user.id, peshawar, 'Nope Town', 'rejected');
    expectCode(await h.as().patch('/tenants/me').send({ areaRequestId: rejected.id }), 422, 'area_request_rejected');
    expectCode(await h.as().patch('/tenants/me').send({ areaId: gulberg.id }), 422, 'area_not_listed');
    const other = await makeRequest(h.user.id, lahore, 'Other City Town');
    expectCode(await h.as().patch('/tenants/me').send({ areaRequestId: other.id }), 422, 'area_not_listed');
    expect((await Tenant.findByPk(tenant.id)).areaId).toBe(hayatabad.id);
  });

  test('ACTIVE: an area on PATCH /tenants/me → 422 area_change_not_allowed; other fields unchanged', async () => {
    expectCode(await asPersona('owner').patch('/tenants/me').send({ areaId: hayatabad.id }), 422, 'area_change_not_allowed');
    expectCode(await asPersona('owner').patch('/tenants/me').send({ areaRequestId: 1 }), 422, 'area_change_not_allowed');
    const ok = await asPersona('owner').patch('/tenants/me').send({ phone: '+923001112299' });
    expect(ok.status).toBe(200);
  });

  test('DRAFT without area keys: 404 as today', async () => {
    const h = await newHost();
    await draftTenant(h.user);
    expect((await h.as().patch('/tenants/me').send({ businessName: 'X' })).status).toBe(404);
  });
});

describe('A4: "Choose your area again" (rejected marker, GET /host/status)', () => {
  test('a rejected tenant area: /host/status area { status rejected, target tenant }; picking again clears it', async () => {
    const h = await newHost();
    const r = await makeRequest(h.user.id, peshawar, 'Soon Refused Town');
    const tenant = await draftTenant(h.user);
    await h.as().patch('/tenants/me').send({ areaRequestId: r.id });
    // What the admin reject writes (A6): the request and the gym's marker.
    await r.update({ status: 'rejected', openKey: null, rejectReason: 'Not in Peshawar' });
    await Tenant.update({ areaStatus: 'rejected' }, { where: { id: tenant.id } });

    const status = await h.as().get('/host/status');
    expect(status.status).toBe(200);
    expect(status.body.data.area).toEqual({ status: 'rejected', name: 'Soon Refused Town', rejectReason: 'Not in Peshawar', target: 'tenant' });
    const me = await h.as().get('/tenants/me');
    expect(me.body.data.tenant.pendingArea).toEqual({ requestId: r.id, name: 'Soon Refused Town', status: 'rejected', rejectReason: 'Not in Peshawar' });

    await h.as().patch('/tenants/me').send({ areaId: hayatabad.id });
    expect(await Tenant.findByPk(tenant.id)).toMatchObject({ areaStatus: null, areaRequestId: null, areaId: hayatabad.id });
    expect((await h.as().get('/host/status')).body.data.area).toBeNull();
  });

  test('a rejected draft first branch area: target main_branch', async () => {
    const h = await newHost();
    const tenant = await draftTenant(h.user, { areaId: hayatabad.id });
    const r = await makeRequest(h.user.id, peshawar, 'Branch Refused Town');
    await h.as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { areaRequestId: r.id } });
    await r.update({ status: 'rejected', openKey: null, rejectReason: 'Duplicate' });
    await tenant.reload();
    await tenant.update({ mainBranchDataJson: { ...tenant.mainBranchDataJson, areaStatus: 'rejected' } });
    const status = await h.as().get('/host/status');
    expect(status.body.data.area).toEqual({ status: 'rejected', name: 'Branch Refused Town', rejectReason: 'Duplicate', target: 'main_branch' });
  });

  test('no request anywhere: area null', async () => {
    const h = await newHost();
    await draftTenant(h.user, { areaId: hayatabad.id });
    expect((await h.as().get('/host/status')).body.data.area).toBeNull();
  });
});

describe('A4: host listing and branch routes', () => {
  // R-119 Q2: the first branch is held until the business is approved; its `branch` link is written when the
  // approval builds it (tests/regression/r-119-create-rules.test.js). At submit: the listing link and marker,
  // and the request kept in the held branch.
  test('POST /host/listings with areaRequestId writes the listing link and marker, and holds the request for the first branch (R-109, F5; R-119 Q2)', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Two Links Town');
    const res = await asPersona('owner').post('/host/listings').send({
      gymName: `Org 265 ${Date.now()}`, cityId: peshawar.id, areaRequestId: r.id, packages: [{ name: 'Monthly', price: 50 }],
    });
    expect(res.status).toBe(201);
    const listingId = res.body.data.id;
    expect(res.body.data).toMatchObject({ branch: null, heldFirstBranch: true });
    const listing = await GymListing.findByPk(listingId);
    expect(listing).toMatchObject({ areaId: null, areaStatus: 'pending_review', areaRequestId: r.id });
    expect(listing.firstBranchDataJson).toMatchObject({ areaId: null, areaRequestId: r.id });
    expect(await linkOf('listing', ctx.tenant1.id, listingId)).toMatchObject({ areaRequestId: r.id });
    // Reads.
    const one = await asPersona('owner').get(`/host/listings/${listingId}`);
    expect(one.body.data.pendingArea).toMatchObject({ requestId: r.id, name: 'Two Links Town', status: 'pending_review' });
    const all = await asPersona('owner').get('/host/listings');
    const rows = Array.isArray(all.body.data) ? all.body.data : (all.body.data.listings || all.body.data.organizations || []);
    expect(rows.find((l) => l.id === listingId).pendingArea).toMatchObject({ requestId: r.id });
    // Let the next create through (approval_pending guard on a PENDING organization).
    await GymListing.update({ status: 'ACTIVE' }, { where: { id: listingId } });
  });

  test('PUT /host/listings/:id: a request links the listing; a field not sent keeps it; a real area clears link and marker', async () => {
    const { listing1 } = ctx;
    const r = await makeRequest(ownerUserId, peshawar, 'Listing Town');
    expect((await asPersona('owner').put(`/host/listings/${listing1.id}`).send({ cityId: peshawar.id, areaRequestId: r.id })).status).toBe(200);
    expect(await GymListing.findByPk(listing1.id)).toMatchObject({ areaId: null, areaStatus: 'pending_review', areaRequestId: r.id });
    expect((await asPersona('owner').patch(`/host/listings/${listing1.id}`).send({ gymName: 'Renamed' })).status).toBe(200);
    expect(await linkOf('listing', ctx.tenant1.id, listing1.id)).toMatchObject({ areaRequestId: r.id });
    expect((await asPersona('owner').patch(`/host/listings/${listing1.id}`).send({ areaId: hayatabad.id })).status).toBe(200);
    expect(await GymListing.findByPk(listing1.id)).toMatchObject({ areaId: hayatabad.id, areaStatus: null, areaRequestId: null });
    expect(await linkOf('listing', ctx.tenant1.id, listing1.id)).toBeNull();
  });

  test('POST /host/branches with areaRequestId writes the branch link', async () => {
    const r = await makeRequest(ownerUserId, peshawar, 'Host Branch Town');
    const res = await asPersona('owner').post('/host/branches').send({
      branchName: `HB ${Date.now()}`, cityId: peshawar.id, areaRequestId: r.id, packages: [{ name: 'Monthly', price: 50 }],
    });
    expect(res.status).toBe(201);
    expect(await linkOf('branch', ctx.tenant1.id, res.body.data.branch.id)).toMatchObject({ areaRequestId: r.id });
  });

  test('PATCH /host/branches/:id/listing-content and PATCH /gyms/branches/:id: link, keep, clear, reads', async () => {
    const { branch1, tenant1Db, tenant1 } = ctx;
    await tenant1Db.models.Branch.update({ cityId: peshawar.id, areaId: hayatabad.id }, { where: { id: branch1.id } });
    const r = await makeRequest(ownerUserId, peshawar, 'Content Town');
    const set = await asPersona('owner').patch(`/host/branches/${branch1.id}/listing-content`).send({ areaRequestId: r.id });
    expect(set.status).toBe(200);
    expect((await tenant1Db.models.Branch.findByPk(branch1.id)).areaId).toBeNull();
    expect(await linkOf('branch', tenant1.id, branch1.id)).toMatchObject({ areaRequestId: r.id });

    // Reads.
    const pa = { requestId: r.id, name: 'Content Town', status: 'pending_review', rejectReason: null };
    expect((await asPersona('owner').get(`/gyms/branches/${branch1.id}`)).body.data.branch.pendingArea).toEqual(pa);
    expect((await asPersona('owner').get(`/host/branches/${branch1.id}/listing-content`)).body.data.branch.pendingArea).toEqual(pa);
    const list = await asPersona('owner').get('/gyms/branches');
    expect(list.body.data.branches.find((b) => b.id === branch1.id).pendingArea).toEqual(pa);
    const hostList = await asPersona('owner').get('/host/branches');
    expect(hostList.body.data.branches.find((b) => b.id === branch1.id).pendingArea).toEqual(pa);

    // Not sent = kept.
    expect((await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ phone: '+923001234500' })).status).toBe(200);
    expect(await linkOf('branch', tenant1.id, branch1.id)).not.toBeNull();
    // Moving the branch to another city while it keeps a Peshawar request → 422 area_not_listed (as NEW-259 for areas).
    expectCode(await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ cityId: lahore.id }), 422, 'area_not_listed');
    // An explicit clear.
    expect((await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ areaRequestId: null })).status).toBe(200);
    expect(await linkOf('branch', tenant1.id, branch1.id)).toBeNull();
    expect((await asPersona('owner').get(`/gyms/branches/${branch1.id}`)).body.data.branch.pendingArea).toBeNull();
  });
});

describe('A4: admin routes take real areas only, and a real area clears the link (R-109, F7)', () => {
  test('PATCH /admin/tenants/:id/branches/:branchId with a real area removes the branch link; GET shows pendingArea before', async () => {
    const { branch1, tenant1 } = ctx;
    const r = await makeRequest(ownerUserId, peshawar, 'Admin Sees Town');
    await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ cityId: peshawar.id, areaRequestId: r.id });
    const read = await asPersona('platformAdmin').get(`/admin/tenants/${tenant1.id}/branches`);
    expect(read.status).toBe(200);
    const branches = read.body.data.branches || read.body.data;
    expect(branches.find((b) => b.id === branch1.id).pendingArea).toMatchObject({ requestId: r.id, status: 'pending_review' });

    const res = await asPersona('platformAdmin').patch(`/admin/tenants/${tenant1.id}/branches/${branch1.id}`).send({ areaId: hayatabad.id });
    expect(res.status).toBe(200);
    expect(await linkOf('branch', tenant1.id, branch1.id)).toBeNull();
  });

  test('PATCH /admin/tenants/:id/gym-listing with a real area clears the listing link and marker; GET shows pendingArea', async () => {
    const { listing1, tenant1 } = ctx;
    const r = await makeRequest(ownerUserId, peshawar, 'Admin Listing Town');
    await asPersona('owner').patch(`/host/listings/${listing1.id}`).send({ cityId: peshawar.id, areaRequestId: r.id });
    const read = await asPersona('platformAdmin').get(`/admin/tenants/${tenant1.id}:${listing1.id}/gym-listing`);
    expect(read.body.data.gymListing.pendingArea).toMatchObject({ requestId: r.id });
    const res = await asPersona('platformAdmin').patch(`/admin/tenants/${tenant1.id}:${listing1.id}/gym-listing`).send({ areaId: hayatabad.id });
    expect(res.status).toBe(200);
    expect(await GymListing.findByPk(listing1.id)).toMatchObject({ areaId: hayatabad.id, areaStatus: null, areaRequestId: null });
    expect(await linkOf('listing', tenant1.id, listing1.id)).toBeNull();
  });

  test('POST /admin/tenants/:id/branches ignores areaRequestId (no link is written)', async () => {
    const { tenant1 } = ctx;
    const r = await makeRequest(ownerUserId, peshawar, 'Admin Ignores Town');
    const res = await asPersona('platformAdmin').post(`/admin/tenants/${tenant1.id}/branches`).send({ branchName: `Adm ${Date.now()}`, cityId: peshawar.id, areaRequestId: r.id });
    expect(res.status).toBeLessThan(300);
    const branch = res.body.data.branch;
    expect(await linkOf('branch', tenant1.id, branch.id)).toBeNull();
  });
});
