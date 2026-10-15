/**
 * RT-02 / RT-03 — notification socket payload and read endpoints (spec §9.4).
 *
 * RT-02: the realtime payload carries `notificationId` next to `id`, so a
 *        client can reconcile it with the FCM push (which already has it).
 * RT-03: mark-read and mark-all-read return the new `{ unreadCount }` and are
 *        scoped to the caller's notification role, like the list.
 * Additive: `success` and `id` stay.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { signToken } = require('../../src/utils/jwt.utils');
const { Notification } = require('../../src/models/platform');
const notificationsService = require('../../src/services/notifications.service');
const socketGateway = require('../../src/socket');

describe('RT-02 / RT-03: notification realtime payload and read endpoints', () => {
  let app;
  let user;
  const bearer = (u, role) =>
    `Bearer ${signToken({ sub: u.id, id: u.id, role, isVerified: true })}`;

  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    user = await factories.createUser({ email: 'rt0203@gymseratest.com', role: 'GYM_HOST' });
  });

  const make = (role, extra = {}) =>
    Notification.create({ userId: user.id, role, type: 'info', title: 't', message: 'm', ...extra });

  test('RT-02: socket payload carries notificationId equal to id (string), id kept', async () => {
    const spy = jest.spyOn(socketGateway, 'emitToUser').mockImplementation(() => {});
    try {
      const n = await notificationsService.createNotification({
        userId: user.id, role: 'host', type: 'info', title: 'Hi', message: 'There',
      });
      const calls = spy.mock.calls.filter((c) => c[0] === user.id);
      expect(calls.map((c) => c[1]).sort()).toEqual(['new_notification', 'notification']);
      for (const [, , payload] of calls) {
        expect(payload.notificationId).toBe(String(n.id));
        expect(payload.id).toBe(n.id);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('RT-03: mark-read returns the remaining unreadCount for the caller role', async () => {
    const a = await make('host');
    await make('host');
    await make('traveler');

    const res = await request(app)
      .patch(`/api/v1/notifications/${a.id}/read`)
      .set('Authorization', bearer(user, 'GYM_HOST'));

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.unreadCount).toBe(1);
  });

  test('RT-03: mark-read cannot touch a notification of another role of the same user', async () => {
    const traveler = await make('traveler');

    const res = await request(app)
      .patch(`/api/v1/notifications/${traveler.id}/read`)
      .set('Authorization', bearer(user, 'GYM_HOST'));

    expect(res.status).toBe(404);
    expect((await Notification.findByPk(traveler.id)).isRead).toBe(false);
  });

  test('RT-03: mark-all-read returns unreadCount 0 and leaves other roles unread', async () => {
    await make('host');
    await make('host');
    const traveler = await make('traveler');

    const res = await request(app)
      .patch('/api/v1/notifications/read-all')
      .set('Authorization', bearer(user, 'GYM_HOST'));

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.unreadCount).toBe(0);
    expect((await Notification.findByPk(traveler.id)).isRead).toBe(false);
  });
});
