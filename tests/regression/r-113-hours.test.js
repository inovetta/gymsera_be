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
const { firstBranchInput } = require('../harness/first-branch-input');

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

  test('POST /organizations/me/branches: an invalid week is refused (422 hours_invalid with the field paths); nothing is created', async () => {
    const before = await Branch().count();
    const res = await asPersona('owner').post('/organizations/me/branches').send(branchBody({ hours: week({ all: [slot('25:99', '22:00')] }) }));
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

  test('PATCH /host/branches/:id/public-content saves the whole week (all seven days, closed days kept: NEW-270 / NEW-272)', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ openingTime: '06:00', closingTime: '22:00' }));
    const id = created.body.data.branch.id;
    const res = await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ hours: WEEKLY });
    expect(res.status).toBe(200);
    const row = await Branch().findByPk(id);
    expect(row.hoursJson.days.sat.slots).toHaveLength(2);
    expect(row.hoursJson.days.sun.closed).toBe(true);
  });

  test('hours: null clears the schedule and the pair', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    const id = created.body.data.branch.id;
    expect((await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ hours: null })).status).toBe(200);
    const row = await Branch().findByPk(id);
    expect([row.hoursJson, row.openingTime, row.closingTime]).toEqual([null, null, null]);
  });

  test('POST /host/businesses (another organisation) gives its first branch the week', async () => {
    const res = await asPersona('owner').post('/host/businesses').send({
      businessName: `R113 Org ${Date.now()}`,
      firstBranch: await firstBranchInput({ packages: [{ name: 'Monthly', price: 50 }], hours: WEEKLY }),
    });
    expect(res.status).toBe(201);
    const listingId = res.body.data.business.id;
    await require('../harness/business-proof').addProof(listingId);
    await require('../../src/services/admin.service').approveBusiness(listingId, admin.id);
    const listing = await require('../../src/models/platform').GymListing.findByPk(listingId);
    const row = await Branch().findByPk(listing.primaryBranchId);
    expect(row.hoursJson.days.sun.closed).toBe(true);
  });

  test('admin PATCH /admin/organizations/:id/branches/:branchId takes the week too', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody());
    const id = created.body.data.branch.id;
    const res = await asPersona('platformAdmin').patch(`/admin/organizations/${ctx.tenant1.id}/branches/${id}`).send({ hours: WEEKLY });
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
    const refused = await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ openingTime: '07:00', closingTime: '21:00' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('hours_schedule_newer');
    const same = await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ openingTime: '06:00', closingTime: '19:00', tagline: 'Kept' });
    expect(same.status).toBe(200);
    const row = await Branch().findByPk(id);
    expect(row.hoursJson.days.sun.closed).toBe(true);
    expect(row.tagline).toBe('Kept');
  });

  test('the admin form (old pair) cannot flatten a weekly schedule either', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours: WEEKLY }));
    const res = await asPersona('platformAdmin').patch(`/admin/organizations/${ctx.tenant1.id}/branches/${created.body.data.branch.id}`).send({ openingTime: '05:00', closingTime: '23:00' });
    expect(res.status).toBe(409);
  });

  // NEW-292 (R-116): a branch saved before R-113 with an equal pair (00:00 / 00:00) and no schedule.
  // Old forms send the pair back on every save; that must not turn every edit into a 422.
  test('a legacy equal pair sent back unchanged is a no-op on the app and the admin (CMS) form; a changed one is still checked', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody());
    const id = created.body.data.branch.id;
    await ctx.tenant1Db.sequelize.query(
      'UPDATE branches SET opening_time = \'00:00:00\', closing_time = \'00:00:00\', hours_json = NULL WHERE id = ?',
      { replacements: [id] }
    );

    const app = await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ openingTime: '00:00', closingTime: '00:00', tagline: 'Kept' });
    expect(app.status).toBe(200);
    const cms = await asPersona('platformAdmin').patch(`/admin/organizations/${ctx.tenant1.id}/branches/${id}`).send({ branchName: 'Renamed by admin', openingTime: '00:00', closingTime: '00:00' });
    expect(cms.status).toBe(200);
    const row = await Branch().findByPk(id);
    expect(row.tagline).toBe('Kept');
    expect(row.branchName).toBe('Renamed by admin');
    expect(row.hoursJson).toBeNull();
    expect([row.openingTime, row.closingTime]).toEqual(['00:00', '00:00']);

    const changed = await asPersona('owner').patch(`/host/branches/${id}/public-content`).send({ openingTime: '05:00', closingTime: '05:00' });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('hours_invalid');
  });
});

