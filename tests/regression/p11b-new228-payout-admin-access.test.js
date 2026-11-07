/**
 * P11b, NEW-228 (P1, security). Owner decision 2026-11-07 (spec §14 R-97).
 *
 * Before: a platform admin who sent X-Tenant-Id passed `can('payouts.bank.manage')` because
 * `hasAllBranches` is true for PLATFORM_ADMIN (`branchAccess.utils.js`), so
 * GET /host/payout-account answered 200 with the full account number, and PUT replaced the
 * host's bank details with only the admin's own password. The permission's own note says
 * "Owner only. Never delegate bank details." (`permissions.js`, payouts.bank.manage).
 *
 * Now:
 *  - read: a platform admin sees the account masked (numbers as their last four digits, no free
 *    text), never the full number; the payout list masks each payout's destination the same way;
 *  - write: a platform admin gets 403 `payout_account_owner_only` on every payout-account write,
 *    with or without X-Tenant-Id, with the correct password, and before any body validation;
 *  - audit: every platform-admin read of a payout account writes a platform audit entry with the
 *    admin's id and the gym (tenant); no entry, no answer.
 * The owner and team members without the owner role are unchanged.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

const PASSWORD = 'Test@12345'; // every harness user's password, the admin's included
const DETAILS = {
  bankName: 'Tenant Bank',
  accountTitle: 'Alpha Fitness Pvt',
  accountNumber: '0001112223',
  iban: 'PK36SCBL0000001123456702',
  branchCode: '0042',
  jazzCashNumber: '03001234567',
  easyPaisaNumber: '03451234567',
  additionalInstructions: 'Or pay to 9998887776 at the counter',
};
const FULL_NUMBERS = [DETAILS.accountNumber, DETAILS.iban, DETAILS.jazzCashNumber, DETAILS.easyPaisaNumber, '9998887776'];
const OLD = new Date(Date.now() - 3 * 86400000);

let ctx;
let PayoutAccount;
let PlatformAuditLog;
const asAdminIn = () => ({ 'X-Tenant-Id': ctx.tenant1.id });

const resetAccount = async () => {
  await PayoutAccount.destroy({ where: {} });
  await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DETAILS, detailsUpdatedAt: OLD });
};
const storedDetails = async () =>
  (await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id, organizationId: null } })).detailsJson;
const noFullNumber = (body) => {
  const text = JSON.stringify(body);
  for (const n of FULL_NUMBERS) expect(text).not.toContain(n);
};
const viewedEntries = () =>
  PlatformAuditLog.findAll({ where: { action: 'admin.payout_account_viewed', actorUserId: ctx.platformAdmin.id } });

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  ctx.platformAdmin = require('../harness/personas').personaManager.personas.platformAdmin.user;
  ({ PayoutAccount, PlatformAuditLog } = require('../../src/models/platform'));
});

beforeEach(resetAccount);

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-228 read: a platform admin sees the payout account masked, and the read is audited', () => {
  test('GET /host/payout-account with X-Tenant-Id → 200, numbers as last four digits only', async () => {
    const res = await asPersona('platformAdmin', asAdminIn()).get('/host/payout-account');
    expect(res.status).toBe(200);
    const { account } = res.body.data;
    expect(account.masked).toBe(true);
    expect(account.details).toEqual({
      bankName: 'Tenant Bank',
      accountTitle: 'Alpha Fitness Pvt',
      accountNumber: '••••2223',
      iban: '••••6702',
      jazzCashNumber: '••••4567',
      easyPaisaNumber: '••••4567',
    });
    noFullNumber(res.body);
  });

  test('each admin read writes one platform audit entry with the admin id and the gym', async () => {
    const before = (await viewedEntries()).length;
    await asPersona('platformAdmin', asAdminIn()).get('/host/payout-account');
    await asPersona('platformAdmin', asAdminIn()).get('/host/payout-account');
    const entries = await viewedEntries();
    expect(entries.length).toBe(before + 2);
    const last = entries[entries.length - 1];
    expect(last.actorUserId).toBe(ctx.platformAdmin.id);
    expect(last.targetType).toBe('tenant');
    expect(last.targetId).toBe(ctx.tenant1.id);
    expect(last.details).toEqual(expect.objectContaining({ tenantId: ctx.tenant1.id, gymName: ctx.tenant1.gymName }));
    noFullNumber(last.details);
  });

  test('no audit entry, no answer: if the entry cannot be written the admin gets 500 and no details', async () => {
    const spy = jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('audit store down'));
    try {
      const res = await asPersona('platformAdmin', asAdminIn()).get('/host/payout-account');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('Tenant Bank');
      noFullNumber(res.body);
    } finally {
      spy.mockRestore();
    }
  });

  test('GET /host/payouts with X-Tenant-Id: each payout destination is masked for the admin', async () => {
    const { Payout } = ctx.tenant1Db.models;
    await Payout.destroy({ where: {} });
    await Payout.create({ amount: 500, currency: 'PKR', status: 'PENDING', destinationJson: DETAILS, requestedBy: ctx.tenant1.ownerUserId });
    const res = await asPersona('platformAdmin', asAdminIn()).get('/host/payouts');
    expect(res.status).toBe(200);
    expect(res.body.data.payouts[0].destinationJson.accountNumber).toBe('••••2223');
    noFullNumber(res.body);

    const owner = await asPersona('owner').get('/host/payouts');
    expect(owner.status).toBe(200);
    expect(owner.body.data.payouts[0].destinationJson).toEqual(DETAILS);
    await Payout.destroy({ where: {} });
  });

  test('GET /gyms/profile with X-Tenant-Id: the admin gets no bank details', async () => {
    const res = await asPersona('platformAdmin', asAdminIn()).get('/gyms/profile');
    expect([200, 403]).toContain(res.status);
    noFullNumber(res.body);
  });
});

describe('NEW-228 write: a platform admin gets 403 on every payout-account write', () => {
  test.each([
    ['with X-Tenant-Id and the correct password', true, { details: { bankName: 'Hacker Bank', accountNumber: '6660006660' }, password: PASSWORD }],
    ['without X-Tenant-Id', false, { details: { bankName: 'Hacker Bank', accountNumber: '6660006660' }, password: PASSWORD }],
    ['with a body that would fail validation (403, not 400)', true, { details: { cardNumber: '4242424242424242' }, password: PASSWORD, extra: 1 }],
    ['with no password (403, not 401)', true, { details: { bankName: 'Hacker Bank' } }],
  ])('PUT /host/payout-account %s → 403 payout_account_owner_only, nothing changed', async (_label, withTenant, body) => {
    const res = await asPersona('platformAdmin', withTenant ? asAdminIn() : {}).put('/host/payout-account', body);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('payout_account_owner_only');
    noFullNumber(res.body);
    expect(await storedDetails()).toEqual(DETAILS);
  });

  test('PATCH /gyms/profile bank details with X-Tenant-Id and the correct password → 403, nothing changed', async () => {
    const res = await asPersona('platformAdmin', asAdminIn())
      .patch('/gyms/profile', { paymentDetailsJson: { bankName: 'Hacker Bank', accountNumber: '6660006660' }, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await storedDetails()).toEqual(DETAILS);
  });

  test('DELETE /host/payout-account does not exist for anyone (no delete route); nothing removed', async () => {
    const res = await asPersona('platformAdmin', asAdminIn()).delete('/host/payout-account');
    expect([403, 404]).toContain(res.status);
    expect(await storedDetails()).toEqual(DETAILS);
  });
});

describe('unchanged: the owner and team members without the owner role', () => {
  test('owner reads the full account (not masked), and no admin audit entry is written', async () => {
    const before = await PlatformAuditLog.count({ where: { action: 'admin.payout_account_viewed' } });
    const res = await asPersona('owner').get('/host/payout-account');
    expect(res.status).toBe(200);
    expect(res.body.data.account.details).toEqual(DETAILS);
    expect(res.body.data.account.masked).toBeFalsy();
    expect(await PlatformAuditLog.count({ where: { action: 'admin.payout_account_viewed' } })).toBe(before);
  });

  test('owner replaces the bank details with the password → 200', async () => {
    const next = { bankName: 'New Bank', accountNumber: '1234567890' };
    const res = await asPersona('owner').put('/host/payout-account', { details: next, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.account.details).toEqual(next);
    expect(await storedDetails()).toEqual(next);
  });

  test.each(['orgAdmin', 'manager', 'frontDesk'])('%s: GET and PUT /host/payout-account → 403 as before, nothing changed', async (persona) => {
    const read = await asPersona(persona).get('/host/payout-account');
    expect(read.status).toBe(403);
    noFullNumber(read.body);
    const write = await asPersona(persona).put('/host/payout-account', { details: { bankName: 'Hacker Bank' }, password: PASSWORD });
    expect(write.status).toBe(403);
    expect(await storedDetails()).toEqual(DETAILS);
  });
});
