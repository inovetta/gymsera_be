/**
 * Module: Public Discovery APIs
 * Tests: cities, gyms listing, featured, top-rated, nearby, map, gym detail, reviews
 */
const { api, authed, loginAs } = require('./helpers');

let gymId;

describe('Discovery — Cities', () => {
  test('GET /discovery/cities — returns cities list (200)', async () => {
    const res = await api.get('/discovery/cities');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('cities');
    expect(Array.isArray(res.data.data.cities)).toBe(true);
    expect(res.data.data.cities.length).toBeGreaterThan(0);
    const city = res.data.data.cities[0];
    expect(city).toHaveProperty('id');
    expect(city).toHaveProperty('name');
  });
});

describe('Discovery — Gym Listings', () => {
  test('GET /discovery/gyms — returns gyms list (200)', async () => {
    const res = await api.get('/discovery/gyms');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(Array.isArray(res.data.data.gyms)).toBe(true);
    if (res.data.data.gyms.length > 0) {
      gymId = res.data.data.gyms[0].id;
    }
  });

  test('GET /discovery/gyms — filter by city name (200)', async () => {
    const res = await api.get('/discovery/gyms?city=Karachi');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
  });

  test('GET /discovery/gyms — paginate page 1 (200)', async () => {
    const res = await api.get('/discovery/gyms?page=1&limit=5');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
  });

  test('GET /discovery/gyms/featured — returns list (200)', async () => {
    const res = await api.get('/discovery/gyms/featured');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(Array.isArray(res.data.data.gyms)).toBe(true);
  });

  test('GET /discovery/gyms/top-rated — returns list (200)', async () => {
    const res = await api.get('/discovery/gyms/top-rated');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(Array.isArray(res.data.data.gyms)).toBe(true);
  });

  test('GET /discovery/gyms/nearby — Karachi coords (200)', async () => {
    const res = await api.get('/discovery/gyms/nearby?lat=24.8615&lng=67.0099&radius=20');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(Array.isArray(res.data.data.gyms)).toBe(true);
  });

  test('GET /discovery/gyms/nearby — missing lat/lng (422)', async () => {
    const res = await api.get('/discovery/gyms/nearby');
    expect(res.status).toBe(422);
  });

  test('GET /discovery/gyms/map — cityId param (200)', async () => {
    const citiesRes = await api.get('/discovery/cities');
    const cityId = citiesRes.data.data.cities[0].id;
    const res = await api.get('/discovery/gyms/map?cityId=' + cityId);
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(Array.isArray(res.data.data.gyms)).toBe(true);
  });
});

describe('Discovery — Gym Detail & Reviews', () => {
  test('GET /discovery/gyms/:id — valid gym (200)', async () => {
    if (!gymId) return;
    const res = await api.get('/discovery/gyms/' + gymId);
    expect(res.status).toBe(200);
    expect(res.data.data.gym).toHaveProperty('id');
  });

  test('GET /discovery/gyms/:id — invalid UUID (422)', async () => {
    const res = await api.get('/discovery/gyms/not-a-valid-id');
    expect([400, 422]).toContain(res.status);
  });

  test('GET /discovery/gyms/:id — nonexistent valid UUID (404 or 422)', async () => {
    const res = await api.get('/discovery/gyms/00000000-0000-0000-0000-000000000000');
    expect([404, 422]).toContain(res.status);
  });

  test('GET /discovery/gyms/:id/reviews — public list (200)', async () => {
    if (!gymId) return;
    const res = await api.get('/discovery/gyms/' + gymId + '/reviews');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('reviews');
    expect(Array.isArray(res.data.data.reviews)).toBe(true);
  });

  test('POST /discovery/gyms/:id/reviews — unauthenticated (401)', async () => {
    if (!gymId) return;
    const res = await api.post('/discovery/gyms/' + gymId + '/reviews', {
      rating: 5, title: 'Great!', body: 'Loved it.',
    });
    expect(res.status).toBe(401);
  });

  test('POST /discovery/gyms/:id/reviews — authenticated member (201 or 400/409)', async () => {
    if (!gymId) return;
    const session = await loginAs('ali.hassan@example.com', 'Member@1234!');
    const res = await authed(session.accessToken).post('/discovery/gyms/' + gymId + '/reviews', {
      rating: 5,
      title: 'Excellent gym!',
      body: 'Really love the equipment and the trainers here.',
    });
    expect([201, 400, 403, 409]).toContain(res.status);
  });
});
