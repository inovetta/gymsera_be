'use strict';

/**
 * Regression test for 2A blocker 1:
 * - 15 s timeout on normal routes (cut off with 408 request_timeout).
 * - 120 s timeout on upload routes (KYC documents, payment proofs, profile images, poster, gallery).
 * - Timeout does not cause duplicate writes: retries with same Idempotency-Key return 409 while handler is running.
 * - Resolved response is returned on retry once background handler completes.
 */

const http = require('http');
const express = require('express');
const request = require('supertest');
const { requestTimeout, isUploadRoute, isProvisioningRoute } = require('../../src/middleware/timeout');
const idempotency = require('../../src/middleware/idempotency');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');

describe('2A Blocker 1: Request Timeout & Upload Exemption & Idempotency Protection', () => {
  let dbHarness;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  describe('Route Classification', () => {
    test('isUploadRoute correctly identifies upload routes and rejects normal routes', () => {
      expect(isUploadRoute('/api/v1/tenants/me/kyc/documents')).toBe(true);
      expect(isUploadRoute('/api/v1/tenants/onboarding/kyc/documents')).toBe(true);
      expect(isUploadRoute('/api/v1/me/payment-proof')).toBe(true);
      expect(isUploadRoute('/api/v1/payments/123/proof')).toBe(true);
      expect(isUploadRoute('/api/v1/subscriptions/456/proof')).toBe(true);
      expect(isUploadRoute('/api/v1/me/profile-image')).toBe(true);
      expect(isUploadRoute('/api/v1/users/me/profile/image')).toBe(true);
      expect(isUploadRoute('/api/v1/membership-plans/789/poster')).toBe(true);
      expect(isUploadRoute('/api/v1/gyms/profile/images')).toBe(true);
      expect(isUploadRoute('/api/v1/tenants/123/logo')).toBe(true);
      expect(isUploadRoute('/api/v1/tenants/123/cover')).toBe(true);

      // Normal routes must NOT be classified as uploads
      expect(isUploadRoute('/api/v1/tenants/me')).toBe(false);
      expect(isUploadRoute('/api/v1/host/listings')).toBe(false);
      expect(isUploadRoute('/api/v1/auth/login')).toBe(false);
      expect(isUploadRoute('/api/v1/payments')).toBe(false);
      expect(isUploadRoute('/api/v1/branches')).toBe(false);
    });

    test('isProvisioningRoute correctly identifies provisioning routes', () => {
      expect(isProvisioningRoute('/api/v1/admin/tenants/123/approve')).toBe(true);
      expect(isProvisioningRoute('/api/v1/tenants/provision')).toBe(true);
      expect(isProvisioningRoute('/api/v1/tenants/me')).toBe(false);
    });
  });

  describe('Timeout Enforcement: Upload Route (120s) vs Normal Route (15s)', () => {
    let app;
    let server;

    beforeEach(async () => {
      app = express();
      app.use(express.json());
      // Test app with scaled limits: normal = 50ms, upload = 200ms
      app.use(requestTimeout(50, 200));

      app.get('/api/v1/normal-route', async (req, res) => {
        // Takes 100ms: should exceed normal limit (50ms) but would be under upload limit
        await new Promise((r) => setTimeout(r, 100));
        if (!res.headersSent) res.json({ success: true, normal: true });
      });

      app.post('/api/v1/me/profile-image', async (req, res) => {
        // Takes 100ms: exceeds normal limit (50ms), but under upload limit (200ms)
        await new Promise((r) => setTimeout(r, 100));
        if (!res.headersSent) res.json({ success: true, uploaded: true });
      });

      app.post('/api/v1/tenants/me/kyc/documents', async (req, res) => {
        // Takes 100ms: under upload limit
        await new Promise((r) => setTimeout(r, 100));
        if (!res.headersSent) res.json({ success: true, kyc: true });
      });

      app.post('/api/v1/payments/proof', async (req, res) => {
        // Exceeds even upload limit (250ms > 200ms)
        await new Promise((r) => setTimeout(r, 250));
        if (!res.headersSent) res.json({ success: true, proof: true });
      });

      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('Normal route is cut off at normal timeout limit with 408 request_timeout', async () => {
      const res = await request(server).get('/api/v1/normal-route');
      expect(res.status).toBe(408);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('request_timeout');
    });

    test('Upload route is NOT cut off at normal timeout limit and completes successfully', async () => {
      const res = await request(server).post('/api/v1/me/profile-image');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.uploaded).toBe(true);
    });

    test('KYC document upload route is NOT cut off at normal timeout limit', async () => {
      const res = await request(server).post('/api/v1/tenants/me/kyc/documents');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.kyc).toBe(true);
    });

    test('Upload route exceeding upload limit is cut off with 408', async () => {
      const res = await request(server).post('/api/v1/payments/proof');
      expect(res.status).toBe(408);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('request_timeout');
    });
  });

  describe('Idempotency & Timeout Protection Against Duplicate Writes', () => {
    let app;
    let server;
    let writeCount = 0;
    let completeHandler;
    let handlerStarted;

    beforeEach(async () => {
      writeCount = 0;
      app = express();
      app.use(express.json());
      // Scaled timeout: 50ms normal limit
      app.use(requestTimeout(50, 200));

      app.use((req, _res, next) => {
        req.tenantDb = dbHarness.tenant1;
        next();
      });

      app.post('/api/v1/mutations', idempotency({ required: true }), async (req, res) => {
        writeCount++;
        if (handlerStarted) handlerStarted();
        // Simulate slow write: wait for completeHandler promise
        await new Promise((resolve) => {
          completeHandler = resolve;
        });
        if (!res.headersSent) {
          res.json({ success: true, writeCount });
        } else {
          // Headers already sent via 408: handler still completes and calls res.json
          res.json({ success: true, writeCount, backgroundCompleted: true });
        }
      });

      server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterEach(async () => {
      if (completeHandler) {
        completeHandler();
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('timeout while handler is still running does NOT allow duplicate write on retry with same Idempotency-Key', async () => {
      const key = `timeout-idemp-${Date.now()}`;

      let handlerStartedResolve;
      const startedPromise = new Promise((resolve) => {
        handlerStartedResolve = resolve;
      });
      handlerStarted = handlerStartedResolve;

      // 1. Initial request starts and times out at 50ms
      const initialReqPromise = new Promise((resolve, reject) => {
        request(server)
          .post('/api/v1/mutations')
          .set('Idempotency-Key', key)
          .send({ action: 'create_record' })
          .end((err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
      });

      // Ensure handler has begun execution
      await startedPromise;

      // Await the 408 timeout response on the initial request
      const res1 = await initialReqPromise;
      expect(res1.status).toBe(408);
      expect(res1.body.code).toBe('request_timeout');
      expect(writeCount).toBe(1);

      // 2. Client immediately retries while handler is STILL running in background
      const res2 = await request(server)
        .post('/api/v1/mutations')
        .set('Idempotency-Key', key)
        .send({ action: 'create_record' });

      // MUST receive 409 request_in_progress, NOT a second write!
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('request_in_progress');
      expect(writeCount).toBe(1); // STILL 1! No second write occurred!

      // 3. Complete the original background handler
      completeHandler();
      // Allow async saveRecord to resolve
      await new Promise((r) => setTimeout(r, 50));

      // 4. Client retries after background handler has completed
      const res3 = await request(server)
        .post('/api/v1/mutations')
        .set('Idempotency-Key', key)
        .send({ action: 'create_record' });

      // MUST replay the completed result
      expect(res3.status).toBe(200);
      expect(res3.headers['x-idempotent-replay']).toBe('true');
      expect(res3.body.writeCount).toBe(1);
      expect(writeCount).toBe(1); // STILL 1! Perfect idempotency across timeout!
    });
  });
});
