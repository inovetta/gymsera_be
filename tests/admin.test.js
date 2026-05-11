/**
 * Module: Platform Admin
 * Role: PLATFORM_ADMIN (admin@gymsera.com)
 * Tests: tenant CRUD, package management, user management, reviews moderation, reports
 */
const { api, authed, loginAs } = require('./helpers');

let adminToken, tenants, reviewId;

beforeAll(async () => {
  const session = await loginAs('admin@gymsera.com', 'Admin@1234!');
  adminToken = session.accessToken;
});

describe('Admin — Tenant Management', () => {
  test('GET /admin/tenants — list all tenants (200)', async () => {
    const res = await authed(adminToken).get('/admin/tenants');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('tenants');
    tenants = res.data.data.tenants;
    expect(tenants.length).toBeGreaterThan(0);
  });

  test('GET /admin/tenants/:id — detail of first tenant (200)', async () => {
    if (!tenants || tenants.length === 0) return;
    const res = await authed(adminToken).get(`/admin/tenants/${tenants[0].id}`);
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('tenant');
    expect(res.data.data.tenant).toHaveProperty('id');
  });

  test('GET /admin/tenants/:id — nonexistent (404)', async () => {
    const res = await authed(adminToken).get('/admin/tenants/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('POST /admin/tenants/:id/approve — already approved returns 400 or success', async () => {
    if (!tenants || tenants.length === 0) return;
    const activeTenant = tenants.find((t) => t.status === 'ACTIVE');
    if (!activeTenant) return;
    const res = await authed(adminToken).post(`/admin/tenants/${activeTenant.id}/approve`);
    expect([200, 400]).toContain(res.status);
  });
});

describe('Admin — Platform Packages', () => {
  test('GET /platform-packages — list packages (200)', async () => {
    const res = await authed(adminToken).get('/platform-packages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data.length).toBeGreaterThan(0);
    const pkg = res.data.data[0];
    expect(pkg).toHaveProperty('name');
    expect(pkg).toHaveProperty('price');
  });
});

describe('Admin — User Management', () => {
  test('GET /users — list all users (200)', async () => {
    const res = await authed(adminToken).get('/users');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('users');
    expect(res.data.data.users.length).toBeGreaterThan(0);
  });

  test('GET /users — search by email (200)', async () => {
    const res = await authed(adminToken).get('/users?search=admin@gymsera.com');
    expect(res.status).toBe(200);
    expect(res.data.data.users.length).toBeGreaterThan(0);
  });

  test('GET /users — pagination (200)', async () => {
    const res = await authed(adminToken).get('/users?page=1&limit=3');
    expect(res.status).toBe(200);
    expect(res.data.data.users.length).toBeLessThanOrEqual(3);
  });
});

describe('Admin — Reviews Moderation', () => {
  test('GET /admin/reviews — list pending reviews (200)', async () => {
    const res = await authed(adminToken).get('/admin/reviews');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('reviews');
    // grab a pending review if any
    const pending = res.data.data.reviews.find((r) => r.status === 'PENDING');
    if (pending) reviewId = pending.id;
  });

  test('POST /admin/reviews/:id/moderate — approve (200)', async () => {
    if (!reviewId) {
      console.log('No pending review to moderate — skipping');
      return;
    }
    const res = await authed(adminToken).post(`/admin/reviews/${reviewId}/moderate`, {
      action: 'approve',
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  test('POST /admin/reviews/:id/moderate — missing action (422)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000001';
    const res = await authed(adminToken).post(`/admin/reviews/${fakeId}/moderate`, {});
    expect([400, 404, 422]).toContain(res.status);
  });
});

describe('Admin — Platform Reports', () => {
  test('GET /admin/reports/platform — summary (200)', async () => {
    const res = await authed(adminToken).get('/admin/reports/platform');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('gyms');
    expect(res.data.data).toHaveProperty('members');
  });
});

describe('Admin — Auth Guard', () => {
  test('GET /admin/tenants — unauthenticated (401)', async () => {
    const res = await api.get('/admin/tenants');
    expect(res.status).toBe(401);
  });

  test('GET /admin/tenants — non-admin role (403)', async () => {
    const session = await loginAs('ali.hassan@example.com', 'Member@1234!');
    const res = await authed(session.accessToken).get('/admin/tenants');
    expect(res.status).toBe(403);
  });
});
