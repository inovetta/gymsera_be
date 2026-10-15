/**
 * RT-01 — FCM token lifecycle (spec §9.4).
 *
 * Logout used to call DELETE /notifications/token with no token when the
 * device had none cached, and the server then wiped EVERY token of the user:
 * one device's logout silenced all the others. The call now has to name its
 * own token (400 otherwise). Registration stores appVersion / locale /
 * timezone, and a token still moves to the user that registers it last.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { DeviceToken } = require('../../src/models/platform');

describe('RT-01: device token lifecycle', () => {
  let app;
  let userA;
  let userB;
  const bearer = (user) =>
    `Bearer ${signToken({ sub: user.id, id: user.id, role: 'MEMBER', isVerified: true })}`;

  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    userA = await factories.createUser({ email: 'rt01-a@gymseratest.com', role: 'MEMBER' });
    userB = await factories.createUser({ email: 'rt01-b@gymseratest.com', role: 'MEMBER' });
  });

  const register = (user, body) =>
    request(app).post('/api/v1/notifications/token').set('Authorization', bearer(user)).send(body);
  const unregister = (user, body) =>
    request(app).delete('/api/v1/notifications/token').set('Authorization', bearer(user)).send(body);

  test('DELETE without a token is rejected and no device of the user is removed', async () => {
    await register(userA, { token: 'tok-phone', platform: 'android' });
    await register(userA, { token: 'tok-tablet', platform: 'android' });

    const res = await unregister(userA, {});

    expect(res.status).toBe(400);
    expect(await DeviceToken.count({ where: { userId: userA.id } })).toBe(2);
  });

  test('DELETE with a token removes only that device', async () => {
    await register(userA, { token: 'tok-phone', platform: 'android' });
    await register(userA, { token: 'tok-tablet', platform: 'android' });

    const res = await unregister(userA, { token: 'tok-phone' });

    expect(res.status).toBe(200);
    const left = await DeviceToken.findAll({ where: { userId: userA.id } });
    expect(left.map((t) => t.token)).toEqual(['tok-tablet']);
  });

  test("a user cannot delete another user's token", async () => {
    await register(userA, { token: 'tok-a', platform: 'android' });

    await unregister(userB, { token: 'tok-a' });

    expect(await DeviceToken.count({ where: { token: 'tok-a' } })).toBe(1);
  });

  test('registering stores appVersion, locale and timezone', async () => {
    const res = await register(userA, {
      token: 'tok-1',
      platform: 'ios',
      appVersion: '1.4.2',
      locale: 'en-PK',
      timezone: 'Asia/Karachi',
    });

    expect(res.status).toBe(200);
    const row = await DeviceToken.findOne({ where: { token: 'tok-1' } });
    expect(row.appVersion).toBe('1.4.2');
    expect(row.locale).toBe('en-PK');
    expect(row.timezone).toBe('Asia/Karachi');
  });

  test('re-registering a token moves it to the new user (one owner at a time)', async () => {
    await register(userA, { token: 'tok-shared', platform: 'android' });
    await register(userB, { token: 'tok-shared', platform: 'android' });

    const rows = await DeviceToken.findAll({ where: { token: 'tok-shared' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userB.id);
  });
});
