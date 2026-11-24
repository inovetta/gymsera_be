/**
 * R-120 A3 J13 (owner J12): POST /host/staging-images, a stateless image upload for a first-time host who has no
 * organization yet. It stores the files and returns the URLs; it saves nothing about a business or a draft.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { Tenant, GymListing } = require('../../src/models/platform');

// A 1 x 1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let h;
beforeAll(async () => {
  h = await setupTestDatabases();
  await setupPersonas(h);
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('POST /host/staging-images', () => {
  test('a signed-in user with no organization uploads and gets URLs; no organization or business row is created', async () => {
    const before = [await Tenant.count(), await GymListing.count()];
    const res = await asPersona('member').post('/host/staging-images').attach('images', PNG, 'a.png').attach('images', PNG, 'b.png');
    expect(res.status).toBe(200);
    expect(res.body.data.urls).toHaveLength(2);
    for (const u of res.body.data.urls) expect(typeof u).toBe('string');
    expect([await Tenant.count(), await GymListing.count()]).toEqual(before);
  });

  test('no file: 422; anonymous: 401', async () => {
    expect((await asPersona('member').post('/host/staging-images')).status).toBe(422);
    expect((await asPersona('anonymous').post('/host/staging-images').attach('images', PNG, 'a.png')).status).toBe(401);
  });
});
