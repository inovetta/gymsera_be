/**
 * Phase 7 P3 (BUG-01 to BUG-04, R-76): Google Places behind the API.
 *
 * Before: city and area came only from our own `cities` / `areas` lists (BUG-01), the address had no
 * suggestions (BUG-04), "Use current location" relied on the phone's geocoder and never set city or area
 * (BUG-03), and the branch routes accepted any decimal as a coordinate (`gyms.validator.js` isDecimal).
 * After: `/places/*` (signed-in users only) proxies Places API (New) autocomplete, place details and
 * reverse geocoding with the server key from the API env, and every place it resolves is upserted into
 * `cities` / `areas` by Google place id, else by name (no duplicates), so discovery and /admin/cities keep
 * working on our ids. Branches keep the Google place id; coordinates must be in range.
 *
 * Google is never called: global.fetch is replaced per test (the network jail would refuse it anyway).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');

let fetchSpy;
const calls = [];

/** Routes a fake Google answer by URL. `routes` maps a URL fragment to (url, init) => { status, body }. */
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

const component = (longText, types) => ({ longText, shortText: longText, types });

let harness;

beforeAll(async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = 'test-server-key-not-real';
  const h = await setupTestDatabases();
  harness = h;
  await setupPersonas(h);
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

describe('P3: /places needs a signed-in user', () => {
  test.each([
    ['get', '/places/autocomplete?input=Lah&kind=city&sessionToken=s1'],
    ['get', '/places/details/abc?kind=city&sessionToken=s1'],
    ['get', '/places/reverse-geocode?lat=31.5&lng=74.3'],
    ['post', '/places/areas'],
  ])('%s %s answers 401 without a token', async (method, path) => {
    const res = await asPersona('anonymous')[method](path).send({});
    expect(res.status).toBe(401);
  });
});

describe('P3: autocomplete (BUG-01 city then area, BUG-04 address)', () => {
  test('city search asks Google for cities only, with the session token and the server key in a header', async () => {
    fakeGoogle({
      'places:autocomplete': () => ({
        body: {
          suggestions: [
            { placePrediction: { placeId: 'pl-lahore', structuredFormat: { mainText: { text: 'Lahore' }, secondaryText: { text: 'Punjab, Pakistan' } } } },
          ],
        },
      }),
    });
    const res = await asPersona('member').get('/places/autocomplete?input=Lah&kind=city&sessionToken=sess-1');
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([{ placeId: 'pl-lahore', primaryText: 'Lahore', secondaryText: 'Punjab, Pakistan' }]);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toMatchObject({ input: 'Lah', sessionToken: 'sess-1', includedPrimaryTypes: ['(cities)'] });
    expect(calls[0].init.headers['X-Goog-Api-Key']).toBe('test-server-key-not-real');
    expect(calls[0].url).not.toContain('test-server-key-not-real');
  });

  test('area search is limited to areas and biased to the picked city', async () => {
    const { City } = require('../../src/models/platform');
    const city = await City.create({ name: 'Bias City', isActive: true, latitude: 31.52, longitude: 74.35 });
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [] } }) });
    const res = await asPersona('member').get(`/places/autocomplete?input=Gul&kind=area&sessionToken=s2&cityId=${city.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.suggestions).toEqual([]);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.includedPrimaryTypes).toEqual(['sublocality', 'neighborhood']);
    expect(sent.locationBias.circle.center).toEqual({ latitude: 31.52, longitude: 74.35 });
  });

  test('area search without a known city is refused before Google is called', async () => {
    fakeGoogle({});
    const res = await asPersona('member').get('/places/autocomplete?input=Gul&kind=area&sessionToken=s2&cityId=987654');
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('a short input never reaches Google', async () => {
    fakeGoogle({});
    const res = await asPersona('member').get('/places/autocomplete?input=L&kind=city&sessionToken=s1');
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test('Google quota answers 503 places_quota; no key answers 503 places_not_configured', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }) });
    const quota = await asPersona('member').get('/places/autocomplete?input=Lah&kind=city&sessionToken=s1');
    expect(quota.status).toBe(503);
    expect(quota.body.code).toBe('places_quota');
    fetchSpy.mockRestore();

    const saved = process.env.GOOGLE_MAPS_SERVER_KEY;
    delete process.env.GOOGLE_MAPS_SERVER_KEY;
    fakeGoogle({});
    try {
      const off = await asPersona('member').get('/places/autocomplete?input=Lah&kind=city&sessionToken=s1');
      expect(off.status).toBe(503);
      expect(off.body.code).toBe('places_not_configured');
      expect(calls).toHaveLength(0);
    } finally {
      process.env.GOOGLE_MAPS_SERVER_KEY = saved;
    }
  });

  test('Google unreachable answers 503 places_unavailable', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await asPersona('member').get('/places/autocomplete?input=Lah&kind=city&sessionToken=s1');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('places_unavailable');
  });
});

describe('P3: details upsert cities and areas without duplicates (BUG-01, BUG-04)', () => {
  test('picking a city creates it once with its place id and centre; an existing same-name city is reused', async () => {
    const { City } = require('../../src/models/platform');
    const existing = await City.create({ name: 'Multan', isActive: true });
    fakeGoogle({
      'places/pl-multan': () => ({
        body: { id: 'pl-multan', displayName: { text: 'Multan' }, formattedAddress: 'Multan, Pakistan', location: { latitude: 30.1575, longitude: 71.5249 }, types: ['locality', 'political'] },
      }),
    });
    const first = await asPersona('owner').get('/places/details/pl-multan?kind=city&sessionToken=s3');
    expect(first.status).toBe(200);
    expect(first.body.data.city).toEqual({ id: existing.id, name: 'Multan' });
    expect(calls[0].url).toContain('sessionToken=s3');
    expect(calls[0].init.headers['X-Goog-FieldMask']).toContain('addressComponents');

    const second = await asPersona('owner').get('/places/details/pl-multan?kind=city&sessionToken=s4');
    expect(second.body.data.city.id).toBe(existing.id);
    expect(await City.count({ where: { name: 'Multan' } })).toBe(1);
    const row = await City.findByPk(existing.id);
    expect(row.googlePlaceId).toBe('pl-multan');
    expect(Number(row.latitude)).toBeCloseTo(30.1575, 4);
  });

  test('picking an area files it under the picked city, once', async () => {
    const { City, Area } = require('../../src/models/platform');
    const city = await City.create({ name: 'Area Test City', isActive: true });
    fakeGoogle({
      'places/pl-gulberg': () => ({
        body: { id: 'pl-gulberg', displayName: { text: 'Gulberg' }, formattedAddress: 'Gulberg, Area Test City', location: { latitude: 31.51, longitude: 74.34 }, types: ['sublocality'] },
      }),
    });
    const a = await asPersona('owner').get(`/places/details/pl-gulberg?kind=area&sessionToken=s5&cityId=${city.id}`);
    const b = await asPersona('owner').get(`/places/details/pl-gulberg?kind=area&sessionToken=s6&cityId=${city.id}`);
    expect(a.status).toBe(200);
    expect(a.body.data.area.name).toBe('Gulberg');
    expect(b.body.data.area.id).toBe(a.body.data.area.id);
    expect(await Area.count({ where: { cityId: city.id } })).toBe(1);
  });

  test('an address suggestion fills address, coordinates, city and area', async () => {
    fakeGoogle({
      'places/pl-addr': () => ({
        body: {
          id: 'pl-addr',
          formattedAddress: '12 Main Boulevard, Model Town, Addr City, Pakistan',
          location: { latitude: 31.48, longitude: 74.32 },
          addressComponents: [
            component('12', ['street_number']),
            component('Model Town', ['sublocality_level_1', 'sublocality', 'political']),
            component('Addr City', ['locality', 'political']),
            component('Pakistan', ['country', 'political']),
          ],
        },
      }),
    });
    const res = await asPersona('owner').get('/places/details/pl-addr?kind=address&sessionToken=s7');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      placeId: 'pl-addr',
      formattedAddress: '12 Main Boulevard, Model Town, Addr City, Pakistan',
      latitude: 31.48,
      longitude: 74.32,
      city: { name: 'Addr City' },
      area: { name: 'Model Town' },
    });
    expect(res.body.data.city.id).toEqual(expect.any(Number));
    expect(res.body.data.area.id).toEqual(expect.any(Number));
  });
});

describe('P3: reverse geocode for "Use current location" (BUG-03)', () => {
  test('fills address, city and area from Google, with the key never logged in a response', async () => {
    fakeGoogle({
      'geocode/json': (url) => {
        expect(url).toContain('latlng=31.5%2C74.3');
        return {
          body: {
            status: 'OK',
            results: [
              {
                place_id: 'pl-street',
                formatted_address: '5 Canal Road, Johar Town, Geo City, Pakistan',
                geometry: { location: { lat: 31.5001, lng: 74.3002 } },
                types: ['street_address'],
                address_components: [
                  { long_name: 'Johar Town', short_name: 'Johar Town', types: ['sublocality_level_1', 'sublocality', 'political'] },
                  { long_name: 'Geo City', short_name: 'Geo City', types: ['locality', 'political'] },
                ],
              },
              { place_id: 'pl-johar', formatted_address: 'Johar Town', geometry: { location: { lat: 31.47, lng: 74.27 } }, types: ['sublocality_level_1', 'sublocality', 'political'], address_components: [] },
              { place_id: 'pl-geocity', formatted_address: 'Geo City, Pakistan', geometry: { location: { lat: 31.55, lng: 74.34 } }, types: ['locality', 'political'], address_components: [] },
            ],
          },
        };
      },
    });
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=31.5&lng=74.3');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      placeId: 'pl-street',
      formattedAddress: '5 Canal Road, Johar Town, Geo City, Pakistan',
      latitude: 31.5,
      longitude: 74.3,
      city: { name: 'Geo City' },
      area: { name: 'Johar Town' },
    });
    expect(JSON.stringify(res.body)).not.toContain('test-server-key-not-real');
    const { City, Area } = require('../../src/models/platform');
    expect((await City.findByPk(res.body.data.city.id)).googlePlaceId).toBe('pl-geocity');
    expect((await Area.findByPk(res.body.data.area.id)).googlePlaceId).toBe('pl-johar');
  });

  test('an out-of-range coordinate is refused before Google is called', async () => {
    fakeGoogle({});
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=123&lng=74.3');
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test('no result answers 404 place_not_found', async () => {
    fakeGoogle({ 'geocode/json': () => ({ body: { status: 'ZERO_RESULTS', results: [] } }) });
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=0&lng=0');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('place_not_found');
  });
});

describe('P3: the traveller city list carries each city centre', () => {
  test('GET /discovery/cities returns latitude / longitude (null when unknown), never an invented point', async () => {
    const { City, GymListing } = require('../../src/models/platform');
    const withCentre = await City.create({ name: 'Centre City', isActive: true, latitude: 33.6844, longitude: 73.0479 });
    const without = await City.create({ name: 'No Centre City', isActive: true });
    // Phase 7 P6 (BUG-26): the list holds only cities with a live gym, so give each one.
    const liveIn = async (tenantDb, tenantId, cityId) => {
      const listing = await GymListing.findOne({ where: { tenantId } });
      await listing.update({ status: 'ACTIVE', cityId });
      const branch = await tenantDb.models.Branch.findOne({ where: { gymListingId: listing.id } });
      await branch.update({ status: 'ACTIVE', travelerVisibilityStatus: 'active', adminSuspended: false, cityId });
      await tenantDb.models.MembershipPlan.create({
        gymId: branch.gymId, branchId: branch.id, name: 'Monthly', price: 2500,
        durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
      });
    };
    await liveIn(harness.tenant1, personaManager.personas.owner.tenantId, withCentre.id);
    await liveIn(harness.tenant2, personaManager.personas.otherTenantOwner.tenantId, without.id);
    const res = await asPersona('anonymous').get('/discovery/cities');
    expect(res.status).toBe(200);
    const list = res.body.data.cities || res.body.data;
    expect(list.find((c) => c.id === withCentre.id)).toMatchObject({ latitude: 33.6844, longitude: 73.0479 });
    expect(list.find((c) => c.id === without.id)).toMatchObject({ latitude: null, longitude: null });
  });
});

describe('P3: free-text area when Google has no match', () => {
  test('creates the area once per city, matched without case or extra spaces', async () => {
    const { City, Area } = require('../../src/models/platform');
    const city = await City.create({ name: 'Free Text City', isActive: true });
    const a = await asPersona('owner').post('/places/areas').send({ cityId: city.id, name: '  Old   Bazaar ' });
    const b = await asPersona('owner').post('/places/areas').send({ cityId: city.id, name: 'old bazaar' });
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ name: 'Old Bazaar', cityId: city.id });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Area.count({ where: { cityId: city.id } })).toBe(1);
  });

  test('an unknown city or an empty name is refused', async () => {
    expect((await asPersona('owner').post('/places/areas').send({ cityId: 987654, name: 'X Area' })).status).toBe(404);
    expect((await asPersona('owner').post('/places/areas').send({ cityId: 1, name: '   ' })).status).toBe(422);
  });
});

describe('P3: branch coordinates are in range and keep the Google place id', () => {
  test('POST /gyms/branches refuses latitude 123 and longitude 200', async () => {
    const lat = await asPersona('owner').post('/gyms/branches').send({ branchName: 'Bad Lat', latitude: 123, longitude: 74 });
    expect(lat.status).toBe(422);
    expect(lat.body.errors.map((e) => e.field)).toContain('latitude');
    const lng = await asPersona('owner').post('/gyms/branches').send({ branchName: 'Bad Lng', latitude: 31, longitude: 200 });
    expect(lng.status).toBe(422);
    expect(lng.body.errors.map((e) => e.field)).toContain('longitude');
  });

  test('PATCH /gyms/branches/:id refuses an out-of-range latitude and stores googlePlaceId', async () => {
    const { branch1, tenant1Db } = personaManager.context;
    const bad = await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({ latitude: -91 });
    expect(bad.status).toBe(422);

    const ok = await asPersona('owner').patch(`/gyms/branches/${branch1.id}`).send({
      address: '1 Test Road, Lahore', latitude: 31.5, longitude: 74.3, googlePlaceId: 'pl-branch-1',
    });
    expect(ok.status).toBe(200);
    const row = await tenant1Db.models.Branch.findByPk(branch1.id);
    expect(row.googlePlaceId).toBe('pl-branch-1');
    expect(Number(row.latitude)).toBeCloseTo(31.5, 5);
  });

  test('PATCH /host/branches/:id/listing-content (the app branch editor) checks the range and keeps the place id', async () => {
    const { branch1, tenant1Db } = personaManager.context;
    const bad = await asPersona('owner').patch(`/host/branches/${branch1.id}/listing-content`).send({ latitude: 99, longitude: 74 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e) => e.field)).toContain('latitude');

    const ok = await asPersona('owner').patch(`/host/branches/${branch1.id}/listing-content`).send({
      address: '2 Editor Road', latitude: 31.6, longitude: 74.4, googlePlaceId: 'pl-editor-1',
    });
    expect(ok.status).toBe(200);
    expect((await tenant1Db.models.Branch.findByPk(branch1.id)).googlePlaceId).toBe('pl-editor-1');
  });

  test('onboarding refuses an out-of-range main-branch coordinate', async () => {
    const { tenant1 } = personaManager.context;
    const res = await asPersona('owner').post(`/tenants/${tenant1.id}/gym-profile`).send({
      gymName: 'Range Gym', mainBranchData: { address: 'x', latitude: 95, longitude: 74 },
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e) => e.field)).toContain('mainBranchData.latitude');
  });
});
