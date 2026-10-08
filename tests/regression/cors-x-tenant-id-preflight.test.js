'use strict';

/**
 * Regression test for the CORS preflight rejecting X-Tenant-Id.
 *
 * The CMS sends X-Tenant-Id on every request (gymsera_cms src/lib/api/client.ts:20).
 * app.js answered the preflight with a header list that did not include it, so
 * the browser blocked every CMS call. Every custom header a client sends must be
 * allowed, and an unknown origin must still get no CORS headers at all.
 */

const request = require('supertest');
const { startTestServer, stopTestServer } = require('../harness/test-server');

const preflight = (app, origin, headers) =>
  request(app)
    .options('/api/v1/auth/login')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headers);

const CLIENT_HEADERS = [
  'x-tenant-id',
  'idempotency-key',
  'x-api-version',
  'x-request-id',
  'x-skip-timeout',
  'authorization',
  'content-type',
];

describe('CORS preflight: custom client headers', () => {
  let app;
  beforeAll(async () => { app = await startTestServer(); });
  afterAll(stopTestServer);

  const allowed = (res) =>
    String(res.headers['access-control-allow-headers'] || '')
      .toLowerCase().split(',').map((h) => h.trim());

  it('allows X-Tenant-Id from the CMS origin', async () => {
    const res = await preflight(app, 'https://cms.gymsera.com', 'x-tenant-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://cms.gymsera.com');
    expect(allowed(res)).toContain('x-tenant-id');
  });

  it.each(CLIENT_HEADERS)('allows %s', async (header) => {
    const res = await preflight(app, 'https://cms.gymsera.com', header);
    expect(allowed(res)).toContain(header);
  });

  it('allows all client headers in one preflight', async () => {
    const res = await preflight(app, 'https://cms.gymsera.com', CLIENT_HEADERS.join(', '));
    CLIENT_HEADERS.forEach((h) => expect(allowed(res)).toContain(h));
  });

  it('gives an unknown origin no CORS headers', async () => {
    const res = await preflight(app, 'https://evil.example.com', 'x-tenant-id');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
