/**
 * S5: local-only fake Places provider (`PLACES_PROVIDER=fake` in non-production) allows city, area,
 * address and reverse-geocode calls to work from seeded cities/areas without a Google key, while
 * remaining disabled in production (where missing GOOGLE_MAPS_SERVER_KEY still returns 503 places_not_configured).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { City, Area } = require('../../src/models/platform');

const savedEnv = {
  PLACES_PROVIDER: process.env.PLACES_PROVIDER,
  GOOGLE_MAPS_SERVER_KEY: process.env.GOOGLE_MAPS_SERVER_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

beforeAll(async () => {
  await setupPersonas(await setupTestDatabases());
});

afterEach(() => {
  if (savedEnv.PLACES_PROVIDER === undefined) delete process.env.PLACES_PROVIDER;
  else process.env.PLACES_PROVIDER = savedEnv.PLACES_PROVIDER;
  if (savedEnv.GOOGLE_MAPS_SERVER_KEY === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
  else process.env.GOOGLE_MAPS_SERVER_KEY = savedEnv.GOOGLE_MAPS_SERVER_KEY;
  process.env.NODE_ENV = savedEnv.NODE_ENV;
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test('PLACES_PROVIDER=fake resolves seeded cities, areas, addresses and reverse-geocode without Google key', async () => {
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  process.env.NODE_ENV = 'staging';
  process.env.PLACES_PROVIDER = 'fake';

  const city = await City.create({ name: 'LahoreFake', isActive: true, latitude: 31.5204, longitude: 74.3587 });
  const area = await Area.create({ cityId: city.id, name: 'Gulberg Fake' });

  const citySearch = await asPersona('member').get('/places/autocomplete?input=LahoreF&kind=city&sessionToken=s1');
  expect(citySearch.status).toBe(200);
  expect(citySearch.body.data.suggestions).toEqual([
    { placeId: `fake-city-${city.id}`, primaryText: 'LahoreFake', secondaryText: 'Pakistan' },
  ]);

  const cityDetails = await asPersona('member').get(`/places/details/fake-city-${city.id}?kind=city&sessionToken=s1`);
  expect(cityDetails.status).toBe(200);
  expect(cityDetails.body.data.city).toEqual({ id: city.id, name: 'LahoreFake' });
  expect(cityDetails.body.data.latitude).toBeCloseTo(31.5204, 3);

  const areaSearch = await asPersona('member').get(`/places/autocomplete?input=Gulberg&kind=area&cityId=${city.id}&sessionToken=s2`);
  expect(areaSearch.status).toBe(200);
  expect(areaSearch.body.data.suggestions[0]).toMatchObject({
    placeId: `gymsera-area:${area.id}`,
    primaryText: 'Gulberg Fake',
    source: 'gymsera',
  });

  const emptyAreaSearch = await asPersona('member').get(`/places/autocomplete?input=NoSuchPlace&kind=area&cityId=${city.id}&sessionToken=s2`);
  expect(emptyAreaSearch.status).toBe(200);
  expect(emptyAreaSearch.body.data.suggestions).toEqual([]);

  const addrSearch = await asPersona('member').get(`/places/autocomplete?input=Main+Boulevard&kind=address&cityId=${city.id}&sessionToken=s3`);
  expect(addrSearch.status).toBe(200);
  const addrPlaceId = addrSearch.body.data.suggestions[0].placeId;
  const addrDetails = await asPersona('member').get(`/places/details/${addrPlaceId}?kind=address&cityId=${city.id}&sessionToken=s3`);
  expect(addrDetails.status).toBe(200);
  expect(addrDetails.body.data.city).toEqual({ id: city.id, name: 'LahoreFake' });

  const geo = await asPersona('member').get('/places/reverse-geocode?lat=31.52&lng=74.35');
  expect(geo.status).toBe(200);
  expect(geo.body.data.city).toBeTruthy();
});

test('PLACES_PROVIDER=fake is ignored in production (fails closed with 503 places_not_configured)', async () => {
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  process.env.NODE_ENV = 'production';
  process.env.PLACES_PROVIDER = 'fake';

  const res = await asPersona('member').get('/places/autocomplete?input=Lah&kind=city&sessionToken=s1');
  expect(res.status).toBe(503);
  expect(res.body.code).toBe('places_not_configured');
});

