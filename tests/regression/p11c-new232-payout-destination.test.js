/**
 * P11c, NEW-232 (P1, security). Owner decision 2026-11-07 (spec §14 R-98).
 *
 * Before: POST /host/payouts took `destinationJson` from the request body and it replaced the
 * saved payout account (`payout.commands.js` validate and execute: `payload.destinationJson ||
 * account.details`). A payout request could name any account, without the re-authentication and
 * the 24-hour wait that PUT /host/payout-account enforces; a platform admin with X-Tenant-Id could
 * send it too (`hasAllBranches`).
 *
 * Now:
 *  - the payout always goes to the saved payout account (resolved for the branch); any
 *    destination, account or bank field in the body is ignored, with a log line, and the request
 *    still succeeds (older clients); the saved account is never written by this route;
 *  - no saved account: 409 `no_payout_destination` with a clear message;
 *  - an account changed in the last 24 hours: refused (422 `cooling_period_active`, SEC-13);
 *  - a platform admin: 403 `payout_request_not_for_platform_admins`, with or without X-Tenant-Id,
 *    on POST /host/payouts and on POST /actions/payouts.request;
 *  - a payout waiting for approval that was submitted with a body destination pays the saved
 *    account when it is approved (the stored payload is not trusted either).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const { PaymentStatus } = require('../../src/constants/payment-status');

const SAVED = { bankName: 'Tenant Bank', accountTitle: 'Alpha Fitness Pvt', accountNumber: '0001112223' };
const HACKER = { bankName: 'Hacker Bank', accountTitle: 'Someone Else', accountNumber: '6660006660' };
const OLD = new Date(Date.now() - 3 * 86400000);
const NO_ACCOUNT_MESSAGE =
  'There is no payout account to pay to. The owner adds the bank or wallet details under Payouts first; payouts are paid only to that saved account.';

let ctx;
let PayoutAccount;
let Payout;
let seq = 0;

const post = (persona, body, headers = {}) =>
  asPersona(persona, { 'Idempotency-Key': `p11c-${persona}-${Date.now()}-${(seq += 1)}`, ...headers }).post('/host/payouts', body);
const saved = async () => (await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id, organizationId: null } }))?.detailsJson;
const noHacker = (body) => expect(JSON.stringify(body)).not.toContain(HACKER.accountNumber);
const resetAccount = async (detailsUpdatedAt = OLD) => {
  await PayoutAccount.destroy({ where: {} });
  await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: SAVED, detailsUpdatedAt });
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  const personas = await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  ({ PayoutAccount } = require('../../src/models/platform'));
  ({ Payout } = ctx.tenant1Db.models);
  await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
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
  await resetAccount();
  await Payout.destroy({ where: {} });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-232: the payout always goes to the saved payout account', () => {
  test('owner, normal payout → 201 to the saved account', async () => {
    const res = await post('owner', { amount: 100, branchId: ctx.branch1.id });
    expect(res.status).toBe(201);
    expect(res.body.data.destinationJson).toEqual(SAVED);
  });

  test('a body destinationJson is ignored: 201, paid to the saved account, the saved account unchanged, one log line', async () => {
    const warn = jest.spyOn(console, 'warn');
    try {
      const res = await post('owner', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER });
      expect(res.status).toBe(201);
      expect(res.body.data.destinationJson).toEqual(SAVED);
      noHacker(res.body);
      const rows = await Payout.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].destinationJson).toEqual(SAVED);
      expect(await saved()).toEqual(SAVED);
      const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('NEW-232'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('destinationJson');
      expect(lines[0]).not.toContain(HACKER.accountNumber);
    } finally {
      warn.mockRestore();
    }
  });

  test('bank and account fields at the top of the body are ignored too (201, saved account)', async () => {
    const res = await post('owner', {
      amount: 100,
      branchId: ctx.branch1.id,
      bankName: HACKER.bankName,
      accountTitle: HACKER.accountTitle,
      accountNumber: HACKER.accountNumber,
      iban: 'PK00HACK6660006660',
      destination: HACKER,
      bankDetails: HACKER,
      paymentDetailsJson: HACKER,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.destinationJson).toEqual(SAVED);
    noHacker(res.body);
    expect(await saved()).toEqual(SAVED);
  });

  test('no saved payout account → 409 no_payout_destination with a clear message, even with a body destination', async () => {
    await PayoutAccount.destroy({ where: {} });
    const res = await post('owner', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_payout_destination');
    expect(res.body.message).toBe(NO_ACCOUNT_MESSAGE);
    expect(await Payout.count()).toBe(0);
    expect(await saved()).toBeUndefined();
  });

  test('saved account changed 1 hour ago → refused (24-hour wait), even with a body destination; nothing created', async () => {
    await resetAccount(new Date(Date.now() - 60 * 60 * 1000));
    const res = await post('owner', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('cooling_period_active');
    expect(await Payout.count()).toBe(0);
  });

  test('saved account changed 25 hours ago → 201', async () => {
    await resetAccount(new Date(Date.now() - 25 * 60 * 60 * 1000));
    const res = await post('owner', { amount: 100, branchId: ctx.branch1.id });
    expect(res.status).toBe(201);
  });
});

describe('NEW-232: platform admins get 403', () => {
  test.each([
    ['with X-Tenant-Id', true],
    ['without X-Tenant-Id', false],
  ])('POST /host/payouts %s → 403, nothing created', async (_label, withTenant) => {
    const res = await post('platformAdmin', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER }, withTenant ? { 'X-Tenant-Id': ctx.tenant1.id } : {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('payout_request_not_for_platform_admins');
    expect(await Payout.count()).toBe(0);
  });

  test('POST /actions/payouts.request with X-Tenant-Id → 403, nothing created', async () => {
    const res = await asPersona('platformAdmin', { 'X-Tenant-Id': ctx.tenant1.id, 'Idempotency-Key': `p11c-act-${Date.now()}` })
      .post('/actions/payouts.request', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER });
    expect(res.status).toBe(403);
    expect(await Payout.count()).toBe(0);
  });
});

describe('NEW-232: a request waiting for approval pays the saved account when approved', () => {
  test('organization admin submits with a body destination (202); the owner approves; the payout goes to the saved account', async () => {
    const submitted = await post('orgAdmin', { amount: 100, branchId: ctx.branch1.id, destinationJson: HACKER });
    expect(submitted.status).toBe(202);
    const approved = await asPersona('owner').post(`/approvals/${submitted.body.data.approvalRequestId}/approve`, {});
    expect(approved.status).toBe(200);
    const rows = await Payout.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].destinationJson).toEqual(SAVED);
    expect(await saved()).toEqual(SAVED);
  });
});
