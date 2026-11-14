/**
 * NEW-250: staff Cancel and Freeze on a member's subscription answered 404 "Subscription not found"
 * in the CMS (Subscriptions › Subscription Detail) and in the app (Gyms & Operations › Subscriptions).
 *
 * Cause: both clients sent staff to the MEMBER routes POST /subscriptions/:id/cancel|freeze. Since
 * NEW-08 those resolve the subscription through the platform index filtered by the CALLER's user id
 * (subscription.service.js _resolveBySubscriptionId), so for a host or desk user the lookup is always
 * empty. Fix: POST /subscriptions/staff/:id/cancel|freeze, from the caller's own tenant database,
 * through the approval commands subscriptions.cancel / subscriptions.pause (R-102).
 *
 * Verifies: success (rules of the member route: freeze moves the end date by the frozen days, cancel
 * at once; platform index follows), wrong id, other tenant, a branch the caller cannot see, already
 * cancelled, not ACTIVE for freeze, plan freeze limit, duplicate request (sequential and at the same
 * time), REQUEST tier (desk) queues an approval request and changes nothing, device sync queued on
 * cancel, the old member routes still answer 404 for staff and still work for the member.
 */
const request = require('supertest');
const { QueryTypes } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { daysFromToday } = require('../harness/dates');
const { UserGymMembership, GymListing } = require('../../src/models/platform');
const registry = require('../../src/services/devices/device-registry.service');
const triggers = require('../../src/services/devices/device-triggers');

let app;
let personas;
let ctx;
let db1;
let plan;
let noFreezePlan;
let tenant2Plan;
let otherBranch;
let seq = 0;

const T1 = () => personas.owner.tenantId;

const makeSub = async ({ status = 'ACTIVE', planRow = plan, branch = ctx.branch1, db = db1, tenantId = T1(), user = null } = {}) => {
  const member = user || await factories.createUser({ email: `n250-${++seq}@new250.test`, fullName: `N250 Member ${seq}`, role: 'MEMBER' });
  const sub = await db.models.MemberSubscription.create({
    userId: member.id,
    membershipPlanId: planRow.id,
    branchId: branch.id,
    status,
    startDate: daysFromToday(-1),
    endDate: daysFromToday(29),
  });
  const listing = await GymListing.findOne({ where: { tenantId } });
  await UserGymMembership.create({
    userId: member.id, tenantId, gymListingId: listing.id, subscriptionId: sub.id,
    gymName: listing.title, planName: planRow.name, startDate: sub.startDate, endDate: sub.endDate, status,
  });
  return { sub, member };
};

const staff = (persona, path, body = {}, tenantId = T1()) =>
  request(app).post(`/api/v1/subscriptions/staff/${path}`)
    .set('Authorization', `Bearer ${persona.token}`)
    .set('X-Tenant-Id', tenantId)
    .send(body);

const freezeBody = () => ({ freezeFrom: daysFromToday(1), freezeTo: daysFromToday(8) });
const reload = (sub) => sub.reload();
const indexOf = (sub) => UserGymMembership.findOne({ where: { subscriptionId: sub.id } });

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  ctx = personaManager.context;
  db1 = ctx.tenant1Db;
  app = await startTestServer();

  plan = await db1.models.MembershipPlan.create({
    gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'Standard 250', price: 3000,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', freezeLimitDays: 14,
  });
  noFreezePlan = await db1.models.MembershipPlan.create({
    gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'No Freeze 250', price: 3000,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', freezeLimitDays: 0,
  });
  tenant2Plan = await ctx.tenant2Db.models.MembershipPlan.create({
    gymId: ctx.branch2.gymId, branchId: ctx.branch2.id, name: 'Tenant2 250', price: 3000,
    durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', freezeLimitDays: 14,
  });
  otherBranch = await factories.createBranch(db1, ctx.listing1.id, { name: 'N250 Other Branch' });
});

