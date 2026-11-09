/**
 * P11d, decision R-99 (owner, 2026-11-08): payouts are hidden at launch.
 *
 * The payout balance is a bookkeeping number from the gym's own records and a payout request only
 * creates a PENDING row: no provider moves money. Until online payments are connected, a host must
 * not be offered a payout feature.
 *
 * PAYOUTS_ENABLED (default off; on only when it is exactly "true"):
 *  - off: GET /host/payouts/balance, GET /host/payouts, POST /host/payouts and
 *    POST /actions/payouts.request answer 404 `payouts_not_available`, for every caller, before
 *    authentication, tenant context or body checks; nothing is written;
 *  - GET / PUT /host/payout-account stay live either way (owner answer, 2026-11-08): it holds the bank
 *    details travellers pay into by bank transfer (GET /discovery/gyms/:id/payment-details);
 *  - GET /meta/app-config (and GET /me/bootstrap, which carries it) answers `features.payouts`, so the
 *    CMS and the app hide the payout entries;
 *  - on: every payout route behaves as before (the existing payout suites run with it on, see
 *    tests/harness/payouts-enabled.js).
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const { PaymentStatus } = require('../../src/constants/payment-status');

const DETAILS = { bankName: 'Tenant Bank', accountTitle: 'Alpha Fitness Pvt', accountNumber: '0001112223' };
const SAVED_ENV = process.env.PAYOUTS_ENABLED;

let ctx;
let app;
let Payout;
let ApprovalRequest;
let seq = 0;

const PAYOUT_ROUTES = [
  ['get', '/host/payouts/balance'],
  ['get', '/host/payouts'],
  ['post', '/host/payouts'],
  ['post', '/actions/payouts.request'],
];
const PERSONAS = ['owner', 'orgAdmin', 'manager', 'frontDesk', 'member', 'platformAdmin', 'otherTenantOwner'];

const call = (persona, method, path, headers = {}) => {
  const h = { 'Idempotency-Key': `p11d-${persona}-${Date.now()}-${(seq += 1)}`, ...headers };
  const body = path === '/actions/payouts.request'
    ? { branchId: ctx.branch1.id, payload: { amount: 100 } }
    : { amount: 100, branchId: ctx.branch1.id };
  const req = asPersona(persona, h)[method](path, method === 'post' ? body : undefined);
  return req;
};
const anonymous = (method, path) => request(app)[method](`/api/v1${path}`).set('Idempotency-Key', `p11d-anon-${(seq += 1)}`);

const flag = (value) => {
  if (value === undefined) delete process.env.PAYOUTS_ENABLED;
  else process.env.PAYOUTS_ENABLED = value;
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  app = await startTestServer();
  ctx = require('../harness/personas').personaManager.context;
  const { PayoutAccount } = require('../../src/models/platform');
  ({ Payout, ApprovalRequest } = ctx.tenant1Db.models);
  await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
  await PayoutAccount.destroy({ where: {} });
  await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DETAILS, detailsUpdatedAt: new Date(Date.now() - 3 * 86400000) });
  await ctx.tenant1Db.models.Payment.create({
    userId: personas.member.user.id,
    branchId: ctx.branch1.id,
    amount: '50000.00',
    currency: 'PKR',
    method: 'CASH',
    status: PaymentStatus.COMPLETED,
    paidAt: new Date(),
    businessDate: '2026-01-15',
  });
});

beforeEach(async () => {
  await Payout.destroy({ where: {} });
});

afterAll(async () => {
  flag(SAVED_ENV);
  await stopTestServer();
  await teardownTestDatabases();
});

const expectNotAvailable = (res) => {
  expect(res.status).toBe(404);
  expect(res.body.success).toBe(false);
  expect(res.body.code).toBe('payouts_not_available');
  expect(JSON.stringify(res.body)).not.toContain(DETAILS.accountNumber);
};

describe.each([
  ['unset (the default)', undefined],
  ['"false"', 'false'],
  ['"1" (only "true" turns it on)', '1'],
])('PAYOUTS_ENABLED %s: the payout routes answer 404 payouts_not_available', (_label, value) => {
  beforeEach(() => flag(value));

  test.each(PAYOUT_ROUTES)('every persona: %s %s → 404', async (method, path) => {
    for (const persona of PERSONAS) {
      expectNotAvailable(await call(persona, method, path, persona === 'platformAdmin' ? { 'X-Tenant-Id': ctx.tenant1.id } : {}));
    }
    expectNotAvailable(await anonymous(method, path));
  });

  test('nothing is written: no payout, no approval request', async () => {
    const approvalsBefore = ApprovalRequest ? await ApprovalRequest.count() : 0;
    await call('owner', 'post', '/host/payouts');
    await call('orgAdmin', 'post', '/host/payouts');
    await call('owner', 'post', '/actions/payouts.request');
    expect(await Payout.count()).toBe(0);
    if (ApprovalRequest) expect(await ApprovalRequest.count()).toBe(approvalsBefore);
  });

  test('the payout account stays live: owner reads it (travellers pay into it by bank transfer)', async () => {
    const res = await asPersona('owner').get('/host/payout-account');
    expect(res.status).toBe(200);
    expect(res.body.data.account.details).toEqual(DETAILS);
  });

  test('travellers still get the bank details', async () => {
    const res = await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}/payment-details`);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentDetails).toMatchObject({ accountNumber: DETAILS.accountNumber });
  });

  test('GET /meta/app-config says payouts are off; /me/bootstrap carries the same', async () => {
    const cfg = await request(app).get('/api/v1/meta/app-config');
    expect(cfg.status).toBe(200);
    expect(cfg.body.data.features).toEqual({ payouts: false });
    const boot = await asPersona('owner').get('/me/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.data.app.features).toEqual({ payouts: false });
  });
});

describe('PAYOUTS_ENABLED "true": payouts behave as before', () => {
  beforeEach(() => flag('true'));

  test('GET /meta/app-config says payouts are on', async () => {
    const cfg = await request(app).get('/api/v1/meta/app-config');
    expect(cfg.body.data.features).toEqual({ payouts: true });
  });

  test('owner: balance 200, list 200, request 201 to the saved account', async () => {
    expect((await call('owner', 'get', '/host/payouts/balance')).status).toBe(200);
    expect((await call('owner', 'get', '/host/payouts')).status).toBe(200);
    const res = await call('owner', 'post', '/host/payouts');
    expect(res.status).toBe(201);
    expect(res.body.data.destinationJson).toEqual(DETAILS);
  });

  test('POST /actions/payouts.request by the owner runs the action (not 404)', async () => {
    const res = await call('owner', 'post', '/actions/payouts.request');
    expect(res.status).not.toBe(404);
    expect([200, 201]).toContain(res.status);
  });

  test('the usual refusals are unchanged: traveller 403, platform admin 403', async () => {
    expect((await call('member', 'get', '/host/payouts')).status).toBe(403);
    const admin = await call('platformAdmin', 'post', '/host/payouts', { 'X-Tenant-Id': ctx.tenant1.id });
    expect(admin.status).toBe(403);
    expect(admin.body.code).toBe('payout_request_not_for_platform_admins');
  });
});

describe('other action keys are not affected by the flag', () => {
  test('flag off: POST /actions/<unknown> still answers through the normal permission check (403, not payouts_not_available)', async () => {
    flag(undefined);
    const res = await asPersona('member').post('/actions/members.create', { branchId: ctx.branch1.id, payload: {} });
    expect(res.body.code).not.toBe('payouts_not_available');
  });
});
