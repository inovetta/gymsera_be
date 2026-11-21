'use strict';

/**
 * NEW-302: a "+" in the email broke sign-up verification and login.
 * Builds 27 / 28 open `/auth/otp-verify?email=<email>` without encoding it; the "+" arrives as a space,
 * so verify, resend and login sent "a b@x.com". The server reads a space inside the address as "+".
 */

const request = require('supertest');
const { startTestServer } = require('../harness/test-server');
const { setupTestDatabases, teardownTestDatabases } = require('../harness/test-db');
const { User } = require('../../src/models/platform');
const { plusFromSpaces } = require('../../src/validators/auth.validator');

const PASSWORD = 'Password123!';

describe('NEW-302: a space in the email is read as "+"', () => {
  let app;

  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('plusFromSpaces: trims, then turns inner spaces into "+"; leaves other values alone', () => {
    expect(plusFromSpaces('  owner qa@example.test ')).toBe('owner+qa@example.test');
    expect(plusFromSpaces('owner+qa@example.test')).toBe('owner+qa@example.test');
    expect(plusFromSpaces('a b c@example.test')).toBe('a+b+c@example.test');
    expect(plusFromSpaces(undefined)).toBeUndefined();
    expect(plusFromSpaces(42)).toBe(42);
  });

  test('sign up with "+", verify and log in with the space form (the old-build URL)', async () => {
    const tag = Date.now();
    const email = `owner+qa${tag}@example.test`;
    const spaced = `owner qa${tag}@example.test`;

    const reg = await request(app).post('/api/v1/auth/register').send({ fullName: 'Plus Alias', email, password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(await User.count({ where: { email } })).toBe(1);

    // Unverified login with the space form finds the same account (not "invalid email" / not found).
    const early = await request(app).post('/api/v1/auth/login').send({ email: spaced, password: PASSWORD });
    expect(early.status).not.toBe(422);
    expect(early.status).not.toBe(401);

    const verify = await request(app).post('/api/v1/auth/otp/verify').send({ email: spaced, code: reg.body.data.debugCode });
    expect(verify.status).toBe(200);
    const user = await User.findOne({ where: { email } });
    expect(user).not.toBeNull();

    const login = await request(app).post('/api/v1/auth/login').send({ email: spaced, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.email).toBe(email);
  });

  test('resend with the space form reaches the "+" account', async () => {
    const tag = Date.now();
    const email = `resend+qa${tag}@example.test`;
    const reg = await request(app).post('/api/v1/auth/register').send({ fullName: 'Plus Resend', email, password: PASSWORD });
    expect(reg.status).toBe(201);

    const resend = await request(app).post('/api/v1/auth/otp/resend').send({ email: `resend qa${tag}@example.test` });
    // 200 (sent) or 429 (the 60 s cooldown of AUTH-04): both mean the account was found, not a 422.
    expect([200, 429]).toContain(resend.status);
  });

  test('sign up with a space stores the "+" address, never a space', async () => {
    const tag = Date.now();
    const reg = await request(app).post('/api/v1/auth/register').send({ fullName: 'Space Sign-up', email: `space qa${tag}@example.test`, password: PASSWORD });
    expect(reg.status).toBe(201);
    expect(await User.count({ where: { email: `space+qa${tag}@example.test` } })).toBe(1);
    expect(await User.count({ where: { email: `space qa${tag}@example.test` } })).toBe(0);
  });

  test('a real format error still fails (the guard is not weakened)', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not an email', password: PASSWORD });
    expect(res.status).toBe(422);
  });
});