describe('H6: every branch object reads the schedule', () => {
  beforeAll(async () => {
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    await ctx.tenant1Db.models.MembershipPlan.create({
      businessId: ctx.branch1.businessId, branchId: ctx.branch1.id, name: 'R113 Monthly', price: '3000.00',
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
    const res = await asPersona('member').get(`/discovery/branches/${ctx.branch1.id}`);
    expect(res.status).toBe(200);
    const b = [res.body.data.branch].find((x) => x.id === ctx.branch1.id);
    for (const f of H6_FIELDS) expect(b).toHaveProperty(f);
    expect(b.openingTime).toBe('06:00');
  });

  test('the traveller list items', async () => {
    const res = await asPersona('member').get('/discovery/branches?page=1&limit=50');
    const item = res.body.data.branches.find((g) => g.id === ctx.branch1.id);
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

  test('first-business checks firstBranch.hours and stores its summary pair', async () => {
    const { tenant, as } = await draftHost();
    const bad = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: 'R113 Brand', firstBusinessName: 'Gym', firstBranch: await firstBranchInput({ hours: week({ all: [slot('08:00', '08:00')] }) }) });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('hours_invalid');
    const ok = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: 'R113 Brand', firstBusinessName: 'Gym', firstBranch: await firstBranchInput({ hours: WEEKLY }) });
    expect(ok.status).toBe(200);
    await tenant.reload();
    expect(tenant.firstBranchDraft.hoursJson.days.mon.slots.map((s) => s.open)).toEqual(['06:00', '16:00']);
    expect([tenant.firstBranchDraft.openingTime, tenant.firstBranchDraft.closingTime]).toEqual(['06:00', '19:00']);
  });

  test('approval gives the first branch the week', async () => {
    const organizationCode = `test_r113_${Date.now().toString(36)}`;
    dbNames.push(`gymsera_${organizationCode}`);
    const tenant = await factories.createTenant({
      organizationCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER', cityId: 1,
      firstBranchDraft: { name: 'Main', cityId: 1, plans: [{ name: 'Monthly', price: 3000 }], hoursJson: WEEKLY, openingTime: '06:00', closingTime: '19:00' },
    });
    await require('../../src/services/admin.service').approveTenant(tenant.id, admin.id);
    await require('../harness/business-proof').approveFirstBusiness(tenant.id, admin.id); // M2d
    await tenant.reload();
    const db = await require('../../src/database/TenantDbManager').getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await db.models.Branch.findOne();
    expect(branch.hoursJson.days.sun.closed).toBe(true);
    expect([branch.openingTime, branch.closingTime]).toEqual(['06:00', '19:00']);
  });

  describe('H7 filter (audience=women|men)', () => {
    const { matchesAudience } = require('../../src/services/branch-hours.service');

    test('matchesAudience rules', () => {
      const mixedAll = {
        genderType: 'MIXED',
        hours: { days: { mon: { closed: false, slots: [{ open: '08:00', close: '22:00', for: 'all' }] } } },
      };
      const mixedWithWomen = {
        genderType: 'MIXED',
        hours: { days: { mon: { closed: false, slots: [{ open: '10:00', close: '12:00', for: 'women' }] } } },
      };
      const mixedWithMen = {
        genderType: 'MIXED',
        hours: { days: { mon: { closed: false, slots: [{ open: '14:00', close: '16:00', for: 'men' }] } } },
      };
      const femaleOnly = { genderType: 'FEMALE_ONLY', hours: mixedAll.hours };
      const maleOnly = { genderType: 'MALE_ONLY', hours: mixedAll.hours };

      // audience=women
      expect(matchesAudience(femaleOnly, 'women')).toBe(true);
      expect(matchesAudience(mixedWithWomen, 'women')).toBe(true);
      expect(matchesAudience(mixedAll, 'women')).toBe(false);
      expect(matchesAudience(maleOnly, 'women')).toBe(false);

      // audience=men
      expect(matchesAudience(maleOnly, 'men')).toBe(true);
      expect(matchesAudience(mixedWithMen, 'men')).toBe(true);
      expect(matchesAudience(mixedAll, 'men')).toBe(false);
      expect(matchesAudience(femaleOnly, 'men')).toBe(false);

      // no audience filter
      expect(matchesAudience(mixedAll, null)).toBe(true);
    });

    test('GET /discovery/gyms rejects invalid audience with 422', async () => {
      const res = await asPersona('anonymous').get('/discovery/branches?audience=other');
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('audience must be women or men');
    });

  });
});

