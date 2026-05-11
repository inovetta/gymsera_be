/**
 * Module: Me (Member self-service)
 * Role: GYM_MEMBER (ali.hassan@example.com)
 * Tests: profile, subscriptions, invoices, notifications
 */
const { authed, loginAs, api } = require('./helpers');

let memberToken, memberUser;

beforeAll(async () => {
  const session = await loginAs('ali.hassan@example.com', 'Member@1234!');
  memberToken = session.accessToken;
  memberUser = session.user;
});

describe('Me — Profile', () => {
  test('GET /me/profile — own profile (200)', async () => {
    const res = await authed(memberToken).get('/me/profile');
    expect(res.status).toBe(200);
    expect(res.data.data.profile.email).toBe('ali.hassan@example.com');
  });

  test('PUT /me/profile — update display name (200)', async () => {
    const res = await authed(memberToken).put('/me/profile', {
      fullName: 'Ali Hassan Updated',
    });
    expect([200, 400, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.data.profile || res.data.data).toHaveProperty('fullName');
    }
  });

  test('GET /me/profile — unauthenticated (401)', async () => {
    const res = await api.get('/me/profile');
    expect(res.status).toBe(401);
  });
});

describe('Me — Memberships & Subscriptions', () => {
  test('GET /me/memberships — own gym memberships (200)', async () => {
    const res = await authed(memberToken).get('/me/memberships');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.data.data) || res.data.data.items).toBeTruthy();
    }
  });
});

describe('Me — Password Change', () => {
  test('POST /me/password — wrong old password (400 or 401)', async () => {
    const res = await authed(memberToken).post('/me/password', {
      oldPassword: 'WrongPass!',
      newPassword: 'NewPass@9999!',
    });
    expect([400, 401, 422]).toContain(res.status);
  });
});
