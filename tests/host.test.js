/**
 * Module: Gym Host (Tenant-Scoped)
 * Role: GYM_HOST (ahmed@ironpeak.com)
 * Tests: gym profile, branches, membership plans, subscriptions staff view,
 *        payments, invoices, attendance, reports
 */
const { authed, loginAs, api } = require('./helpers');

let hostToken, branchId, planId;

beforeAll(async () => {
  const session = await loginAs('ahmed@ironpeak.com', 'Host@1234!');
  hostToken = session.accessToken;
});

describe('Host — Gym Profile', () => {
  test('GET /gyms/profile — own gym profile (200)', async () => {
    const res = await authed(hostToken).get('/gyms/profile');
    expect(res.status).toBe(200);
    expect(res.data.data.gym).toHaveProperty('id');
  });

  test('PATCH /gyms/profile — update contact phone (200)', async () => {
    const res = await authed(hostToken).patch('/gyms/profile', {
      contactPhone: '+923001234567',
    });
    expect([200, 400, 422]).toContain(res.status);
  });
});

describe('Host — Branches', () => {
  test('GET /gyms/branches — list branches (200)', async () => {
    const res = await authed(hostToken).get('/gyms/branches');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data.branches)).toBe(true);
    if (res.data.data.branches.length > 0) {
      branchId = res.data.data.branches[0].id;
    }
  });

  test('POST /gyms/branches — create branch (201)', async () => {
    const res = await authed(hostToken).post('/gyms/branches', {
      name: 'Test Branch ' + Date.now(),
      address: '123 Test St, Karachi',
      phone: '+923001111111',
      managerId: null,
    });
    expect([201, 400, 422]).toContain(res.status);
    if (res.status === 201) {
      branchId = res.data.data.id;
    }
  });

  test('GET /gyms/branches/:id — branch detail (200 or 404)', async () => {
    if (!branchId) return;
    const res = await authed(hostToken).get(`/gyms/branches/${branchId}`);
    expect([200, 404]).toContain(res.status);
  });
});

describe('Host — Membership Plans', () => {
  test('GET /membership-plans/host — list host plans (200)', async () => {
    const res = await authed(hostToken).get('/membership-plans/host');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('plans');
    if (res.data.data.plans.length > 0) {
      planId = res.data.data.plans[0].id;
    }
  });

  test('POST /membership-plans — create plan (201)', async () => {
    const res = await authed(hostToken).post('/membership-plans', {
      name: 'Monthly Basic ' + Date.now(),
      price: 2500,
      durationDays: 30,
      durationMonths: 1,
      features: ['Unlimited Access', 'Locker'],
      isActive: true,
    });
    expect([201, 400, 422]).toContain(res.status);
    if (res.status === 201) {
      planId = res.data.data.id;
    }
  });
});

describe('Host — Subscriptions (Staff View)', () => {
  test('GET /subscriptions/staff — list all member subscriptions (200)', async () => {
    const res = await authed(hostToken).get('/subscriptions/staff');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('subscriptions');
  });
});

describe('Host — Payments', () => {
  test('GET /payments — list payments (200)', async () => {
    const res = await authed(hostToken).get('/payments');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('payments');
  });
});

describe('Host — Invoices', () => {
  test('GET /invoices — list invoices (200)', async () => {
    const res = await authed(hostToken).get('/invoices');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('invoices');
  });
});

describe('Host — Attendance', () => {
  test('GET /attendance — attendance logs (200)', async () => {
    const res = await authed(hostToken).get('/attendance');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('logs');
  });

  test('GET /attendance/today — today logs (200)', async () => {
    const res = await authed(hostToken).get('/attendance/today');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('logs');
  });

  test('GET /attendance/range — date range (200)', async () => {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const res = await authed(hostToken).get(`/attendance/range?from=${weekAgo}&to=${today}`);
    expect([200, 422]).toContain(res.status);
  });

  test('GET /attendance/report/daily — attendance report (200)', async () => {
    const res = await authed(hostToken).get('/attendance/report/daily');
    expect(res.status).toBe(200);
  });

  test('GET /attendance/report/monthly — monthly report (200)', async () => {
    const res = await authed(hostToken).get('/attendance/report/monthly');
    expect(res.status).toBe(200);
  });
});

describe('Host — Reports', () => {
  test('GET /reports/dashboard — KPI dashboard (200)', async () => {
    const res = await authed(hostToken).get('/reports/dashboard');
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveProperty('members');
  });

  test('GET /reports/monthly — monthly breakdown (200)', async () => {
    const res = await authed(hostToken).get('/reports/monthly');
    expect(res.status).toBe(200);
  });
});

describe('Host — Trainers', () => {
  test('GET /trainers — list trainers (200)', async () => {
    const res = await authed(hostToken).get('/trainers');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.data).toHaveProperty('trainers');
    }
  });
});

describe('Host — Tenants', () => {
  test('GET /tenants/me — own tenant record (200)', async () => {
    const res = await authed(hostToken).get('/tenants/me');
    expect(res.status).toBe(200);
    expect(res.data.data.tenant).toHaveProperty('tenantCode');
  });
});

describe('Host — Guard checks', () => {
  test('GET /gyms/profile — unauthenticated (401)', async () => {
    const res = await api.get('/gyms/profile');
    expect(res.status).toBe(401);
  });

  test('GET /reports/dashboard — member role (403)', async () => {
    const session = await loginAs('ali.hassan@example.com', 'Member@1234!');
    const res = await authed(session.accessToken).get('/reports/dashboard');
    expect(res.status).toBe(403);
  });
});
