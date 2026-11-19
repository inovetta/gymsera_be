/**
 * R-113 (owner 2026-11-18, build 27): opening hours as a weekly schedule. The routes.
 * Contract: spec §13 "R-113 API contract, revision 1": H4 writes, H5 old clients, H6 reads.
 * The rules themselves: r-113-hours-rules.test.js. Migration 029: r-113-migration-029.test.js.
 *
 * Before: one opening_time / closing_time pair per branch, the same every day; the app's Edit hours
 * saved Monday only (NEW-270), and no route took a weekly schedule.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { makeBranchLive } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const cache = require('../../src/services/discovery-cache.service');
const subscriptionQuotaService = require('../../src/services/subscription-quota.service');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const slot = (open, close, forWho = 'all') => ({ open, close, for: forWho });
const week = (perDay) => ({
  v: 1,
  days: Object.fromEntries(DAYS.map((d) => {
    const slots = perDay[d] !== undefined ? perDay[d] : perDay.all;
    return [d, slots ? { closed: false, slots } : { closed: true, slots: [] }];
  })),
});
const WEEKLY = week({ all: [slot('16:00', '19:00', 'women'), slot('06:00', '11:00')], sun: null });
const H6_FIELDS = ['hours', 'timezone', 'utcOffsetMinutes', 'hoursToday', 'openNow', 'openNowFor', 'nextChange'];

let ctx;
let admin;
const dbNames = [];
let seq = 0;
const branchBody = (extra = {}) => ({ branchName: `R113 Branch ${Date.now()}-${(seq += 1)}`, address: 'Street', packages: [{ name: 'Monthly', price: 50 }], ...extra });
const Branch = () => ctx.tenant1Db.models.Branch;

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ctx = personaManager.context;
  admin = personaManager.personas.platformAdmin.user;
  const sub = await subscriptionQuotaService.getActiveSubscription(ctx.tenant1.id);
  if (sub) await sub.update({ branchCount: 50, overQuotaCount: 0 });
  else await factories.createTenantSubscription(ctx.tenant1.id, { branchCount: 50, overQuotaCount: 0 });
});
afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await stopTestServer();
  await teardownTestDatabases();
});

describe('H4: the writes that take a weekly schedule', () => {
  test('POST /host/branches stores the week (sorted) and its summary pair; the answer carries the H6 fields', async () => {
    const res = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    expect(res.status).toBe(201);
    const row = await Branch().findByPk(res.body.data.branch.id);
    expect(row.hoursJson.days.mon.slots.map((s) => s.open)).toEqual(['06:00', '16:00']);
    expect(row.hoursJson.days.sun).toEqual({ closed: true, slots: [] });
    expect([row.openingTime, row.closingTime]).toEqual(['06:00', '19:00']);
    for (const f of H6_FIELDS) expect(res.body.data.branch).toHaveProperty(f);
    expect(res.body.data.branch.timezone).toBe('Asia/Karachi');
  });

  test('POST /gyms/branches: an invalid week is refused (422 hours_invalid with the field paths); nothing is created', async () => {
    const before = await Branch().count();
    const res = await asPersona('owner').post('/gyms/branches').send(branchBody({ hours: week({ all: [slot('25:99', '22:00')] }) }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('hours_invalid');
    expect(JSON.stringify(res.body)).toContain('days.mon.slots[0].open');
    expect(await Branch().count()).toBe(before);
  });

  test('the week together with the old pair is refused', async () => {
    const res = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY, openingTime: '06:00' }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('hours_invalid');
  });

  test('PATCH /host/branches/:id/listing-content saves the whole week (all seven days, closed days kept: NEW-270 / NEW-272)', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ openingTime: '06:00', closingTime: '22:00' }));
    const id = created.body.data.branch.id;
    const res = await asPersona('owner').patch(`/host/branches/${id}/listing-content`).send({ hours: WEEKLY });
    expect(res.status).toBe(200);
    const row = await Branch().findByPk(id);
    expect(row.hoursJson.days.sat.slots).toHaveLength(2);
    expect(row.hoursJson.days.sun.closed).toBe(true);
  });

  test('hours: null clears the schedule and the pair', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    const id = created.body.data.branch.id;
    expect((await asPersona('owner').patch(`/host/branches/${id}/listing-content`).send({ hours: null })).status).toBe(200);
    const row = await Branch().findByPk(id);
    expect([row.hoursJson, row.openingTime, row.closingTime]).toEqual([null, null, null]);
  });

  test('POST /host/listings (another organisation) gives its first branch the week', async () => {
    const res = await asPersona('owner').post('/host/listings').send({
      gymName: `R113 Org ${Date.now()}`, packages: [{ name: 'Monthly', price: 50 }], hours: WEEKLY,
    });
    expect(res.status).toBe(201);
    const row = await Branch().findByPk(res.body.data.branch.id);
    expect(row.hoursJson.days.sun.closed).toBe(true);
  });

  test('admin PATCH /admin/tenants/:id/branches/:branchId takes the week too', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody());
    const id = created.body.data.branch.id;
    const res = await asPersona('platformAdmin').patch(`/admin/tenants/${ctx.tenant1.id}/branches/${id}`).send({ hours: WEEKLY });
    expect(res.status).toBe(200);
    expect((await Branch().findByPk(id)).hoursJson.days.sun.closed).toBe(true);
  });
});

describe('H5: old clients (builds up to 26, the CMS, the website) keep working', () => {
  test('the old pair on a branch with no schedule: stored as a uniform week plus the pair, read as HH:MM', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ openingTime: '06:00', closingTime: '22:00' }));
    const row = await Branch().findByPk(created.body.data.branch.id);
    expect(row.hoursJson).toEqual(week({ all: [slot('06:00', '22:00')] }));
    expect(created.body.data.branch.openingTime).toBe('06:00');
  });

  test('a real time is required: 25:99 in the old pair is refused now (NEW-273 rule part)', async () => {
    const res = await asPersona('owner').post('/host/branches').send(branchBody({ openingTime: '25:99', closingTime: '22:00' }));
    expect(res.status).toBe(422);
  });

  test('the old pair on a weekly schedule: 409 hours_schedule_newer, nothing changed; the same pair sent back is fine', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    const id = created.body.data.branch.id;
    const refused = await asPersona('owner').patch(`/host/branches/${id}/listing-content`).send({ openingTime: '07:00', closingTime: '21:00' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hours_schedule_newer');
    const same = await asPersona('owner').patch(`/host/branches/${id}/listing-content`).send({ openingTime: '06:00', closingTime: '19:00', tagline: 'Kept' });
    expect(same.status).toBe(200);
    const row = await Branch().findByPk(id);
    expect(row.hoursJson.days.sun.closed).toBe(true);
    expect(row.tagline).toBe('Kept');
  });

  test('the admin form (old pair) cannot flatten a weekly schedule either', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    const res = await asPersona('platformAdmin').patch(`/admin/tenants/${ctx.tenant1.id}/branches/${created.body.data.branch.id}`).send({ openingTime: '05:00', closingTime: '23:00' });
    expect(res.status).toBe(409);
  });
});

describe('H6: every branch object reads the schedule', () => {
  beforeAll(async () => {
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'R113 Monthly', price: '3000.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    await Branch().update({ hoursJson: WEEKLY, openingTime: '06:00', closingTime: '19:00' }, { where: { id: ctx.branch1.id } });
  });
  beforeEach(() => cache._resetForTests());

  test('GET /host/branches', async () => {
    const res = await asPersona('owner').get('/host/branches');
    const b = (Array.isArray(res.body.data) ? res.body.data : res.body.data.branches).find((x) => x.id === ctx.branch1.id);
    for (const f of H6_FIELDS) expect(b).toHaveProperty(f);
    expect(b.hours.days.sun.closed).toBe(true);
    expect(typeof b.openNow).toBe('boolean');
  });

  test('the gym detail\'s branches', async () => {
    const res = await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}`);
    expect(res.status).toBe(200);
    const b = res.body.data.gym.branches.find((x) => x.id === ctx.branch1.id);
    for (const f of H6_FIELDS) expect(b).toHaveProperty(f);
    expect(b.openingTime).toBe('06:00');
  });

  test('the traveller list items', async () => {
    const res = await asPersona('member').get('/discovery/gyms?page=1&limit=50');
    const item = res.body.data.gyms.find((g) => g.id === ctx.branch1.id);
    expect(item).toBeDefined();
    for (const f of ['hoursToday', 'openNow', 'openNowFor', 'nextChange', 'timezone']) expect(item).toHaveProperty(f);
  });

  test('a branch with only the old pair reads it as every day, one slot for everyone', async () => {
    await Branch().update({ hoursJson: null, openingTime: '06:00', closingTime: '22:00' }, { where: { id: ctx.branch1.id } });
    const res = await asPersona('owner').get('/host/branches');
    const b = (Array.isArray(res.body.data) ? res.body.data : res.body.data.branches).find((x) => x.id === ctx.branch1.id);
    expect(b.hours).toEqual(week({ all: [slot('06:00', '22:00')] }));
    await Branch().update({ hoursJson: WEEKLY, openingTime: '06:00', closingTime: '19:00' }, { where: { id: ctx.branch1.id } });
  });
});

describe('H4: Become a Host keeps the week and approval copies it', () => {
  const draftHost = async () => {
    const user = await factories.createUser({ email: `r113-${Date.now()}@r113.test`, role: 'GYM_HOST', isHost: true });
    const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
    const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
    return { tenant, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
  };

  test('gym-profile checks mainBranchData.hoursJson and stores it with its summary pair', async () => {
    const { tenant, as } = await draftHost();
    const bad = await as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { hoursJson: week({ all: [slot('08:00', '08:00')] }) } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('hours_invalid');
    const ok = await as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { hoursJson: WEEKLY } });
    expect(ok.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson.hoursJson.days.mon.slots.map((s) => s.open)).toEqual(['06:00', '16:00']);
    expect([tenant.mainBranchDataJson.openingTime, tenant.mainBranchDataJson.closingTime]).toEqual(['06:00', '19:00']);
  });

  test('approval gives the first branch the week', async () => {
    const tenantCode = `test_r113_${Date.now().toString(36)}`;
    dbNames.push(`gymsera_${tenantCode}`);
    const tenant = await factories.createTenant({
      tenantCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER', cityId: 1,
      mainBranchDataJson: { name: 'Main', cityId: 1, plans: [{ name: 'Monthly', price: 3000 }], hoursJson: WEEKLY, openingTime: '06:00', closingTime: '19:00' },
    });
    await require('../../src/services/admin.service').approveTenant(tenant.id, admin.id);
    await tenant.reload();
    const db = await require('../../src/database/TenantDbManager').getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await db.models.Branch.findOne();
    expect(branch.hoursJson.days.sun.closed).toBe(true);
    expect([branch.openingTime, branch.closingTime]).toEqual(['06:00', '19:00']);
  });
});
