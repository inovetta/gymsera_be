/**
 * NEW-259 (R-107): the area is picked from a list, inside the chosen city, and created at pick time.
 * NEW-261: GET /cities carries each city's area count (CMS › Cities & Areas showed "0 areas").
 *
 * Before: area suggestions came from Google only, merely biased towards the city (Peshawar hosts saw
 * areas from all of Pakistan); details() filed any Google area under the chosen city; any signed-in user
 * could add a typed area (POST /places/areas); and no write checked that an areaId exists or belongs to
 * the cityId sent with it.
 *
 * After: our own areas of the city come first (placeId `gymsera-area:<id>`, resolved without Google), then
 * Google's, restricted to the city and shown once; details() refuses a Google area of another city
 * (area_outside_city); POST /places/areas is platform administrators only; every areaId write answers
 * 422 area_not_listed when the area is unknown or in another city.
 *
 * Google is never called: global.fetch is replaced per test (the network jail would refuse it anyway).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');

let fetchSpy;
const calls = [];

const fakeGoogle = (routes) => {
  calls.length = 0;
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) throw new Error(`unexpected fetch ${u.split('?')[0]}`);
    const { status = 200, body = {} } = await routes[key](u, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
};

const prediction = (placeId, main, secondary) => ({
  placePrediction: { placeId, structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } } },
});
const component = (longText, types) => ({ longText, shortText: longText, types });

let City;
let Area;
let peshawar; // has a centre
let lahore;
let noCentre;
let hayatabad1;
let ringRoad;
let gulberg; // Lahore

beforeAll(async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = 'test-server-key-not-real';
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ({ City, Area } = require('../../src/models/platform'));
  peshawar = await City.create({ name: 'Peshawar259', isActive: true, latitude: 34.0151, longitude: 71.5249 });
  lahore = await City.create({ name: 'Lahore259', isActive: true, latitude: 31.5204, longitude: 74.3587 });
  noCentre = await City.create({ name: 'Mardan259', isActive: true });
  hayatabad1 = await Area.create({ cityId: peshawar.id, name: 'Hayatabad Phase 1', googlePlaceId: 'pl-hay1' });
  ringRoad = await Area.create({ cityId: peshawar.id, name: 'Ring Road' });
  await Area.create({ cityId: peshawar.id, name: 'University Town' });
  gulberg = await Area.create({ cityId: lahore.id, name: 'Gulberg' });
});

afterEach(() => {
  if (fetchSpy) fetchSpy.mockRestore();
  fetchSpy = null;
});

afterAll(async () => {
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  await stopTestServer();
  await teardownTestDatabases();
});

const areaSearch = (cityId, input) => asPersona('owner').get(`/places/autocomplete?input=${encodeURIComponent(input)}&kind=area&sessionToken=s259&cityId=${cityId}`);

describe('NEW-259: area suggestions stay in the chosen city, ours first', () => {
  test('Google is asked with a location restriction around the city centre, not a bias', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [] } }) });
    const res = await areaSearch(peshawar.id, 'Zzz');
    expect(res.status).toBe(200);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.locationRestriction.circle.center).toEqual({ latitude: 34.0151, longitude: 71.5249 });
    expect(sent.locationBias).toBeUndefined();
    expect(sent.includedPrimaryTypes).toEqual(['sublocality', 'neighborhood']);
  });

  test('our areas of the city come first as gymsera-area:<id>; a Google area we hold is shown once', async () => {
    fakeGoogle({
      'places:autocomplete': () => ({
        body: {
          suggestions: [
            prediction('pl-hay1', 'Hayatabad Phase 1', 'Peshawar259, Pakistan'),
            prediction('pl-hay3', 'Hayatabad Phase 3', 'Peshawar259, Pakistan'),
            prediction('pl-hay3-dup', 'hayatabad phase 3', 'Peshawar259, Pakistan'),
          ],
        },
      }),
    });
    const res = await areaSearch(peshawar.id, 'Haya');
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([
      { placeId: `gymsera-area:${hayatabad1.id}`, primaryText: 'Hayatabad Phase 1', secondaryText: 'Peshawar259' },
      { placeId: 'pl-hay3', primaryText: 'Hayatabad Phase 3', secondaryText: 'Peshawar259, Pakistan' },
    ]);
  });

  test('a Google area with the same name as ours (no place id saved) is offered as ours', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [prediction('pl-ring', 'Ring Road', 'Peshawar259, Pakistan')] } }) });
    const res = await areaSearch(peshawar.id, 'Ring');
    expect(res.body.data.suggestions).toEqual([
      { placeId: `gymsera-area:${ringRoad.id}`, primaryText: 'Ring Road', secondaryText: 'Peshawar259' },
    ]);
  });

  test('another city\'s areas are never offered', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [] } }) });
    const res = await areaSearch(peshawar.id, 'Gulb');
    expect(res.body.data.suggestions).toEqual([]);
    expect(gulberg.cityId).not.toBe(peshawar.id);
  });

  test('a city without a centre: the city name narrows the search and other cities\' results are dropped', async () => {
    fakeGoogle({
      'places:autocomplete': () => ({
        body: {
          suggestions: [
            prediction('pl-m1', 'Sheikh Maltoon Town', 'Mardan259, Pakistan'),
            prediction('pl-l1', 'Model Town', 'Lahore, Pakistan'),
          ],
        },
      }),
    });
    const res = await areaSearch(noCentre.id, 'Town');
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.input).toBe('Town, Mardan259');
    expect(sent.locationRestriction).toBeUndefined();
    expect(res.body.data.suggestions.map((s) => s.placeId)).toEqual(['pl-m1']);
  });

  test('when Google fails, our own matches still answer; with none, the Google error stands', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const ours = await areaSearch(peshawar.id, 'Univ');
    expect(ours.status).toBe(200);
    expect(ours.body.data.suggestions.map((s) => s.primaryText)).toEqual(['University Town']);
    const none = await areaSearch(peshawar.id, 'Qqqq');
    expect(none.status).toBe(503);
    expect(none.body.code).toBe('places_unavailable');
  });
});

describe('NEW-259: details', () => {
  test('gymsera-area:<id> resolves to our area without calling Google', async () => {
    fakeGoogle({});
    const res = await asPersona('owner').get(`/places/details/${encodeURIComponent(`gymsera-area:${ringRoad.id}`)}?kind=area&sessionToken=s1&cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      placeId: `gymsera-area:${ringRoad.id}`,
      city: { id: peshawar.id, name: 'Peshawar259' },
      area: { id: ringRoad.id, name: 'Ring Road' },
    });
    expect(calls).toHaveLength(0);
  });

  test('gymsera-area of another city, or an unknown one, answers 422 area_not_listed', async () => {
    fakeGoogle({});
    const other = await asPersona('owner').get(`/places/details/gymsera-area:${gulberg.id}?kind=area&cityId=${peshawar.id}`);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('area_not_listed');
    const unknown = await asPersona('owner').get(`/places/details/gymsera-area:99999999?kind=area&cityId=${peshawar.id}`);
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('area_not_listed');
    expect(calls).toHaveLength(0);
  });

  test('a Google area that Google files under another city is refused and not saved', async () => {
    fakeGoogle({
      'places/pl-dha-lahore': () => ({
        body: {
          id: 'pl-dha-lahore',
          displayName: { text: 'DHA Phase 5' },
          location: { latitude: 31.46, longitude: 74.4 },
          addressComponents: [component('DHA Phase 5', ['sublocality']), component('Lahore', ['locality', 'political'])],
        },
      }),
    });
    const before = await Area.count({ where: { cityId: peshawar.id } });
    const res = await asPersona('owner').get(`/places/details/pl-dha-lahore?kind=area&sessionToken=s2&cityId=${peshawar.id}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('area_outside_city');
    expect(res.body.message).toContain('Peshawar259');
    expect(await Area.count({ where: { cityId: peshawar.id } })).toBe(before);
  });

  test('a Google area in the chosen city is created at pick time (R-107)', async () => {
    fakeGoogle({
      'places/pl-shinwari': () => ({
        body: {
          id: 'pl-shinwari',
          displayName: { text: 'Shinwari Town' },
          location: { latitude: 34.02, longitude: 71.6 },
          addressComponents: [component('Shinwari Town', ['neighborhood']), component('Peshawar259', ['locality', 'political'])],
        },
      }),
    });
    const res = await asPersona('owner').get(`/places/details/pl-shinwari?kind=area&sessionToken=s3&cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    const row = await Area.findByPk(res.body.data.area.id);
    expect(row).toMatchObject({ cityId: peshawar.id, name: 'Shinwari Town', googlePlaceId: 'pl-shinwari' });
  });
});

describe('NEW-259: a typed area is added by a platform administrator only', () => {
  test('a host gets 403 area_not_listed with the "Contact support" message, and nothing is saved', async () => {
    const res = await asPersona('owner').post('/places/areas').send({ cityId: peshawar.id, name: 'Typed Area 259' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('area_not_listed');
    expect(res.body.message).toContain('Contact support');
    expect(await Area.count({ where: { name: 'Typed Area 259' } })).toBe(0);
  });

  test('a platform administrator can still add one', async () => {
    const res = await asPersona('platformAdmin').post('/places/areas').send({ cityId: peshawar.id, name: 'Admin Area 259' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ cityId: peshawar.id, name: 'Admin Area 259' });
  });
});

describe('NEW-259: every write that takes an areaId checks it belongs to the city', () => {
  const expectNotListed = (res) => {
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('area_not_listed');
    expect(res.body.message).toContain('Can\'t find your area? Contact support.');
  };

  const signedIn = async (role = 'MEMBER') => {
    const user = await factories.createUser({ email: `u${Date.now()}${Math.random().toString(36).slice(2, 7)}@new259.test`, role });
    const { signToken } = require('../../src/utils/jwt.utils');
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role, isVerified: true });
    return { user, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
  };

  test('POST /tenants/register: another city\'s area or an unknown area is refused; a matching one is kept', async () => {
    const { Tenant } = require('../../src/models/platform');
    const a = await signedIn();
    expectNotListed(await a.as().post('/tenants/register').send({ businessName: 'X Gym', email: 'x259@new259.test', cityId: peshawar.id, areaId: gulberg.id }));
    expectNotListed(await a.as().post('/tenants/register').send({ businessName: 'X Gym', email: 'x259@new259.test', cityId: peshawar.id, areaId: 99999999 }));
    expectNotListed(await a.as().post('/tenants/register').send({ businessName: 'X Gym', email: 'x259@new259.test', areaId: ringRoad.id }));
    expect(await Tenant.count({ where: { ownerUserId: a.user.id } })).toBe(0);

    const ok = await a.as().post('/tenants/register').send({ businessName: 'X Gym', email: 'x259@new259.test', cityId: peshawar.id, areaId: ringRoad.id });
    expect(ok.status).toBe(201);
    expect((await Tenant.findOne({ where: { ownerUserId: a.user.id } })).areaId).toBe(ringRoad.id);
  });

  test('POST /tenants/:id/gym-profile: the main branch area must be in the main branch city', async () => {
    const host = await signedIn('GYM_HOST');
    const tenant = await factories.createTenant({
      ownerUserId: host.user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING', cityId: peshawar.id,
    });
    expectNotListed(await host.as().post(`/tenants/${tenant.id}/gym-profile`).send({
      gymName: 'Area Gym', mainBranchData: { address: 'x', cityId: peshawar.id, areaId: gulberg.id },
    }));
    // No cityId in the branch data: the business's city is used.
    expectNotListed(await host.as().post(`/tenants/${tenant.id}/gym-profile`).send({
      gymName: 'Area Gym', mainBranchData: { address: 'x', areaId: gulberg.id },
    }));
    const ok = await host.as().post(`/tenants/${tenant.id}/gym-profile`).send({
      gymName: 'Area Gym', mainBranchData: { address: 'x', cityId: peshawar.id, areaId: ringRoad.id },
    });
    expect(ok.status).toBe(200);
  });

  test('PUT /host/listings/:id (Edit organization)', async () => {
    const { listing1 } = personaManager.context;
    expectNotListed(await asPersona('owner').put(`/host/listings/${listing1.id}`).send({ cityId: peshawar.id, areaId: gulberg.id }));
    const ok = await asPersona('owner').put(`/host/listings/${listing1.id}`).send({ cityId: peshawar.id, areaId: ringRoad.id });
    expect(ok.status).toBe(200);
    // The city alone changes: the organization's area (Ring Road, Peshawar) no longer fits Lahore.
    expectNotListed(await asPersona('owner').put(`/host/listings/${listing1.id}`).send({ cityId: lahore.id }));
  });

  test('POST /host/listings (new organization)', async () => {
    expectNotListed(await asPersona('owner').post('/host/listings').send({
      gymName: 'Area Org 259', cityId: peshawar.id, areaId: gulberg.id, packages: [{ name: 'Monthly', price: 50 }],
    }));
  });

  test('POST /gyms/branches (new branch)', async () => {
    expectNotListed(await asPersona('owner').post('/gyms/branches').send({
      branchName: 'Area Branch 259', cityId: peshawar.id, areaId: gulberg.id, packages: [{ name: 'Monthly', price: 50 }],
    }));
  });

  test('PATCH /gyms/branches/:id and PATCH /host/branches/:id/listing-content', async () => {
    const { branch1, tenant1Db } = personaManager.context;
    expectNotListed(await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ cityId: peshawar.id, areaId: gulberg.id }));
    expectNotListed(await asPersona('owner').patch(`/host/branches/${branch1.id}/listing-content`).send({ cityId: peshawar.id, areaId: gulberg.id }));
    const ok = await asPersona('owner').patch(`/host/branches/${branch1.id}/listing-content`).send({ cityId: peshawar.id, areaId: ringRoad.id });
    expect(ok.status).toBe(200);
    expect((await tenant1Db.models.Branch.findByPk(branch1.id)).areaId).toBe(ringRoad.id);
    // Clearing the area stays allowed.
    const cleared = await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ areaId: null });
    expect(cleared.status).toBe(200);
  });

  test('CMS admin: gym listing and branch edits', async () => {
    const { tenant1, branch1 } = personaManager.context;
    expectNotListed(await asPersona('platformAdmin').patch(`/admin/tenants/${tenant1.id}/gym-listing`).send({ cityId: peshawar.id, areaId: gulberg.id }));
    expectNotListed(await asPersona('platformAdmin').patch(`/admin/tenants/${tenant1.id}/branches/${branch1.id}`).send({ cityId: peshawar.id, areaId: gulberg.id }));
    expectNotListed(await asPersona('platformAdmin').post(`/admin/tenants/${tenant1.id}/branches`).send({
      branchName: 'Admin Area Branch', cityId: peshawar.id, areaId: gulberg.id, packages: [{ name: 'Monthly', price: 50 }],
    }));
  });
});

describe('NEW-261: GET /cities carries each city\'s area count', () => {
  test('areaCount is the number of areas, 0 for a city without any', async () => {
    const res = await asPersona('anonymous').get('/cities');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.map((c) => [c.id, c]));
    expect(byId.get(lahore.id).areaCount).toBe(1);
    expect(byId.get(noCentre.id).areaCount).toBe(0);
    expect(byId.get(peshawar.id).areaCount).toBe(await Area.count({ where: { cityId: peshawar.id } }));
  });
});
