/**
 * NEW-265 Part A (R-108, R-109): a typed area is a pending request, never an official area.
 * Spec §13 "NEW-265 Part A", A2 (name rules, limits) and A3 (host routes on /places).
 *
 * Before: a host could only pick our areas or Google's neighbourhoods / sublocalities; a typed name had no
 * path (POST /places/areas is platform admins only, R-107); a road or landmark was never offered; details()
 * called Google even for a place id we already hold; reverse geocode had no answer for a road.
 *
 * After: POST /places/area-requests(/check) creates a pending request (name rules, word list, "Did you
 * mean …?", 5 a day, 3 open per city); autocomplete with extended=true also offers roads and landmarks and
 * tags every suggestion with source / type; details() answers a known place id without Google and turns a
 * road / landmark into a pending request; reverse geocode returns a road / landmark as a suggestion and
 * creates nothing. Builds 21 to 24 see exactly what they saw before.
 *
 * Google is never called: global.fetch is replaced per test (the network jail would refuse it anyway).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');

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
const noGoogle = () => fakeGoogle({});
const prediction = (placeId, main, secondary, types) => ({
  placePrediction: { placeId, types, structuredFormat: { mainText: { text: main }, secondaryText: { text: secondary } } },
});
const component = (longText, types) => ({ longText, shortText: longText, types });

let City;
let Area;
let AreaRequest;
let AreaAlias;
let peshawar;
let lahore;
let hayatabad;
let universityTown;
let gulberg;

let seq = 0;
const newHost = async () => {
  seq += 1;
  const user = await factories.createUser({ email: `h${seq}-${Date.now()}@new265.test`, role: 'GYM_HOST', isHost: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
  const as = () => asPersona('anonymous', { Authorization: `Bearer ${token}` });
  return { user, as };
};

beforeAll(async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = 'test-server-key-not-real';
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ({ City, Area, AreaRequest, AreaAlias } = require('../../src/models/platform'));
  peshawar = await City.create({ name: 'Peshawar265', isActive: true, latitude: 34.0151, longitude: 71.5249 });
  lahore = await City.create({ name: 'Lahore265', isActive: true, latitude: 31.5204, longitude: 74.3587 });
  hayatabad = await Area.create({ cityId: peshawar.id, name: 'Hayatabad', googlePlaceId: 'pl-hayatabad' });
  universityTown = await Area.create({ cityId: peshawar.id, name: 'University Town' });
  gulberg = await Area.create({ cityId: lahore.id, name: 'Gulberg' });
  await AreaAlias.create({ cityId: peshawar.id, aliasKey: 'hayatabadphase1', areaId: hayatabad.id });
  // The NEW-256 starter word list (the harness database starts with an empty list, as new-256 does).
  const { STARTER_WORDS } = require('../../src/constants/moderation');
  await require('../../src/services/moderation-words.service').replaceWords([...STARTER_WORDS]);
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

describe('A2: name rules (one function for /check, create and the admin approve)', () => {
  const rules = () => require('../../src/services/area-requests.service');

  test('name_key: lower case, no spaces or punctuation; any script', () => {
    expect(rules().nameKeyOf('  Shinwari   Town ')).toBe('shinwaritown');
    expect(rules().nameKeyOf('Bilal\'s Colony / Phase-2 & 3.')).toBe('bilalscolonyphase23');
    expect(rules().nameKeyOf('حیات آباد')).toBe('حیاتآباد');
  });

  test.each([
    ['ab', 'area_name_invalid'], // too short after cleaning
    ['a'.repeat(61), 'area_name_invalid'],
    ['12', 'area_name_invalid'],
    ['1 2 3 4', 'area_name_invalid'], // fewer than 2 letters
    ['Town <b>', 'area_name_invalid'], // character not allowed
    ['call 03001234567', 'area_name_invalid'], // 7+ digits in a row
    ['www.example.com', 'area_name_invalid'], // link
    ['Town fuck', 'area_name_blocked'], // the NEW-256 word list
  ])('"%s" → 422 %s', async (name, code) => {
    await expect(rules().validateAreaName(name)).rejects.toMatchObject({ statusCode: 422, code });
  });

  test('a blocked word is never echoed in the message', async () => {
    const err = await rules().validateAreaName('Fuck Town').catch((e) => e);
    expect(err.code).toBe('area_name_blocked');
    expect(err.message).toBe('Please choose a different name.');
  });

  test.each([
    ['  Shinwari   Town ', 'Shinwari Town'],
    ['حیات آباد', 'حیات آباد'],
    ['St. John\'s / Phase-2 & 3', 'St. John\'s / Phase-2 & 3'],
    ['Sector 7', 'Sector 7'],
  ])('"%s" is accepted as "%s"', async (input, clean) => {
    await expect(rules().validateAreaName(input)).resolves.toBe(clean);
  });
});

describe('A3: POST /places/area-requests/check (writes nothing)', () => {
  test('an existing area or an alias answers the area, no similar list needed', async () => {
    const h = await newHost();
    const exact = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'hayatabad' });
    expect(exact.status).toBe(200);
    expect(exact.body.data).toMatchObject({ name: 'hayatabad', match: { areaId: hayatabad.id, name: 'Hayatabad' }, canRequest: true, reason: null });
    const alias = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'Hayatabad Phase-1' });
    expect(alias.body.data.match).toEqual({ areaId: hayatabad.id, name: 'Hayatabad' });
    expect(await AreaRequest.count({ where: { requestedByUserId: h.user.id } })).toBe(0);
  });

  test('similar names: edit distance or containment, at most 3, closest first; other cities never', async () => {
    const h = await newHost();
    const res = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'Universty Town' });
    expect(res.status).toBe(200);
    expect(res.body.data.match).toBeNull();
    expect(res.body.data.similar[0]).toEqual({ name: 'University Town', areaId: universityTown.id, status: 'approved' });
    expect(res.body.data.similar.length).toBeLessThanOrEqual(3);
    const contains = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'Hayatabad Phase 7' });
    expect(contains.body.data.similar.map((s) => s.areaId)).toContain(hayatabad.id);
    const lahoreName = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'Gulberg' });
    expect(lahoreName.body.data.match).toBeNull();
    expect(lahoreName.body.data.similar.map((s) => s.areaId)).not.toContain(gulberg.id);
  });

  test('unknown city 404 city_not_found; invalid name 422; blocked 422', async () => {
    const h = await newHost();
    expect((await h.as().post('/places/area-requests/check').send({ cityId: 99999999, name: 'Shinwari Town' })).body.code).toBe('city_not_found');
    expect((await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'x' })).body.code).toBe('area_name_invalid');
    expect((await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'fuck town' })).body.code).toBe('area_name_blocked');
  });
});

describe('A3: POST /places/area-requests', () => {
  test('201 a pending request (typed); the name is cleaned; audit areas.request.create', async () => {
    const h = await newHost();
    const res = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: '  Shinwari   Town ' });
    expect(res.status).toBe(201);
    expect(res.body.data.areaRequest).toMatchObject({ cityId: peshawar.id, name: 'Shinwari Town', status: 'pending_review', source: 'typed' });
    const row = await AreaRequest.findByPk(res.body.data.areaRequest.id);
    expect(row).toMatchObject({ nameKey: 'shinwaritown', requestedByUserId: h.user.id, openKey: `${h.user.id}:${peshawar.id}:shinwaritown` });
    expect(await Area.count({ where: { name: 'Shinwari Town' } })).toBe(0);
    const { PlatformAuditLog } = require('../../src/models/platform');
    expect(await PlatformAuditLog.count({ where: { action: 'areas.request.create', actorUserId: h.user.id } })).toBe(1);
  });

  test('200 { area } when the name or an alias is already an area; 200 the own open request with that spelling', async () => {
    const h = await newHost();
    const area = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'HAYATABAD' });
    expect(area.status).toBe(200);
    expect(area.body.data).toEqual({ area: { id: hayatabad.id, name: 'Hayatabad' } });
    const alias = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Hayatabad phase 1' });
    expect(alias.body.data).toEqual({ area: { id: hayatabad.id, name: 'Hayatabad' } });

    const first = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Board Bazaar' });
    expect(first.status).toBe(201);
    const again = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'board  bazaar' });
    expect(again.status).toBe(200);
    expect(again.body.data.areaRequest.id).toBe(first.body.data.areaRequest.id);
    expect(await AreaRequest.count({ where: { requestedByUserId: h.user.id } })).toBe(1);
  });

  test('409 area_similar_exists with the list unless confirmNotListed is true (the server does not trust the app)', async () => {
    const h = await newHost();
    const res = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Universty Town' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('area_similar_exists');
    expect(res.body.data.similar[0]).toMatchObject({ name: 'University Town', areaId: universityTown.id });
    expect(await AreaRequest.count({ where: { requestedByUserId: h.user.id } })).toBe(0);
    const ok = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Universty Town', confirmNotListed: true });
    expect(ok.status).toBe(201);
  });

  test('another person\'s open request with the same spelling does not block: the requests group for the admin', async () => {
    const a = await newHost();
    const b = await newHost();
    expect((await a.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Tehkal Bala' })).status).toBe(201);
    const res = await b.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'tehkal bala' });
    expect(res.status).toBe(201);
    expect(await AreaRequest.count({ where: { cityId: peshawar.id, nameKey: 'tehkalbala' } })).toBe(2);
  });

  test('limits: the 4th open request in a city → 429 area_requests_city_limit; own open request / area not counted', async () => {
    const h = await newHost();
    for (const n of ['Alpha Ville', 'Bravo Ville', 'Charlie Ville']) {
      expect((await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: n, confirmNotListed: true })).status).toBe(201);
    }
    const fourth = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Delta Ville', confirmNotListed: true });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('area_requests_city_limit');
    // Answering an existing area or the person's own open request still works.
    expect((await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Alpha Ville' })).status).toBe(200);
    expect((await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Hayatabad' })).status).toBe(200);
    // Another city is its own count.
    expect((await h.as().post('/places/area-requests').send({ cityId: lahore.id, name: 'Echo Ville', confirmNotListed: true })).status).toBe(201);
    const check = await h.as().post('/places/area-requests/check').send({ cityId: peshawar.id, name: 'Foxtrot Ville' });
    expect(check.body.data).toMatchObject({ canRequest: false, reason: 'area_requests_city_limit' });
  });

  test('limits: the 6th new request in 24 hours → 429 area_requests_daily_limit (decided ones count too)', async () => {
    const h = await newHost();
    const cities = [peshawar, lahore];
    for (let i = 0; i < 5; i += 1) {
      const res = await h.as().post('/places/area-requests').send({ cityId: cities[i % 2].id, name: `Daily Place ${'abcde'[i]}`, confirmNotListed: true });
      expect(res.status).toBe(201);
      if (i < 2) await AreaRequest.update({ status: 'rejected', openKey: null }, { where: { id: res.body.data.areaRequest.id } });
    }
    const sixth = await h.as().post('/places/area-requests').send({ cityId: lahore.id, name: 'Daily Place f', confirmNotListed: true });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('area_requests_daily_limit');
    // A request older than 24 hours no longer counts.
    const [oldest] = await AreaRequest.findAll({ where: { requestedByUserId: h.user.id }, order: [['id', 'ASC']], limit: 1 });
    await AreaRequest.sequelize.query('UPDATE area_requests SET created_at = DATE_SUB(NOW(), INTERVAL 25 HOUR) WHERE id = ?', { replacements: [oldest.id] });
    expect((await h.as().post('/places/area-requests').send({ cityId: lahore.id, name: 'Daily Place f', confirmNotListed: true })).status).toBe(201);
  });

  test('errors: 404 city_not_found, 422 area_name_invalid / area_name_blocked, nothing saved', async () => {
    const h = await newHost();
    expect((await h.as().post('/places/area-requests').send({ cityId: 99999999, name: 'Shinwari Town' })).body.code).toBe('city_not_found');
    expect((await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: '<script>' })).body.code).toBe('area_name_invalid');
    expect((await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'motherfucker lane' })).body.code).toBe('area_name_blocked');
  });

  test('a signed-out caller gets 401', async () => {
    const res = await asPersona('anonymous').post('/places/area-requests').send({ cityId: peshawar.id, name: 'Shinwari Town' });
    expect(res.status).toBe(401);
  });
});

describe('A3: GET /places/area-requests/:id', () => {
  test('the requester reads it; a stranger gets 404 area_request_not_found', async () => {
    const h = await newHost();
    const other = await newHost();
    const created = await h.as().post('/places/area-requests').send({ cityId: peshawar.id, name: 'Gulbahar Colony', confirmNotListed: true });
    const id = created.body.data.areaRequest.id;
    const res = await h.as().get(`/places/area-requests/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.areaRequest).toEqual({ id, cityId: peshawar.id, name: 'Gulbahar Colony', status: 'pending_review', area: null, rejectReason: null });
    const stranger = await other.as().get(`/places/area-requests/${id}`);
    expect(stranger.status).toBe(404);
    expect(stranger.body.code).toBe('area_request_not_found');
  });
});

describe('A3: autocomplete extended=true (roads and landmarks only for build 25)', () => {
  const search = (as, input, extended) => as.get(`/places/autocomplete?input=${encodeURIComponent(input)}&kind=area&sessionToken=s265&cityId=${peshawar.id}${extended ? '&extended=true' : ''}`);

  test('without extended: the Google types stay neighbourhood / sublocality (builds 21 to 24)', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [] } }) });
    await search(asPersona('owner'), 'Ring');
    expect(JSON.parse(calls[0].init.body).includedPrimaryTypes).toEqual(['sublocality', 'neighborhood']);
  });

  test('with extended: roads and landmarks are asked too; every suggestion carries source and type', async () => {
    fakeGoogle({
      'places:autocomplete': () => ({
        body: {
          suggestions: [
            prediction('pl-ring-road', 'Ring Road', 'Peshawar265, Pakistan', ['route']),
            prediction('pl-fort', 'Bala Hisar Fort', 'Peshawar265, Pakistan', ['landmark', 'point_of_interest']),
            prediction('pl-hay2', 'Hayatabad Phase 2', 'Peshawar265, Pakistan', ['sublocality', 'political']),
            prediction('pl-other', 'Ring Road', 'Rawalpindi, Pakistan', ['route']),
          ],
        },
      }),
    });
    const res = await search(asPersona('owner'), 'Hayatabad', true);
    expect(res.status).toBe(200);
    expect(JSON.parse(calls[0].init.body).includedPrimaryTypes).toEqual(['sublocality', 'neighborhood', 'route', 'landmark']);
    const s = res.body.data.suggestions;
    expect(s[0]).toMatchObject({ placeId: `gymsera-area:${hayatabad.id}`, source: 'gymsera', type: 'area' });
    expect(s.find((x) => x.placeId === 'pl-ring-road')).toMatchObject({ source: 'google', type: 'road' });
    expect(s.find((x) => x.placeId === 'pl-fort')).toMatchObject({ source: 'google', type: 'landmark' });
    expect(s.find((x) => x.placeId === 'pl-hay2')).toMatchObject({ source: 'google', type: 'area' });
    // Secondary text that does not name the city is dropped (both modes).
    expect(s.find((x) => x.placeId === 'pl-other')).toBeUndefined();
  });

  test('without extended, a Google result whose secondary text does not name the city is dropped too', async () => {
    fakeGoogle({
      'places:autocomplete': () => ({
        body: { suggestions: [prediction('pl-p', 'Tehkal', 'Peshawar265, Pakistan'), prediction('pl-q', 'Tehkal', 'Karachi, Pakistan')] },
      }),
    });
    const res = await search(asPersona('owner'), 'Tehkal');
    expect(res.body.data.suggestions.map((x) => x.placeId)).toEqual(['pl-p']);
    expect(res.body.data.suggestions[0]).toMatchObject({ source: 'google', type: 'area' });
  });

  test('an alias matches our area', async () => {
    fakeGoogle({ 'places:autocomplete': () => ({ body: { suggestions: [] } }) });
    const res = await search(asPersona('owner'), 'hayatabad phase 1');
    expect(res.body.data.suggestions[0]).toMatchObject({ placeId: `gymsera-area:${hayatabad.id}`, primaryText: 'Hayatabad', source: 'gymsera' });
  });
});

describe('A3: GET /places/details (kind area)', () => {
  test('a place id we already hold in this city is answered from areas, without calling Google', async () => {
    noGoogle();
    const res = await asPersona('owner').get(`/places/details/pl-hayatabad?kind=area&sessionToken=s1&cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.area).toEqual({ id: hayatabad.id, name: 'Hayatabad' });
    expect(calls).toHaveLength(0);
  });

  test('a Google neighbourhood stays an official area at pick (R-108 point 2)', async () => {
    fakeGoogle({
      'places/pl-dabgari': () => ({
        body: {
          id: 'pl-dabgari', types: ['neighborhood', 'political'], displayName: { text: 'Dabgari Gardens' },
          addressComponents: [component('Dabgari Gardens', ['neighborhood']), component('Peshawar265', ['locality'])],
        },
      }),
    });
    const res = await asPersona('owner').get(`/places/details/pl-dabgari?kind=area&sessionToken=s2&cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.area.name).toBe('Dabgari Gardens');
    expect(res.body.data.areaRequest).toBeUndefined();
  });

  test('a Google road is no area: a pending request (source google_road, with its place id)', async () => {
    const h = await newHost();
    fakeGoogle({
      'places/pl-warsak-road': () => ({
        body: {
          id: 'pl-warsak-road', types: ['route'], displayName: { text: 'Warsak Road' }, location: { latitude: 34.02, longitude: 71.5 },
          addressComponents: [component('Warsak Road', ['route']), component('Peshawar265', ['locality'])],
        },
      }),
    });
    const res = await h.as().get(`/places/details/pl-warsak-road?kind=area&sessionToken=s3&cityId=${peshawar.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.area).toBeNull();
    expect(res.body.data.areaRequest).toMatchObject({ name: 'Warsak Road', status: 'pending_review', source: 'google_road' });
    const row = await AreaRequest.findByPk(res.body.data.areaRequest.id);
    expect(row).toMatchObject({ googlePlaceId: 'pl-warsak-road', requestedByUserId: h.user.id, cityId: peshawar.id });
    expect(await Area.count({ where: { name: 'Warsak Road' } })).toBe(0);
  });

  test('a Google landmark: pending request (google_landmark); an area with that name wins', async () => {
    const h = await newHost();
    fakeGoogle({
      'places/pl-museum': () => ({
        body: {
          id: 'pl-museum', types: ['museum', 'point_of_interest', 'establishment'], displayName: { text: 'Peshawar Museum' },
          addressComponents: [component('Peshawar265', ['locality'])],
        },
      }),
      'places/pl-uni-landmark': () => ({
        body: {
          id: 'pl-uni-landmark', types: ['landmark', 'point_of_interest'], displayName: { text: 'University Town' },
          addressComponents: [component('Peshawar265', ['locality'])],
        },
      }),
    });
    const museum = await h.as().get(`/places/details/pl-museum?kind=area&sessionToken=s4&cityId=${peshawar.id}`);
    expect(museum.body.data.areaRequest).toMatchObject({ name: 'Peshawar Museum', source: 'google_landmark' });
    const known = await h.as().get(`/places/details/pl-uni-landmark?kind=area&sessionToken=s5&cityId=${peshawar.id}`);
    expect(known.body.data.area).toEqual({ id: universityTown.id, name: 'University Town' });
    expect(known.body.data.areaRequest).toBeUndefined();
  });
});

describe('A3: GET /places/reverse-geocode (R-109, F6): a road or landmark is a suggestion and creates nothing', () => {
  const geocode = (results) => fakeGoogle({ 'geocode/json': () => ({ body: { status: 'OK', results } }) });

  test('a neighbourhood at the point is an official area, as today', async () => {
    geocode([{
      place_id: 'pl-g1', formatted_address: 'Hayatabad, Peshawar265',
      address_components: [{ long_name: 'Hayatabad', types: ['sublocality', 'political'] }, { long_name: 'Peshawar265', types: ['locality'] }],
      types: ['street_address'],
    }]);
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=34.0&lng=71.5');
    expect(res.status).toBe(200);
    expect(res.body.data.area).toEqual({ id: hayatabad.id, name: 'Hayatabad' });
    expect(res.body.data.areaSuggestion).toBeUndefined();
  });

  test('only a road at the point: area null, areaSuggestion google_road; no area and no request row', async () => {
    const areasBefore = await Area.count();
    const requestsBefore = await AreaRequest.count();
    geocode([
      {
        place_id: 'pl-g2', formatted_address: 'Charsadda Road, Peshawar265',
        address_components: [{ long_name: 'Charsadda Road', types: ['route'] }, { long_name: 'Peshawar265', types: ['locality'] }],
        types: ['street_address'],
      },
      { place_id: 'pl-route-cr', types: ['route'], address_components: [{ long_name: 'Charsadda Road', types: ['route'] }] },
    ]);
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=34.05&lng=71.55');
    expect(res.status).toBe(200);
    expect(res.body.data.area).toBeNull();
    expect(res.body.data.areaSuggestion).toEqual({ name: 'Charsadda Road', source: 'google_road', googlePlaceId: 'pl-route-cr' });
    expect(await Area.count()).toBe(areasBefore);
    expect(await AreaRequest.count()).toBe(requestsBefore);
  });

  test('a landmark at the point: areaSuggestion google_landmark', async () => {
    geocode([
      {
        place_id: 'pl-g3', formatted_address: 'Islamia College, Peshawar265', types: ['point_of_interest', 'establishment'],
        address_components: [{ long_name: 'Islamia College', types: ['point_of_interest', 'establishment'] }, { long_name: 'Peshawar265', types: ['locality'] }],
      },
    ]);
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=34.0&lng=71.48');
    expect(res.body.data.area).toBeNull();
    expect(res.body.data.areaSuggestion).toEqual({ name: 'Islamia College', source: 'google_landmark', googlePlaceId: 'pl-g3' });
  });
});

describe('builds 21 to 24 are unchanged', () => {
  test('POST /places/areas stays platform admins only (403 area_not_listed for a host)', async () => {
    const h = await newHost();
    const res = await h.as().post('/places/areas').send({ cityId: peshawar.id, name: 'Typed By Old Build' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('area_not_listed');
  });
});
