/**
 * Module: Authentication
 * Tests: register → OTP verify → login → refresh → logout → password-reset flow
 */
const { api, loginAs } = require('./helpers');

const TIMESTAMP = Date.now();
const NEW_EMAIL = `test.user.${TIMESTAMP}@example.com`;
let newUserId, debugCode, accessToken, refreshToken;

describe('Auth — Registration & OTP', () => {
  test('POST /auth/register — success (201)', async () => {
    const res = await api.post('/auth/register', {
      fullName: 'Test User',
      email: NEW_EMAIL,
      password: 'Test@1234!',
    });
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toHaveProperty('userId');
    expect(res.data.data).toHaveProperty('debugCode'); // dev only
    newUserId = res.data.data.userId;
    debugCode = res.data.data.debugCode;
  });

  test('POST /auth/register — duplicate email (409)', async () => {
    const res = await api.post('/auth/register', {
      fullName: 'Test User',
      email: NEW_EMAIL,
      password: 'Test@1234!',
    });
    expect(res.status).toBe(409);
    expect(res.data.success).toBe(false);
  });

  test('POST /auth/register — missing fields (422)', async () => {
    const res = await api.post('/auth/register', { email: 'bad' });
    expect(res.status).toBe(422);
  });

  test('POST /auth/otp/verify — success (200)', async () => {
    const res = await api.post('/auth/otp/verify', {
      email: NEW_EMAIL,
      code: debugCode,
    });
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('accessToken');
    accessToken = res.data.data.accessToken;
    refreshToken = res.data.data.refreshToken;
  });

  test('POST /auth/otp/verify — wrong code (400)', async () => {
    const res = await api.post('/auth/otp/verify', {
      email: NEW_EMAIL,
      code: '000000',
    });
    expect(res.status).toBe(400);
  });
});

describe('Auth — Login', () => {
  test('POST /auth/login — seeded admin (200)', async () => {
    const res = await api.post('/auth/login', {
      email: 'admin@gymsera.com',
      password: 'Admin@1234!',
    });
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('accessToken');
  });

  test('POST /auth/login — seeded gym host (200)', async () => {
    const res = await api.post('/auth/login', {
      email: 'ahmed@ironpeak.com',
      password: 'Host@1234!',
    });
    expect(res.status).toBe(200);
  });

  test('POST /auth/login — wrong password (401)', async () => {
    const res = await api.post('/auth/login', {
      email: 'admin@gymsera.com',
      password: 'wrong_password',
    });
    expect(res.status).toBe(401);
  });

  test('POST /auth/login — nonexistent email (401)', async () => {
    const res = await api.post('/auth/login', {
      email: 'nobody@nowhere.com',
      password: 'Test@1234!',
    });
    expect(res.status).toBe(401);
  });
});

describe('Auth — Token & Session', () => {
  test('POST /auth/refresh — valid token (200)', async () => {
    const session = await loginAs('omar.farooq@example.com', 'Member@1234!');
    const res = await api.post('/auth/refresh', { refreshToken: session.refreshToken });
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('accessToken');
  });

  test('POST /auth/refresh — invalid token (401)', async () => {
    const res = await api.post('/auth/refresh', { refreshToken: 'bad.token.here' });
    expect(res.status).toBe(401);
  });

  test('GET /auth/me — authenticated (200)', async () => {
    const session = await loginAs('admin@gymsera.com', 'Admin@1234!');
    const res = await api.get('/auth/me', {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.data.email).toBe('admin@gymsera.com');
  });

  test('GET /auth/me — unauthenticated (401)', async () => {
    const res = await api.get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('POST /auth/password-reset/request — sends reset email (200)', async () => {
    const res = await api.post('/auth/password-reset/request', {
      email: 'fatima.z@example.com',
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });
});