// NEW-293 (R-116): the H7 route tests used to check the status code only (200), so a filter that
// returned everything, or nothing, passed. These check which gyms come back.
describe('H7: what audience=women|men keeps, on list, nearby and map', () => {
  const ids = {};
  // A spot of our own, so nearby (small radius) sees only these three branches.
  const LAT = 10.1234;
  const LNG = 20.5678;
  const live = async (name, hours, dLng) => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody({ hours }));
    expect(created.status).toBe(201);
    const id = created.body.data.branch.id;
    await Branch().update({ latitude: LAT, longitude: LNG + dLng, cityId: 1 }, { where: { id } });
    await makeBranchLive(ctx.tenant1Db, id);
    ids[name] = id;
  };

  beforeAll(async () => {
    await live('women', week({ all: [slot('06:00', '11:00'), slot('16:00', '19:00', 'women')] }), 0.001);
    await live('men', week({ all: [slot('06:00', '11:00'), slot('20:00', '22:00', 'men')], sun: null }), 0.002);
    await live('allOnly', week({ all: [slot('06:00', '22:00')] }), 0.003);
  });
  beforeEach(() => cache._resetForTests());

  const ours = (items) => Object.keys(ids).filter((k) => items.some((g) => g.id === ids[k])).sort();
  const routes = {
    list: (q) => `/discovery/branches?page=1&limit=50${q}`,
    nearby: (q) => `/discovery/branches/nearby?lat=${LAT}&lng=${LNG}&radius=5&limit=50${q}`,
    map: (q) => `/discovery/branches/map?cityId=1${q}`,
  };

  test.each(Object.keys(routes))('%s: women keeps the branch with a women slot only; men the one with a men slot; none keeps all three', async (route) => {
    const get = async (q) => {
      const res = await asPersona('anonymous').get(routes[route](q));
      expect(res.status).toBe(200);
      return ours(res.body.data.branches);
    };
    expect(await get('')).toEqual(['allOnly', 'men', 'women']);
    expect(await get('&audience=women')).toEqual(['women']);
    expect(await get('&audience=men')).toEqual(['men']);
  });
});

// R-116 item 4: the owner runs src/scripts/r113-hours-precheck.js on the server (read-only).
describe('r113-hours-precheck (read-only counts for the owner)', () => {
  test('counts the equal pairs per tenant database and prints no credentials', async () => {
    const created = await asPersona('owner').post('/host/branches').send(branchBody());
    await ctx.tenant1Db.sequelize.query(
      'UPDATE branches SET opening_time = \'00:00:00\', closing_time = \'00:00:00\', hours_json = NULL WHERE id = ?',
      { replacements: [created.body.data.branch.id] }
    );
    const { precheck, report } = require('../../src/scripts/r113-hours-precheck');
    const result = await precheck();
    const mine = result.tenants.find((t) => t.organizationCode === ctx.tenant1.organizationCode);
    expect(mine).toBeDefined();
    expect(mine.error).toBeUndefined();
    expect(mine.hoursJsonColumn).toBe(true);
    expect(mine.equalPairs).toBeGreaterThanOrEqual(1);
    expect(mine.equalPairsNoSchedule).toBeGreaterThanOrEqual(1);
    expect(result.migratableTenants).toBeGreaterThanOrEqual(1);

    let out = '';
    report(result, (s) => { out += s; });
    expect(out).toContain(`${ctx.tenant1.organizationCode} (`);
    expect(out).not.toMatch(/mysql:\/\/|password|127\.0\.0\.1|localhost/i);
    const before = await Branch().count();
    await precheck();
    expect(await Branch().count()).toBe(before);
  });
});
