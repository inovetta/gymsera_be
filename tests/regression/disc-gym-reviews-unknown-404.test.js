/**
 * GET /discovery/gyms/:id/reviews for an unknown gym must be 404, not 500.
 * Root cause: the controller called listReviews(id, { page, limit, offset })
 * but the service signature is (gymListingId, branchId, opts), so opts was
 * undefined and its destructuring threw a TypeError (-> 500) for EVERY id.
 * Also checks that a real listing returns 200 with an empty list.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('discovery gym reviews: unknown gym', () => {
  let h; let personas; let server;
  beforeAll(async () => {
    h = await setupTestDatabases();
    personas = await setupPersonas(h);
    server = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const UNKNOWN = '3f2a6c1e-8b7d-4e55-9a10-0c1d2e3f4a5b';

  test('unknown gym id: detail is 404 and reviews is 404 (not 500)', async () => {
    const detail = await request(server).get(`/api/v1/discovery/gyms/${UNKNOWN}`);
    expect(detail.status).toBe(404);
    const res = await request(server).get(`/api/v1/discovery/gyms/${UNKNOWN}/reviews?page=1&limit=10`);
    expect(res.status).toBe(404);
  });

  test('existing listing: reviews is 200 with a list', async () => {
    const { GymListing } = require('../../src/models/platform');
    const listing = await GymListing.findOne({ where: { tenantId: personas.owner.tenantId } });
    const res = await request(server).get(`/api/v1/discovery/gyms/${listing.id}/reviews?page=1&limit=10`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.reviews)).toBe(true);
  });
});
