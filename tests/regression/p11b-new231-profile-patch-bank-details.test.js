/**
 * P11b, NEW-231 (found while fixing NEW-228; owner rule 2026-11-07, R-97: "never the full number,
 * for any role other than the owner").
 *
 * GET /gyms/profile hides the bank details from anyone without payouts.bank.manage (NEW-45,
 * gyms.controller getProfile), but PATCH /gyms/profile answered with gymService.updateProfile's
 * result unfiltered: an organization admin (listing.manage, no payouts.bank.manage) who saved the
 * listing's description got the tenant's full payout account back in the answer.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

const DETAILS = { bankName: 'Tenant Bank', accountTitle: 'Alpha Fitness Pvt', accountNumber: '0001112223' };
const PASSWORD = 'Test@12345';

let ctx;
let PayoutAccount;

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

describe('NEW-231: PATCH /gyms/profile answers bank details only to the owner', () => {
  test('organization admin saves the description → 200, no bank details in the answer', async () => {
    const res = await asPersona('orgAdmin').patch('/gyms/profile', { description: 'Open early every day' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(DETAILS.accountNumber);
    expect(res.body.data.gym.paymentDetailsJson).toBeUndefined();
    expect(res.body.data.gym.paymentDetailsUpdatedAt).toBeUndefined();
  });

  test('the organization admin still cannot change the bank details (403, as before)', async () => {
    const res = await asPersona('orgAdmin').patch('/gyms/profile', { paymentDetailsJson: { bankName: 'Hacker Bank' }, password: PASSWORD });
    expect(res.status).toBe(403);
  });

  test('owner: the answer still carries the bank details (unchanged)', async () => {
    const res = await asPersona('owner').patch('/gyms/profile', { description: 'Open early every day' });
    expect(res.status).toBe(200);
    expect(res.body.data.gym.paymentDetailsJson).toEqual(DETAILS);
  });
});
