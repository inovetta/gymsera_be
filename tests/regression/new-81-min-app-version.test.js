/**
 * NEW-81: the minimum app version the backend wants, so an old build can be told to update.
 * Env: MIN_APP_VERSION_IOS / MIN_APP_VERSION_ANDROID ("1.2.3" or "1.2.3+45"; unset or malformed = no gate),
 * APP_STORE_URL_IOS / APP_STORE_URL_ANDROID. Served by GET /meta/app-config (public, so an app that cannot sign
 * in can still read it) and inside GET /me/bootstrap.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

const KEYS = ['MIN_APP_VERSION_IOS', 'MIN_APP_VERSION_ANDROID', 'APP_STORE_URL_IOS', 'APP_STORE_URL_ANDROID'];
const saved = {};

let appConfig;
beforeAll(() => {
  ({ appConfig } = require('../../src/config/app-version.config'));
});
beforeEach(() => KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
afterEach(() => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

describe('appConfig()', () => {
  test('nothing set: no gate, and a Play Store link for Android only', () => {
    expect(appConfig()).toEqual({
      minAppVersion: { ios: null, android: null },
      storeUrls: { ios: null, android: 'https://play.google.com/store/apps/details?id=com.inovettatech.gymsera' },
    });
  });

  test('reads each platform and the store links from the environment, at call time', () => {
    process.env.MIN_APP_VERSION_IOS = '1.4.0';
    process.env.MIN_APP_VERSION_ANDROID = '1.3.2+27';
    process.env.APP_STORE_URL_IOS = 'https://apps.apple.com/app/id123';
    process.env.APP_STORE_URL_ANDROID = 'https://play.google.com/store/apps/details?id=x';
    expect(appConfig()).toEqual({
      minAppVersion: { ios: '1.4.0', android: '1.3.2+27' },
      storeUrls: { ios: 'https://apps.apple.com/app/id123', android: 'https://play.google.com/store/apps/details?id=x' },
    });
  });

  test('a malformed version is ignored (a typo must not lock every user out)', () => {
    process.env.MIN_APP_VERSION_IOS = 'latest';
    process.env.MIN_APP_VERSION_ANDROID = '2';
    expect(appConfig().minAppVersion).toEqual({ ios: null, android: null });
  });

  test('a store link must be https', () => {
    process.env.APP_STORE_URL_IOS = 'javascript:alert(1)';
    process.env.APP_STORE_URL_ANDROID = 'http://example.com/x';
    expect(appConfig().storeUrls.ios).toBeNull();
    expect(appConfig().storeUrls.android).toMatch(/^https:\/\/play\.google\.com\//);
  });
});

describe('routes', () => {
  let personas;
  let app;
  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    app = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('GET /meta/app-config is public, short-cached, and shows the current env', async () => {
    process.env.MIN_APP_VERSION_ANDROID = '1.5.0';
    const res = await request(app).get('/api/v1/meta/app-config');
    expect(res.status).toBe(200);
    expect(res.body.data.minAppVersion).toEqual({ ios: null, android: '1.5.0' });
    expect(res.headers['cache-control']).toMatch(/public/);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  test('GET /me/bootstrap carries the same values', async () => {
    process.env.MIN_APP_VERSION_IOS = '1.6.0';
    const res = await asPersona('owner').get('/me/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.data.app.minAppVersion).toEqual({ ios: '1.6.0', android: null });
    expect(res.body.data.app.storeUrls.android).toMatch(/play\.google\.com/);
  });
});
