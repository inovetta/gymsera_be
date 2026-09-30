const http = require('http');
const express = require('express');
const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const idempotency = require('../../src/middleware/idempotency');
const { IdempotencyRecord: PlatformIdempotency } = require('../../src/models/platform');

describe('REL-01: Idempotency Middleware (spec §11.2)', () => {
  let dbHarness;
  let server;
  let TenantIdempotency;
  let handlerCallCount = 0;
  let delayedHandlerResolve = null;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    TenantIdempotency = dbHarness.tenant1.models.IdempotencyRecord;

    const app = express();
    app.use(express.json());

    // Inject tenant1 context on /tenant routes
    app.use('/tenant', (req, _res, next) => {
      req.tenantDb = dbHarness.tenant1;
      next();
    });

    // 1. Route with required idempotency
    app.post(
      '/tenant/mutations',
      idempotency({ required: true }),
      (req, res) => {
        handlerCallCount++;
        res.status(201).json({
          success: true,
          action: 'mutation_executed',
          data: req.body,
          count: handlerCallCount,
        });
      }
    );

    // 2. Route with optional idempotency
    app.post(
      '/tenant/optional',
      idempotency({ required: false }),
      (req, res) => {
        handlerCallCount++;
        res.status(200).json({ success: true, count: handlerCallCount });
      }
    );

    // 3. Slow route for in-flight / concurrency testing
    app.post(
      '/tenant/slow-mutation',
      idempotency({ required: true }),
      async (req, res) => {
        handlerCallCount++;
        await new Promise((resolve) => {
          delayedHandlerResolve = resolve;
        });
        res.status(200).json({ success: true, slow: true });
      }
    );

    // 4. Platform route without tenantDb
    app.post(
      '/platform/mutations',
      idempotency({ required: true }),
      (req, res) => {
        handlerCallCount++;
        res.status(201).json({
          success: true,
          scope: 'platform',
          data: req.body,
        });
      }
    );

    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await teardownTestDatabases();
  });

  beforeEach(() => {
    handlerCallCount = 0;
    delayedHandlerResolve = null;
  });

  describe('1. Header validation', () => {
    test('missing Idempotency-Key when required returns 400 with idempotency_key_required', async () => {
      const res = await request(server)
        .post('/tenant/mutations')
        .send({ amount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('idempotency_key_required');
      expect(handlerCallCount).toBe(0);
    });

    test('missing Idempotency-Key when optional proceeds normally without caching', async () => {
      const res = await request(server)
        .post('/tenant/optional')
        .send({ foo: 'bar' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.headers['x-idempotent-replay']).toBeUndefined();
      expect(handlerCallCount).toBe(1);
    });

    test('invalid/empty or too-long Idempotency-Key returns 400', async () => {
      const res = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', 'a'.repeat(129))
        .send({ amount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_idempotency_key');
    });
  });

  describe('2. Replay behavior and execution count', () => {
    test('same key + same parameters: replays exact status & body, executes handler only once', async () => {
      const key = `test-key-${Date.now()}`;
      const payload = { memberId: 'm-123', amount: 500 };

      // First call -> 201 Created
      const res1 = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', key)
        .send(payload);

      expect(res1.status).toBe(201);
      expect(res1.body.success).toBe(true);
      expect(res1.body.count).toBe(1);
      expect(res1.headers['x-idempotent-replay']).toBeUndefined();
      expect(handlerCallCount).toBe(1);

      // Second call with same key and same body -> replays 201 Created
      const res2 = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', key)
        .send(payload);

      expect(res2.status).toBe(201);
      expect(res2.body.success).toBe(true);
      expect(res2.body.count).toBe(1); // Same body replayed
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(res2.headers['idempotency-key']).toBe(key);
      expect(handlerCallCount).toBe(1); // Handler was NOT executed again!

      // Check DB record
      const record = await TenantIdempotency.findOne({ where: { idempotencyKey: key } });
      expect(record).not.toBeNull();
      expect(record.status).toBe('RESOLVED');
      expect(record.statusCode).toBe(201);
      expect(record.responseBody.count).toBe(1);
    });

    test('same key + different parameters returns 422 idempotency_key_reuse', async () => {
      const key = `reuse-key-${Date.now()}`;

      // First call
      const res1 = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', key)
        .send({ amount: 100 });
      expect(res1.status).toBe(201);

      // Second call with DIFFERENT amount
      const res2 = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', key)
        .send({ amount: 200 });

      expect(res2.status).toBe(422);
      expect(res2.body.success).toBe(false);
      expect(res2.body.code).toBe('idempotency_key_reuse');
      expect(handlerCallCount).toBe(1); // Handler not called on 422
    });
  });

  describe('3. Concurrency / In-Flight Request Protection', () => {
    test('request with same key already in-flight returns 409 request_in_progress', async () => {
      const key = `inflight-key-${Date.now()}`;

      // Start first slow request and trigger its execution
      const firstReqPromise = new Promise((resolve, reject) => {
        request(server)
          .post('/tenant/slow-mutation')
          .set('Idempotency-Key', key)
          .send({ tag: 'slow' })
          .end((err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
      });

      // Wait until handler is running
      while (!delayedHandlerResolve) {
        await new Promise((r) => setTimeout(r, 10));
      }

      // Second concurrent request with same key
      const res2 = await request(server)
        .post('/tenant/slow-mutation')
        .set('Idempotency-Key', key)
        .send({ tag: 'slow' });

      expect(res2.status).toBe(409);
      expect(res2.body.success).toBe(false);
      expect(res2.body.code).toBe('request_in_progress');

      // Now complete the first request
      delayedHandlerResolve();
      const res1 = await firstReqPromise;
      expect(res1.status).toBe(200);
      expect(res1.body.slow).toBe(true);

      // Third request after resolution -> replays 200
      const res3 = await request(server)
        .post('/tenant/slow-mutation')
        .set('Idempotency-Key', key)
        .send({ tag: 'slow' });

      expect(res3.status).toBe(200);
      expect(res3.headers['x-idempotent-replay']).toBe('true');
    });
  });

  describe('4. Expiry (> 24 hours)', () => {
    test('expired idempotency record is removed and allows fresh execution', async () => {
      const key = `expired-key-${Date.now()}`;

      // Insert an expired record
      await TenantIdempotency.create({
        idempotencyKey: key,
        route: 'POST /tenant/mutations',
        requestHash: 'dummy-hash',
        status: 'RESOLVED',
        statusCode: 201,
        responseBody: { old: true },
        expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour ago
      });

      // Call route with the expired key
      const res = await request(server)
        .post('/tenant/mutations')
        .set('Idempotency-Key', key)
        .send({ fresh: true });

      expect(res.status).toBe(201);
      expect(res.body.data.fresh).toBe(true);
      expect(res.headers['x-idempotent-replay']).toBeUndefined();
      expect(handlerCallCount).toBe(1);
    });
  });

  describe('5. Platform DB Scoping', () => {
    test('platform route persists idempotency record in platform DB', async () => {
      const key = `platform-key-${Date.now()}`;

      const res1 = await request(server)
        .post('/platform/mutations')
        .set('Idempotency-Key', key)
        .send({ planId: 'p-1' });

      expect(res1.status).toBe(201);
      expect(res1.body.scope).toBe('platform');

      const record = await PlatformIdempotency.findOne({ where: { idempotencyKey: key } });
      expect(record).not.toBeNull();
      expect(record.status).toBe('RESOLVED');
      expect(record.statusCode).toBe(201);

      // Replay check
      const res2 = await request(server)
        .post('/platform/mutations')
        .set('Idempotency-Key', key)
        .send({ planId: 'p-1' });

      expect(res2.status).toBe(201);
      expect(res2.headers['x-idempotent-replay']).toBe('true');
      expect(handlerCallCount).toBe(1);
    });
  });
});
