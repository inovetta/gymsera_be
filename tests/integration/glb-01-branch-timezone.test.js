/**
 * GLB-01 (spec §12.11): business dates follow the BRANCH timezone, not the server's.
 *
 * The clock is fixed at 2026-07-01 20:00 UTC. That instant is already 2026-07-02 in Pacific/Kiritimati (UTC+14)
 * and still 2026-07-01 in Pacific/Pago_Pago (UTC-11); the UTC date is 2026-07-01. Before the fix a membership
 * started on the UTC date everywhere.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { createUser } = require('../harness/factories');
const subscriptionService = require('../../src/services/subscription.service');
const { processTenantRecurringExpenses } = require('../../src/jobs/recurring-expenses.cron');

const NOW = Date.parse('2026-07-01T20:00:00Z');

const fakeClock = (ms) =>
  jest.useFakeTimers({
    now: ms,
    doNotFake: [
      'nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      'queueMicrotask', 'hrtime', 'performance',
    ],
  });

describe('GLB-01: memberships and recurring expenses use the branch timezone', () => {
  let ctx;
  let tenantDb;
  let kiritimati;
  let pagoPago;
  let n = 0;

  const makeBranch = async (name, timezone) => {
    const { Branch, MembershipPlan } = tenantDb.models;
    const branch = await Branch.create({ gymId: ctx.branch1.gymId, branchName: name, timezone, status: 'ACTIVE' });
    const plan = await MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: branch.id, name: `${name} Monthly`, price: '1000.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true, // shown to travellers: a traveller books only a visible plan (NEW-163)
    });
    const listing = await require('../harness/factories').createGymListing(ctx.tenant1.id, {
      branchId: branch.id, title: `${name} Gym`, status: 'ACTIVE',
    });
    // Phase 7 P7a (NEW-159): only a live branch (R-77) takes a booking.
    await require('../harness/factories').makeBranchLive(tenantDb, branch);
    return { branch, plan, listing };
  };

  const subscribeAt = async ({ branch, plan, listing }) => {
    n += 1;
    const user = await createUser({ role: 'MEMBER', email: `glb01.m${n}@gymsera.test`, fullName: `GLB01 Member ${n}` });
    const { subscription } = await subscriptionService.subscribe(user.id, {
      planId: plan.id, gymListingId: listing.id, branchId: branch.id,
    });
    return subscription;
  };

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    tenantDb = ctx.tenant1Db;
    kiritimati = await makeBranch('GLB01 Kiritimati', 'Pacific/Kiritimati');
    pagoPago = await makeBranch('GLB01 PagoPago', 'Pacific/Pago_Pago');
  });

  afterEach(() => jest.useRealTimers());
  afterAll(async () => {
    jest.useRealTimers();
    await teardownTestDatabases();
  });

  test('a member joining a UTC+14 branch starts on that branch\'s date, not the UTC date', async () => {
    fakeClock(NOW);
    const sub = await subscribeAt(kiritimati);
    expect(sub.startDate).toBe('2026-07-02');
    expect(sub.endDate).toBe('2026-08-02');
  });

  test('a member joining a UTC-11 branch at the same instant starts a day earlier', async () => {
    fakeClock(NOW);
    const sub = await subscribeAt(pagoPago);
    expect(sub.startDate).toBe('2026-07-01');
    expect(sub.endDate).toBe('2026-08-01');
  });

  test('a recurring expense is generated on the branch date, once, and not again the same local day', async () => {
    const { Expense, ExpenseCategory } = tenantDb.models;
    const category = await ExpenseCategory.create({ name: 'GLB01 Rent', branchId: kiritimati.branch.id });
    const template = await Expense.create({
      branchId: kiritimati.branch.id,
      categoryId: category.id,
      title: 'GLB01 Monthly rent',
      amount: '500.00',
      expenseDate: '2026-06-02', // due again on 2026-07-02, which is "today" only in Kiritimati
      isRecurring: true,
      recurrenceFrequency: 'monthly',
      status: 'approved',
      createdBy: require('../harness/personas').personaManager.personas.owner.user.id,
    });

    // UTC date is still 2026-07-01 but the branch is already on 2026-07-02: the instance is due.
    fakeClock(NOW);
    await processTenantRecurringExpenses('glb01-tenant', tenantDb);
    const generated = await Expense.findAll({ where: { recurringTemplateId: template.id } });
    expect(generated).toHaveLength(1);
    expect(generated[0].expenseDate).toBe('2026-07-02');

    await processTenantRecurringExpenses('glb01-tenant', tenantDb);
    expect(await Expense.count({ where: { recurringTemplateId: template.id } })).toBe(1);
  });
});
