/**
 * GLB-02 (spec §12.11): a branch has a currency; payments carry it; it locks once money has moved;
 * an org-wide balance across two currencies is refused instead of summed.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const subscriptionService = require('../../src/services/subscription.service');
const gymService = require('../../src/services/gym.service');
const { getPayoutBalance } = require('../../src/services/payout.service');

describe('GLB-02: currency per branch', () => {
  let ctx;
  let tenantDb;
  let n = 0;

  const makeBranch = async (name, over = {}) => {
    const { Branch, MembershipPlan } = tenantDb.models;
    const branch = await Branch.create({ gymId: ctx.branch1.gymId, branchName: name, status: 'ACTIVE', ...over });
    const plan = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: branch.id, name: `${name} Plan`, price: '100.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true, // shown to travellers: a traveller books only a visible plan (NEW-163)
    });
    const listing = await factories.createGymListing(ctx.tenant1.id, { branchId: branch.id, title: `${name} Gym`, status: 'ACTIVE' });
    // Phase 7 P7a (NEW-159): only a live branch (R-77) takes a booking.
    await require('../harness/factories').makeBranchLive(tenantDb, branch);
    return { branch, plan, listing };
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    tenantDb = ctx.tenant1Db;
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('a new branch defaults to PKR (what every existing payment already says)', async () => {
    const { branch } = await makeBranch('GLB02 Default');
    expect(branch.currency).toBe('PKR');
  });

  test('a host can set a supported currency and a valid timezone; unsupported values are 400', async () => {
    const { branch } = await makeBranch('GLB02 Edit');
    const { branch: saved } = await gymService.updateBranch(tenantDb, branch.id, { currency: 'usd', timezone: 'America/New_York' });
    expect(saved.currency).toBe('USD');
    expect(saved.timezone).toBe('America/New_York');

    await expect(gymService.updateBranch(tenantDb, branch.id, { currency: 'KWD' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(gymService.updateBranch(tenantDb, branch.id, { timezone: 'Mars/Olympus' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('a member payment in a USD branch is USD, and the currency then locks', async () => {
    const usd = await makeBranch('GLB02 USD', { currency: 'USD' });
    n += 1;
    const user = await factories.createUser({ role: 'MEMBER', email: `glb02.m${n}@gymsera.test`, fullName: 'GLB02 Member' });
    const { payment } = await subscriptionService.subscribe(user.id, {
      planId: usd.plan.id, gymListingId: usd.listing.id, branchId: usd.branch.id,
    });
    expect(payment.currency).toBe('USD');

    await expect(gymService.updateBranch(tenantDb, usd.branch.id, { currency: 'EUR' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'branch_currency_locked' });
    // Sending the same value back (the CMS edit form posts the whole shape) is not a change.
    await expect(gymService.updateBranch(tenantDb, usd.branch.id, { currency: 'USD' })).resolves.toBeDefined();
  });

  test('the payout balance reports the branch currency; an org-wide balance over two currencies is refused', async () => {
    const eur = await makeBranch('GLB02 EUR', { currency: 'EUR' });
    const balance = await getPayoutBalance(tenantDb, eur.branch.id);
    expect(balance.currency).toBe('EUR');

    await expect(getPayoutBalance(tenantDb, null)).rejects.toMatchObject({ statusCode: 409, code: 'multiple_currencies' });
  });
});
