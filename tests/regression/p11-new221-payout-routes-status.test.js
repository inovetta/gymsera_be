/**
 * P11 (C), NEW-221: the payout routes answer a caller who is not part of any gym's team with
 * 403 (permission), not 400 `missing_tenant_context`.
 *
 * Before: `tenantContext` answered 400 "Choose a gym to continue." (`tenantContext.js`, no
 * tenant resolved) before the permission check, so a traveller (gym member, no team role) asking
 * GET /host/payout-account or /host/payouts got a "validation" error for what is a refusal.
 *
 * Scope (owner, P11): only the routes the ledger names, /host/payout-account and /host/payouts*.
 * A platform admin without X-Tenant-Id keeps 400 `missing_tenant_context`: an admin may act in a
 * tenant once one is chosen (X-Tenant-Id, `hasAllBranches`), so "choose a gym" is a real
 * validation answer for them. Owner and team behaviour is unchanged.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

const DETAILS = { bankName: 'Tenant Bank', accountTitle: 'Alpha Fitness Pvt', accountNumber: '0001112223' };
const PASSWORD = 'Test@12345';

let ctx;
let PayoutAccount;

const ROUTES = [
  ['get', '/host/payout-account', undefined],
  ['put', '/host/payout-account', { details: { bankName: 'Hacker Bank' }, password: PASSWORD }],
  ['get', '/host/payouts', undefined],
  ['get', '/host/payouts/balance', undefined],
  ['post', '/host/payouts', { amount: 100 }],
];

const send = (persona, method, path, body, headers = {}) => {
  const req = asPersona(persona, headers)[method](path, body);
  return method === 'post' ? req.set('Idempotency-Key', `p11-new221-${persona}-${Date.now()}-${Math.random()}`) : req;
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  ({ PayoutAccount } = require('../../src/models/platform'));
  await PayoutAccount.destroy({ where: {} });
  await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DETAILS, detailsUpdatedAt: new Date(Date.now() - 3 * 86400000) });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-221: a traveller with no team role is refused with 403 on the payout routes', () => {
  test.each(ROUTES)('member %s %s → 403 forbidden, no data', async (method, path, body) => {
    const res = await send('member', method, path, body);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('forbidden');
    expect(JSON.stringify(res.body)).not.toContain(DETAILS.accountNumber);
  });

  test('nothing was changed by the refused calls', async () => {
    const row = await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id, organizationId: null } });
    expect(row.detailsJson).toEqual(DETAILS);
  });
});

describe('unchanged around it', () => {
  test.each(ROUTES.filter(([m]) => m === 'get'))('platform admin without X-Tenant-Id: %s %s → 400 missing_tenant_context (choose a gym)', async (method, path) => {
    const res = await send('platformAdmin', method, path);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('missing_tenant_context');
  });

  test('owner still reads the payout account (200) and the balance (200)', async () => {
    const account = await send('owner', 'get', '/host/payout-account');
    expect(account.status).toBe(200);
    expect(account.body.data.account.details).toEqual(DETAILS);
    const balance = await send('owner', 'get', '/host/payouts/balance');
    expect(balance.status).toBe(200);
  });

  test('a team member without the permission still gets 403 from the permission check', async () => {
    const res = await send('frontDesk', 'get', '/host/payout-account');
    expect(res.status).toBe(403);
  });
});
