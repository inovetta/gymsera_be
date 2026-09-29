'use strict';

/**
 * Regression test for AUTH-04:
 * OTP security hardening:
 * 1. 6-digit codes, hashed at rest (SHA-256), never stored in plaintext.
 * 2. 5-10 minute expiry.
 * 3. Lockout after maximum 5 failed attempts (well before 10,000 guesses).
 * 4. 60-second resend cooldown.
 * 5. Per-identifier rate limits.
 * 6. Raw OTP never printed to logs.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { startTestServer } = require('../harness/test-server');
const { setupTestDatabases, teardownTestDatabases } = require('../harness/test-db');
const { Otp, User } = require('../../src/models/platform');

describe('AUTH-04: OTP Security Hardening', () => {
  let appServer;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('OTP code is hashed at rest in DB and expires within 5-10 minutes', async () => {
    const email = `otp_hash_${Date.now()}@example.test`;
    const regRes = await request(appServer)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'OTP Hash Test',
        email,
        password: 'Password123!',
      });

    expect(regRes.status).toBe(201);
    const rawOtp = regRes.body.data.debugCode;
    expect(typeof rawOtp).toBe('string');
    expect(rawOtp).toMatch(/^\d{6}$/);

    // Look up the record directly in the database
    const otpRow = await Otp.findOne({ where: { email } });
    expect(otpRow).not.toBeNull();

    // 1. Must NEVER be stored in plaintext
    expect(otpRow.code).not.toBe(rawOtp);
    // 2. Must be stored as a 64-character SHA-256 hex hash
    expect(otpRow.code).toHaveLength(64);
    expect(otpRow.code).toMatch(/^[0-9a-f]{64}$/);

    // 3. Expiry must be between 5 and 10 minutes from creation
    const createdAt = new Date(otpRow.createdAt).getTime();
    const expiresAt = new Date(otpRow.expiresAt).getTime();
    const ttlMinutes = (expiresAt - createdAt) / (60 * 1000);
    expect(ttlMinutes).toBeGreaterThanOrEqual(5);
    expect(ttlMinutes).toBeLessThanOrEqual(10.1);
  });

  test('Brute force lockout: OTP locks out after 5 failed attempts well before 10,000 guesses', async () => {
    const email = `otp_lockout_${Date.now()}@example.test`;
    const regRes = await request(appServer)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'OTP Lockout Test',
        email,
        password: 'Password123!',
      });

    expect(regRes.status).toBe(201);
    const validCode = regRes.body.data.debugCode;

    // Send 5 incorrect guesses
    for (let i = 1; i <= 5; i++) {
      const wrongCode = String(999990 + i).slice(-6);
      const res = await request(appServer)
        .post('/api/v1/auth/otp/verify')
        .send({ email, code: wrongCode });

      expect(res.status).toBe(400);
    }

    // Now attempt with the CORRECT code on 6th attempt — MUST BE REJECTED because OTP is locked out
    const finalRes = await request(appServer)
      .post('/api/v1/auth/otp/verify')
      .send({ email, code: validCode });

    expect(finalRes.status).toBe(400);
    expect(finalRes.body.message.toLowerCase()).toContain('locked');

    // User must remain unverified
    const user = await User.findOne({ where: { email } });
    expect(user.isVerified).toBe(false);
  });

  test('Resend cooldown: requesting a new OTP within 60 seconds is rejected with 429', async () => {
    const email = `otp_cooldown_${Date.now()}@example.test`;
    const regRes = await request(appServer)
      .post('/api/v1/auth/register')
      .send({
        fullName: 'OTP Cooldown Test',
        email,
        password: 'Password123!',
      });

    expect(regRes.status).toBe(201);

    // Immediate resend attempt
    const resendRes = await request(appServer)
      .post('/api/v1/auth/otp/resend')
      .send({ email });

    expect([429, 400]).toContain(resendRes.status);
    expect(resendRes.body.message.toLowerCase()).toContain('wait');
  });

  test('Source code audit: raw OTP is never printed to logs', () => {
    const srcDir = path.resolve(__dirname, '../../src');
    const filesToScan = [];

    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'socket-bundle.js') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(fullPath);
        else if (entry.name.endsWith('.js')) filesToScan.push(fullPath);
      }
    }
    walk(srcDir);

    const forbiddenPatterns = [
      /console\.(log|info|warn|error)\(.*otp.*code/i,
      /console\.(log|info|warn|error)\(.*code.*otp/i,
      /console\.(log|info|warn|error)\(.*generated.*code/i,
      /console\.(log|info|warn|error)\(.*your.*otp/i,
    ];

    for (const filePath of filesToScan) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });
});
