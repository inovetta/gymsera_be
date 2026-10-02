'use strict';

/**
 * Integration test for API-01 / API-02:
 * 1. Standard success response envelope { success: true, data, meta: { timestamp, requestId, path } }
 * 2. X-Request-Id header propagation and auto-generation
 * 3. Error response envelope { success: false, error: { code, message, requestId } }
 * 4. GET /api/v1/meta/error-copy endpoint
 * 5. Request timeout middleware (API-02)
 */

const request = require('supertest');
const { startTestServer } = require('../harness/test-server');
const { setupTestDatabases, teardownTestDatabases } = require('../harness/test-db');
const { ERROR_COPY } = require('../../src/constants/error-copy');

describe('API-01 / API-02: Response Envelope, Request ID, and Error Copy', () => {
  let appServer;

  beforeAll(async () => {
    await setupTestDatabases();
    appServer = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('GET /api/v1/meta/error-copy returns 200 with canonical error copy catalog and standard envelope', async () => {
    const customReqId = 'test-req-id-12345';
    const res = await request(appServer)
      .get('/api/v1/meta/error-copy')
      .set('X-Request-Id', customReqId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(customReqId);

    // Verify envelope
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('meta');
    expect(res.body.meta.requestId).toBe(customReqId);
    expect(res.body.meta.path).toContain('/meta/error-copy');
    expect(res.body.meta.timestamp).toBeDefined();

    // Verify content matches constants
    expect(res.body.data.unauthorized).toEqual(ERROR_COPY.unauthorized);
    expect(res.body.data.forbidden).toEqual(ERROR_COPY.forbidden);
    expect(res.body.data.request_timeout).toEqual(ERROR_COPY.request_timeout);
    expect(res.body.data.duplicate_billing).toEqual(ERROR_COPY.duplicate_billing);
  });

  test('Auto-generates UUID X-Request-Id when missing and includes it in response headers and envelope', async () => {
    const res = await request(appServer).get('/api/v1/meta/error-copy');

    expect(res.status).toBe(200);
    const generatedId = res.headers['x-request-id'];
    expect(generatedId).toBeDefined();
    expect(generatedId.length).toBeGreaterThanOrEqual(16);
    expect(res.body.meta.requestId).toBe(generatedId);
  });

  test('Error response follows { success: false, error: { code, message, requestId } } envelope', async () => {
    const customReqId = 'err-test-uuid-999';
    const res = await request(appServer)
      .get('/api/v1/non-existent-endpoint-xyz')
      .set('X-Request-Id', customReqId);

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe(customReqId);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error.requestId).toBe(customReqId);
    expect(res.body.error.code).toBeDefined();
  });
});