afterAll(async () => {
  await triggers.settled();
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-250: staff Cancel', () => {
  test('the owner cancels a member subscription at once; the platform index follows', async () => {
    const { sub } = await makeSub();
    const res = await staff(personas.owner, `${sub.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXECUTED');
    expect(res.body.data.subscription.id).toBe(sub.id);
    expect(res.body.data.subscription.status).toBe('CANCELLED');
    const row = await reload(sub);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledAt).not.toBeNull();
    expect((await indexOf(sub)).status).toBe('CANCELLED');
  });

  test('a branch manager of that branch cancels too (DIRECT tier)', async () => {
    const { sub } = await makeSub({ status: 'FROZEN' });
    const res = await staff(personas.manager, `${sub.id}/cancel`);
    expect(res.status).toBe(200);
    expect((await reload(sub)).status).toBe('CANCELLED');
  });

  test('wrong id: 404, nothing written', async () => {
    const res = await staff(personas.owner, '7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/cancel');
    expect(res.status).toBe(404);
  });

  test('another tenant\'s subscription: 404 with the caller\'s own tenant, and the row is untouched', async () => {
    const { sub } = await makeSub({ db: ctx.tenant2Db, branch: ctx.branch2, planRow: tenant2Plan, tenantId: ctx.tenant2.id });
    const res = await staff(personas.owner, `${sub.id}/cancel`);
    expect(res.status).toBe(404);
    const viaOtherTenantHeader = await staff(personas.owner, `${sub.id}/cancel`, {}, ctx.tenant2.id);
    expect([403, 404]).toContain(viaOtherTenantHeader.status);
    expect((await reload(sub)).status).toBe('ACTIVE');
  });

  test('a branch the caller cannot see answers like a wrong id', async () => {
    const { sub } = await makeSub({ branch: otherBranch });
    const res = await staff(personas.manager, `${sub.id}/cancel`);
    expect(res.status).toBe(404);
    expect((await reload(sub)).status).toBe('ACTIVE');
  });

  test('already cancelled and expired: 409', async () => {
    const { sub } = await makeSub({ status: 'CANCELLED' });
    const res = await staff(personas.owner, `${sub.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already cancelled/);
    const { sub: expired } = await makeSub({ status: 'EXPIRED' });
    expect((await staff(personas.owner, `${expired.id}/cancel`)).status).toBe(409);
  });

  test('duplicate request: the second answers 409; two at the same time cancel once', async () => {
    const { sub } = await makeSub();
    expect((await staff(personas.owner, `${sub.id}/cancel`)).status).toBe(200);
    expect((await staff(personas.owner, `${sub.id}/cancel`)).status).toBe(409);

    const { sub: raced } = await makeSub();
    const [a, b] = await Promise.all([
      staff(personas.owner, `${raced.id}/cancel`),
      staff(personas.owner, `${raced.id}/cancel`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  test('front desk (REQUEST tier) queues an approval request and changes nothing; same key = same request', async () => {
    const { sub } = await makeSub();
    const send = () => request(app).post(`/api/v1/subscriptions/staff/${sub.id}/cancel`)
      .set('Authorization', `Bearer ${personas.frontDesk.token}`)
      .set('X-Tenant-Id', T1())
      .set('Idempotency-Key', `n250-cancel-${sub.id}`)
      .send({});
    const first = await send();
    expect(first.status).toBe(202);
    expect(first.body.data.status).toBe('PENDING');
    const second = await send();
    expect(second.status).toBe(202);
    expect(second.body.data.requestId).toBe(first.body.data.requestId);
    expect(second.body.data.duplicate).toBe(true);
    expect((await reload(sub)).status).toBe('ACTIVE');
    const reqRow = await db1.models.ApprovalRequest.findByPk(first.body.data.requestId);
    expect(reqRow.actionKey).toBe('subscriptions.cancel');
    expect(reqRow.branchId).toBe(ctx.branch1.id);
  });

  test('a trainer (no subscriptions.cancel) is refused', async () => {
    const { sub } = await makeSub();
    const res = await staff(personas.trainer, `${sub.id}/cancel`);
    expect([403, 404]).toContain(res.status);
    expect((await reload(sub)).status).toBe('ACTIVE');
  });

  test('cancel queues the device sync for the member (member removed from the access devices)', async () => {
    await registry.createDevice({
      tenantId: T1(), tenantDb: db1, branchId: ctx.branch1.id, organizationId: ctx.branch1.gymId || null,
      name: 'N250 Door', direction: 'in', importFirst: false, createdBy: personas.owner.user.id,
    });
    expect(await triggers.hasDevices(db1.sequelize)).toBe(true);
    const { sub, member } = await makeSub();
    await triggers.settled();
    const res = await staff(personas.owner, `${sub.id}/cancel`);
    expect(res.status).toBe(200);
    await triggers.settled();
    const rows = await db1.sequelize.query(
      'SELECT payload_json FROM capacity_outbox WHERE event_type = \'DEVICE_RECONCILE\' AND JSON_CONTAINS(payload_json, JSON_QUOTE(?), \'$.memberIds\')',
      { replacements: [member.id], type: QueryTypes.SELECT }
    );
    const reasons = rows.map((r) => (typeof r.payload_json === 'string' ? JSON.parse(r.payload_json) : r.payload_json).reason);
    expect(reasons).toContain('subscription_cancelled');
  });
});

describe('NEW-250: staff Freeze', () => {
  test('the owner freezes: FROZEN, freeze dates kept, end date moved by the frozen days, index follows', async () => {
    const { sub } = await makeSub();
    const res = await staff(personas.owner, `${sub.id}/freeze`, freezeBody());
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('EXECUTED');
    const row = await reload(sub);
    expect(row.status).toBe('FROZEN');
    expect(String(row.freezeFrom).slice(0, 10)).toBe(daysFromToday(1));
    expect(String(row.endDate).slice(0, 10)).toBe(daysFromToday(29 + 7));
    const idx = await indexOf(sub);
    expect(idx.status).toBe('FROZEN');
    expect(String(idx.endDate).slice(0, 10)).toBe(daysFromToday(29 + 7));
  });

  test('wrong id 404; other tenant 404', async () => {
    expect((await staff(personas.owner, '7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/freeze', freezeBody())).status).toBe(404);
    const { sub } = await makeSub({ db: ctx.tenant2Db, branch: ctx.branch2, planRow: tenant2Plan, tenantId: ctx.tenant2.id });
    expect((await staff(personas.owner, `${sub.id}/freeze`, freezeBody())).status).toBe(404);
    expect((await reload(sub)).status).toBe('ACTIVE');
  });

  test('not ACTIVE (cancelled, already frozen): 409', async () => {
    const { sub } = await makeSub({ status: 'CANCELLED' });
    expect((await staff(personas.owner, `${sub.id}/freeze`, freezeBody())).status).toBe(409);
    const { sub: frozen } = await makeSub({ status: 'FROZEN' });
    expect((await staff(personas.owner, `${frozen.id}/freeze`, freezeBody())).status).toBe(409);
  });

  test('duplicate request: the end date moves once; two at the same time freeze once', async () => {
    const { sub } = await makeSub();
    expect((await staff(personas.owner, `${sub.id}/freeze`, freezeBody())).status).toBe(200);
    expect((await staff(personas.owner, `${sub.id}/freeze`, freezeBody())).status).toBe(409);
    expect(String((await reload(sub)).endDate).slice(0, 10)).toBe(daysFromToday(36));

    const { sub: raced } = await makeSub();
    const [a, b] = await Promise.all([
      staff(personas.owner, `${raced.id}/freeze`, freezeBody()),
      staff(personas.owner, `${raced.id}/freeze`, freezeBody()),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(String((await reload(raced)).endDate).slice(0, 10)).toBe(daysFromToday(36));
  });

  test('the plan rules hold: no freeze on a plan that does not allow it, none over the limit', async () => {
    const { sub } = await makeSub({ planRow: noFreezePlan });
    expect((await staff(personas.owner, `${sub.id}/freeze`, freezeBody())).status).toBe(400);
    const { sub: long } = await makeSub();
    const res = await staff(personas.owner, `${long.id}/freeze`, { freezeFrom: daysFromToday(1), freezeTo: daysFromToday(30) });
    expect(res.status).toBe(400);
    expect((await reload(long)).status).toBe('ACTIVE');
  });

  test('missing or reversed dates: 422 before anything runs', async () => {
    const { sub } = await makeSub();
    expect((await staff(personas.owner, `${sub.id}/freeze`, {})).status).toBe(422);
    expect((await staff(personas.owner, `${sub.id}/freeze`, { freezeFrom: daysFromToday(5), freezeTo: daysFromToday(2) })).status).toBe(422);
  });

  test('front desk (REQUEST tier) queues subscriptions.pause and changes nothing', async () => {
    const { sub } = await makeSub();
    const res = await staff(personas.frontDesk, `${sub.id}/freeze`, freezeBody());
    expect(res.status).toBe(202);
    const reqRow = await db1.models.ApprovalRequest.findByPk(res.body.data.requestId);
    expect(reqRow.actionKey).toBe('subscriptions.pause');
    expect((await reload(sub)).status).toBe('ACTIVE');
  });
});

describe('NEW-250: the member routes are unchanged', () => {
  test('staff on the member routes still get 404 (NEW-08 kept)', async () => {
    const { sub } = await makeSub();
    const res = await request(app).post(`/api/v1/subscriptions/${sub.id}/cancel`)
      .set('Authorization', `Bearer ${personas.owner.token}`).send({});
    expect(res.status).toBe(404);
    expect((await reload(sub)).status).toBe('ACTIVE');
  });

  test('a member still freezes and cancels their own subscription', async () => {
    const { sub } = await makeSub({ user: personas.member.user });
    const frozen = await request(app).post(`/api/v1/subscriptions/${sub.id}/freeze`)
      .set('Authorization', `Bearer ${personas.member.token}`).send(freezeBody());
    expect(frozen.status).toBe(200);
    expect((await reload(sub)).status).toBe('FROZEN');
    const cancelled = await request(app).post(`/api/v1/subscriptions/${sub.id}/cancel`)
      .set('Authorization', `Bearer ${personas.member.token}`).send({});
    expect(cancelled.status).toBe(200);
    expect((await reload(sub)).status).toBe('CANCELLED');
    expect((await indexOf(sub)).status).toBe('CANCELLED');
  });
});
