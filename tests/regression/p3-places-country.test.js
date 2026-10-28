/**
 * P3 device follow-up: address and city search stay in the host's country and near the picked city.
 *
 * Before: `places.service.js` autocomplete sent no region and no bias for an address (and no region for a
 * city unless the optional GOOGLE_PLACES_REGION_CODES was set), so typing "Pesh" on the Become a Host
 * address field showed "Peshtigo, WI, USA" on a production device.
 * After: every autocomplete carries `includedRegionCodes`: the selected city's country (stored on
 * `cities.country_code` from Google, migration p025), else GOOGLE_PLACES_REGION_CODES, else Pakistan.
 * An address search with a city is biased to a circle around the city centre.
 *
 * Google is never called: global.fetch is replaced per test.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

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

const noSuggestions = { 'places:autocomplete': () => ({ body: { suggestions: [] } }) };
const sentBody = () => JSON.parse(calls[0].init.body);
const component = (longText, types, shortText = longText) => ({ longText, shortText, types });

beforeAll(async () => {
  process.env.GOOGLE_MAPS_SERVER_KEY = 'test-server-key-not-real';
  delete process.env.GOOGLE_PLACES_REGION_CODES;
  const h = await setupTestDatabases();
  await setupPersonas(h);
});

afterEach(() => {
  if (fetchSpy) fetchSpy.mockRestore();
  fetchSpy = null;
  delete process.env.GOOGLE_PLACES_REGION_CODES;
});

afterAll(async () => {
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  await stopTestServer();
  await teardownTestDatabases();
});

describe('autocomplete stays in the host country', () => {
  test('an address search with no city is limited to Pakistan by default ("Pesh" never shows the USA)', async () => {
    fakeGoogle(noSuggestions);
    const res = await asPersona('owner').get('/places/autocomplete?input=Pesh&kind=address&sessionToken=c1');
    expect(res.status).toBe(200);
    expect(sentBody().includedRegionCodes).toEqual(['pk']);
  });

  test('a city search is limited to Pakistan by default', async () => {
    fakeGoogle(noSuggestions);
    await asPersona('owner').get('/places/autocomplete?input=Pesh&kind=city&sessionToken=c2');
    expect(sentBody().includedRegionCodes).toEqual(['pk']);
  });

  test('an address search with the selected city uses its country and a circle around its centre', async () => {
    const { City } = require('../../src/models/platform');
    const city = await City.create({ name: 'Country Peshawar', isActive: true, latitude: 34.0151, longitude: 71.5249, countryCode: 'PK' });
    fakeGoogle(noSuggestions);
    const res = await asPersona('owner').get(`/places/autocomplete?input=Pesh&kind=address&sessionToken=c3&cityId=${city.id}`);
    expect(res.status).toBe(200);
    const sent = sentBody();
    expect(sent.includedRegionCodes).toEqual(['pk']);
    expect(sent.locationBias.circle.center).toEqual({ latitude: 34.0151, longitude: 71.5249 });
    expect(sent.locationBias.circle.radius).toBeGreaterThan(0);
    expect(sent.input).toBe('Pesh');
  });

  test('a city in another country searches that country, for addresses and areas', async () => {
    const { City } = require('../../src/models/platform');
    const dubai = await City.create({ name: 'Country Dubai', isActive: true, latitude: 25.2048, longitude: 55.2708, countryCode: 'AE' });
    fakeGoogle(noSuggestions);
    await asPersona('owner').get(`/places/autocomplete?input=Marina&kind=address&sessionToken=c4&cityId=${dubai.id}`);
    expect(sentBody().includedRegionCodes).toEqual(['ae']);
    fetchSpy.mockRestore();
    fakeGoogle(noSuggestions);
    await asPersona('owner').get(`/places/autocomplete?input=Marina&kind=area&sessionToken=c5&cityId=${dubai.id}`);
    expect(sentBody().includedRegionCodes).toEqual(['ae']);
  });

  test('GOOGLE_PLACES_REGION_CODES replaces the Pakistan default when the city has no country yet', async () => {
    process.env.GOOGLE_PLACES_REGION_CODES = 'pk, ae';
    const { City } = require('../../src/models/platform');
    const old = await City.create({ name: 'Country Unknown', isActive: true });
    fakeGoogle(noSuggestions);
    await asPersona('owner').get(`/places/autocomplete?input=Sadd&kind=address&sessionToken=c6&cityId=${old.id}`);
    const sent = sentBody();
    expect(sent.includedRegionCodes).toEqual(['pk', 'ae']);
    expect(sent.locationBias).toBeUndefined(); // no centre known: no invented circle
  });

  test('an address search with an unknown city still searches (default country, no bias)', async () => {
    fakeGoogle(noSuggestions);
    const res = await asPersona('owner').get('/places/autocomplete?input=Pesh&kind=address&sessionToken=c7&cityId=987654');
    expect(res.status).toBe(200);
    expect(sentBody()).toMatchObject({ includedRegionCodes: ['pk'] });
    expect(sentBody().locationBias).toBeUndefined();
  });

  test('cityId must be a whole number when sent with an address search', async () => {
    fakeGoogle({});
    const res = await asPersona('owner').get('/places/autocomplete?input=Pesh&kind=address&sessionToken=c8&cityId=abc');
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('a city learns its country from Google', () => {
  test('picking a city stores its country code', async () => {
    fakeGoogle({
      '/places/pl-country-mardan': () => ({
        body: {
          id: 'pl-country-mardan',
          displayName: { text: 'Country Mardan' },
          location: { latitude: 34.198, longitude: 72.0404 },
          addressComponents: [component('Country Mardan', ['locality', 'political']), component('Pakistan', ['country', 'political'], 'PK')],
        },
      }),
    });
    const res = await asPersona('owner').get('/places/details/pl-country-mardan?kind=city&sessionToken=d1');
    expect(res.status).toBe(200);
    const { City } = require('../../src/models/platform');
    expect((await City.findByPk(res.body.data.city.id)).countryCode).toBe('PK');
  });

  test('"Use current location" stores the country of the city it finds', async () => {
    fakeGoogle({
      'geocode/json': () => ({
        body: {
          status: 'OK',
          results: [
            {
              place_id: 'rg-top',
              formatted_address: 'Saddar, Country Swat, Pakistan',
              types: ['street_address'],
              address_components: [
                { long_name: 'Country Swat', short_name: 'Country Swat', types: ['locality', 'political'] },
                { long_name: 'Pakistan', short_name: 'PK', types: ['country', 'political'] },
              ],
            },
          ],
        },
      }),
    });
    const res = await asPersona('owner').get('/places/reverse-geocode?lat=34.77&lng=72.36');
    expect(res.status).toBe(200);
    const { City } = require('../../src/models/platform');
    expect((await City.findByPk(res.body.data.city.id)).countryCode).toBe('PK');
  });
});
