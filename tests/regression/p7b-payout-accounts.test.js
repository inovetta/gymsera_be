/**
 * P7b (R-73, R-94, NEW-217): payout accounts belong to the TENANT (the business), not to one
 * organization.
 *
 * Before: the CMS Payouts page read and saved bank details through GET / PATCH /gyms/profile
 * (cms `gym/payouts/page.tsx`), an organization-profile endpoint that loads the tenant's first
 * gym (`gym.service.js#getProfile` / `_getOrCreateGym`) and needs listing.manage (NEW-62); the
 * details were a single tenants.payment_details_json value with no room for an organization
 * override.
 *
 * After: one store, platform table payout_accounts (tenant id + OPTIONAL organization id). A
 * payout or a traveller checkout for a branch uses its organization's account if one exists,
 * otherwise the tenant default. The launch API exposes only the tenant default:
 * GET / PUT /host/payout-account (owner only: payouts.bank.manage; re-auth; SEC-13 cooling).
 * /gyms/profile keeps reading and writing the same tenant default for released app builds.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { createGymListing, createBranch, makeBranchLive } = require('../harness/factories');
const { PaymentStatus } = require('../../src/constants/payment-status');

const DEFAULT_DETAILS = { bankName: 'Tenant Bank', accountTitle: 'Alpha Fitness Pvt', accountNumber: '0001112223', iban: 'PK00TEST0001112223' };
const ORG_DETAILS = { bankName: 'Org Bank', accountTitle: 'Alpha North', accountNumber: '0009998887' };
const PASSWORD = 'Test@12345';
const OLD = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

let personas;
let ctx;
let PayoutAccount;
let GymListing;
let orgB;
let branchB;

const clearAccounts = () => PayoutAccount.destroy({ where: {} });

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = require('../harness/personas').personaManager.context;
  ({ PayoutAccount, GymListing } = require('../../src/models/platform'));

  // A second organization of tenant 1 with its own branch.
  orgB = await createGymListing(ctx.tenant1.id, { title: 'Alpha North' });
  branchB = await createBranch(ctx.tenant1Db, orgB.id, { name: 'North Branch' });
  await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
  await makeBranchLive(ctx.tenant1Db, branchB.id);

  // Ledger balance for payout requests at branch 1.
  await ctx.tenant1Db.models.Payment.create({
    userId: personas.member.user.id,
    branchId: ctx.branch1.id,
    amount: '5000.00',
    currency: 'PKR',
    method: 'CASH',
    status: PaymentStatus.COMPLETED,
    paidAt: new Date(),
    businessDate: '2026-01-15',
  });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('PUT / GET /host/payout-account: the tenant default (NEW-217)', () => {
  beforeEach(clearAccounts);

  test('no credential → 401 reauth_required; nothing stored', async () => {
    const res = await asPersona('owner').put('/host/payout-account', { details: DEFAULT_DETAILS });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('reauth_required');
    expect(await PayoutAccount.count()).toBe(0);
  });

  test('owner saves with the password → one tenant-default row, no organization touched', async () => {
    const listingsBefore = JSON.stringify(await GymListing.findAll({ where: { tenantId: ctx.tenant1.id }, raw: true, order: [['id', 'ASC']] }));
    const gymsBefore = JSON.stringify(await ctx.tenant1Db.models.Gym.findAll({ raw: true, order: [['id', 'ASC']] }));

    const res = await asPersona('owner').put('/host/payout-account', { details: DEFAULT_DETAILS, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ scope: 'TENANT', organizationId: null, provider: 'BANK_TRANSFER', details: DEFAULT_DETAILS });
    expect(res.body.data.account.detailsUpdatedAt).toBeTruthy();

    const rows = await PayoutAccount.findAll({ raw: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: ctx.tenant1.id, organizationId: null, provider: 'BANK_TRANSFER', status: 'ACTIVE' });
    expect(rows[0].detailsJson).toEqual(DEFAULT_DETAILS);

    expect(JSON.stringify(await GymListing.findAll({ where: { tenantId: ctx.tenant1.id }, raw: true, order: [['id', 'ASC']] }))).toBe(listingsBefore);
    expect(JSON.stringify(await ctx.tenant1Db.models.Gym.findAll({ raw: true, order: [['id', 'ASC']] }))).toBe(gymsBefore);
  });

  test('a second save replaces the same row (never a second default)', async () => {
    await asPersona('owner').put('/host/payout-account', { details: DEFAULT_DETAILS, password: PASSWORD });
    const res = await asPersona('owner').put('/host/payout-account', { details: { ...DEFAULT_DETAILS, bankName: 'New Bank' }, password: PASSWORD });
    expect(res.status).toBe(200);
    const rows = await PayoutAccount.findAll({ raw: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].detailsJson.bankName).toBe('New Bank');
  });

  test('owner reads the tenant default; none saved → account null', async () => {
    const empty = await asPersona('owner').get('/host/payout-account');
    expect(empty.status).toBe(200);
    expect(empty.body.data.account).toBeNull();

    await asPersona('owner').put('/host/payout-account', { details: DEFAULT_DETAILS, password: PASSWORD });
    const res = await asPersona('owner').get('/host/payout-account');
    expect(res.status).toBe(200);
    expect(res.body.data.account).toMatchObject({ scope: 'TENANT', organizationId: null, details: DEFAULT_DETAILS });
  });

  test('the tenant default is returned even when an organization override exists (launch exposes only the default)', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS, detailsUpdatedAt: OLD });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: ctx.listing1.id, detailsJson: ORG_DETAILS, detailsUpdatedAt: OLD });
    const res = await asPersona('owner').get('/host/payout-account');
    expect(res.body.data.account.details).toEqual(DEFAULT_DETAILS);
  });

  test('unknown keys or non-text values in details → 400; nothing stored', async () => {
    const extra = await asPersona('owner').put('/host/payout-account', { details: { ...DEFAULT_DETAILS, cardNumber: '4242424242424242' }, password: PASSWORD });
    expect(extra.status).toBe(400);
    const nested = await asPersona('owner').put('/host/payout-account', { details: { bankName: { x: 1 } }, password: PASSWORD });
    expect(nested.status).toBe(400);
    const missing = await asPersona('owner').put('/host/payout-account', { password: PASSWORD });
    expect(missing.status).toBe(400);
    expect(await PayoutAccount.count()).toBe(0);
  });

  test.each(['orgAdmin', 'manager', 'frontDesk', 'trainer', 'member', 'platformAdmin'])(
    '%s may neither read nor save the payout account (owner only, payouts.bank.manage)',
    async (persona) => {
      await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS, detailsUpdatedAt: OLD });
      // A member or a platform admin has no tenant here: 400 missing_tenant_context (tenantContext,
      // as every /host/payouts route); a team member: 403 from payouts.bank.manage.
      const refused = (res) => (res.status === 400 ? res.body.code === 'missing_tenant_context' : [401, 403].includes(res.status));
      const read = await asPersona(persona).get('/host/payout-account');
      expect(refused(read)).toBe(true);
      expect(JSON.stringify(read.body)).not.toContain(DEFAULT_DETAILS.accountNumber);
      const write = await asPersona(persona).put('/host/payout-account', { details: { bankName: 'Hacker Bank' }, password: PASSWORD });
      expect(refused(write)).toBe(true);
      expect((await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id, organizationId: null } })).detailsJson).toEqual(DEFAULT_DETAILS);
    }
  );

  test('the other tenant\'s owner reads and saves only their own tenant', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS, detailsUpdatedAt: OLD });
    const read = await asPersona('otherTenantOwner').get('/host/payout-account');
    expect(read.status).toBe(200);
    expect(read.body.data.account).toBeNull();

    const save = await asPersona('otherTenantOwner').put('/host/payout-account', { details: ORG_DETAILS, password: PASSWORD });
    expect(save.status).toBe(200);
    expect((await PayoutAccount.findOne({ where: { tenantId: ctx.tenant2.id } })).detailsJson).toEqual(ORG_DETAILS);
    expect((await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id } })).detailsJson).toEqual(DEFAULT_DETAILS);
  });
});

describe('resolver: tenant → organization → branch (R-94)', () => {
  const payoutAccountService = () => require('../../src/services/payout-account.service');
  beforeEach(clearAccounts);

  test('only a tenant default → every branch of every organization uses it', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    const a = await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, ctx.branch1.id);
    const b = await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, branchB.id);
    expect(a).toMatchObject({ scope: 'TENANT', organizationId: null, details: DEFAULT_DETAILS });
    expect(b).toMatchObject({ scope: 'TENANT', organizationId: null, details: DEFAULT_DETAILS });
  });

  test('an organization override → its branches use it; other organizations keep the tenant default', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: orgB.id, detailsJson: ORG_DETAILS });
    const a = await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, ctx.branch1.id);
    const b = await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, branchB.id);
    expect(a).toMatchObject({ scope: 'TENANT', details: DEFAULT_DETAILS });
    expect(b).toMatchObject({ scope: 'ORGANIZATION', organizationId: orgB.id, details: ORG_DETAILS });
  });

  test('an override with no tenant default still applies to its organization; others get null', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: orgB.id, detailsJson: ORG_DETAILS });
    expect(await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, branchB.id)).toMatchObject({ details: ORG_DETAILS });
    expect(await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, ctx.branch1.id)).toBeNull();
  });

  test('a DISABLED override is skipped → tenant default', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: orgB.id, detailsJson: ORG_DETAILS, status: 'DISABLED' });
    expect(await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, branchB.id)).toMatchObject({ scope: 'TENANT' });
  });

  test('an override of another tenant\'s organization id is never used', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant2.id, organizationId: orgB.id, detailsJson: ORG_DETAILS });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    expect(await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, branchB.id)).toMatchObject({ scope: 'TENANT', details: DEFAULT_DETAILS });
  });

  test('no branch (an organization-wide payout) → the tenant default', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: orgB.id, detailsJson: ORG_DETAILS });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    expect(await payoutAccountService().resolveForBranch(ctx.tenant1Db, ctx.tenant1.id, null)).toMatchObject({ scope: 'TENANT' });
  });
});

describe('consumers use the resolver', () => {
  beforeEach(clearAccounts);

  test('traveller checkout: a branch of the overridden organization shows the override; another branch the tenant default', async () => {
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS });
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: orgB.id, detailsJson: ORG_DETAILS });

    const byBranchB = await asPersona('member').get(`/discovery/gyms/${branchB.id}/payment-details`);
    expect(byBranchB.status).toBe(200);
    expect(byBranchB.body.data.paymentDetails).toEqual(ORG_DETAILS);

    const byOrgB = await asPersona('member').get(`/discovery/gyms/${orgB.id}/payment-details`);
    expect(byOrgB.body.data.paymentDetails).toEqual(ORG_DETAILS);

    const byBranch1 = await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}/payment-details`);
    expect(byBranch1.body.data.paymentDetails).toEqual(DEFAULT_DETAILS);
  });

  test('payout request for a branch: destination and SEC-13 cooling come from the resolved account', async () => {
    // Tenant default changed long ago; organization 1 override changed just now → cooling applies.
    await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: null, detailsJson: DEFAULT_DETAILS, detailsUpdatedAt: OLD });
    const override = await PayoutAccount.create({ tenantId: ctx.tenant1.id, organizationId: ctx.listing1.id, detailsJson: ORG_DETAILS, detailsUpdatedAt: new Date() });

    const cooling = await asPersona('owner', { 'Idempotency-Key': 'p7b-cool-1' }).post('/host/payouts', { amount: 100, branchId: ctx.branch1.id });
    expect(cooling.status).toBe(422);
    expect(cooling.body.code).toBe('cooling_period_active');

    await override.update({ detailsUpdatedAt: OLD });
    const ok = await asPersona('owner', { 'Idempotency-Key': 'p7b-ok-1' }).post('/host/payouts', { amount: 100, branchId: ctx.branch1.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.destinationJson).toEqual(ORG_DETAILS);
  });

  // P11c (NEW-232, R-98): 409, was 422.
  test('payout request with no account at all → 409 no_payout_destination', async () => {
    const res = await asPersona('owner', { 'Idempotency-Key': 'p7b-none-1' }).post('/host/payouts', { amount: 100, branchId: ctx.branch1.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_payout_destination');
  });

  test('/gyms/profile (released app builds) reads and writes the same tenant default', async () => {
    const save = await asPersona('owner').patch('/gyms/profile', { paymentDetailsJson: DEFAULT_DETAILS, password: PASSWORD });
    expect(save.status).toBe(200);
    expect(save.body.data.gym.paymentDetailsJson).toEqual(DEFAULT_DETAILS);
    expect(save.body.data.gym.paymentDetailsUpdatedAt).toBeTruthy();

    const row = await PayoutAccount.findOne({ where: { tenantId: ctx.tenant1.id }, raw: true });
    expect(row).toMatchObject({ organizationId: null, provider: 'BANK_TRANSFER' });
    expect(row.detailsJson).toEqual(DEFAULT_DETAILS);

    const viaNew = await asPersona('owner').get('/host/payout-account');
    expect(viaNew.body.data.account.details).toEqual(DEFAULT_DETAILS);
    const viaOld = await asPersona('owner').get('/gyms/profile');
    expect(viaOld.body.data.gym.paymentDetailsJson).toEqual(DEFAULT_DETAILS);
  });
});
