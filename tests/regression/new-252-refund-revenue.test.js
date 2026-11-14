/**
 * NEW-252: a refund is counted once in the payout balance and in every revenue figure.
 *
 * Before: the payout balance summed COMPLETED payments and subtracted every REVERSAL, so a full refund
 * (payment → REFUNDED) was deducted twice; revenue reports summed COMPLETED only, so a full refund
 * vanished from its month after the fact and a partial refund was never deducted.
 * After: collected = COMPLETED + REFUNDED, minus each REVERSAL once, when it was recorded.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { PaymentStatus } = require('../../src/constants/payment-status');
const payoutService = require('../../src/services/payout.service');
const reportsService = require('../../src/services/reports.service');

describe('NEW-252: refunds counted once in balance and revenue', () => {
  let h; let personas; let tenant1; let branchId; let memberUserId;
  const before = {};
  const after = {};

  const snapshot = async (into) => {
    const now = new Date();
    into.balance = await payoutService.getPayoutBalance(tenant1, branchId);
    into.dash = await reportsService.hostDashboard(tenant1, { branchIds: [branchId] });
    into.branch = await reportsService.branchReport(tenant1, branchId);
    into.filtered = await reportsService.hostDashboardFiltered(tenant1, { branchIds: [branchId] });
    into.year = await reportsService.yearlyRevenue(tenant1, now.getFullYear(), { branchIds: [branchId] });
    into.month = await reportsService.monthlyBreakdown(tenant1, { year: now.getFullYear(), month: now.getMonth() + 1, branchId });
    const dash = await asPersona('owner').get(`/host/branches/${branchId}/dashboard`);
    into.apiDash = dash.body.data;
    const pnl = await asPersona('owner').get(`/host/branches/${branchId}/expenses/summary`);
    into.apiPnl = pnl.body.data;
  };

  const pay = (amount) => tenant1.models.Payment.create({
    userId: memberUserId, branchId, amount, currency: 'PKR', method: 'CASH',
    status: PaymentStatus.COMPLETED, paidAt: new Date(), businessDate: new Date().toISOString().slice(0, 10),
  });

  const sumDays = (rows) => rows.reduce((acc, r) => acc + Number(r.totalRevenue), 0);
  const monthOf = (year) => Number(year.data.find((r) => r.month === ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date().getMonth()]).revenue);

  beforeAll(async () => {
    h = await setupTestDatabases();
    tenant1 = h.tenant1;
    personas = await setupPersonas(h);
    await startTestServer();
    branchId = (await tenant1.models.Branch.findOne({ where: { status: 'ACTIVE' } })).id;
    memberUserId = personas.member.user.id;

    await snapshot(before);
    const full = await pay('1000.00');
    const partial = await pay('600.00');
    const r1 = await asPersona('owner', { 'Idempotency-Key': `n252-full-${Date.now()}` }).post(`/payments/${full.id}/refund`, { reason: 'full' });
    const r2 = await asPersona('owner', { 'Idempotency-Key': `n252-part-${Date.now()}` }).post(`/payments/${partial.id}/refund`, { amount: 200, reason: 'part' });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    await snapshot(after);
  });

  afterAll(async () => { await teardownTestDatabases(); });

  // 1000 + 600 collected, 1000 + 200 refunded → +400 net.
  const NET = 400;

  test('payout balance: collected +1600, refunded +1200, available +400 (the full refund once, not twice)', () => {
    expect(Number(after.balance.totalCollected) - Number(before.balance.totalCollected)).toBe(1600);
    expect(Number(after.balance.totalRefunded) - Number(before.balance.totalRefunded)).toBe(1200);
    expect(Number(after.balance.availableBalance) - Number(before.balance.availableBalance)).toBe(NET);
  });

  test('host dashboard all-time and this month: +400', () => {
    expect(after.dash.revenue.allTime - before.dash.revenue.allTime).toBeCloseTo(NET, 2);
    expect(after.dash.revenue.thisMonth - before.dash.revenue.thisMonth).toBeCloseTo(NET, 2);
  });

  test('branch report all-time, this month and the day series: +400', () => {
    expect(after.branch.revenue.allTime - before.branch.revenue.allTime).toBeCloseTo(NET, 2);
    expect(after.branch.revenue.thisMonth - before.branch.revenue.thisMonth).toBeCloseTo(NET, 2);
    expect(sumDays(after.branch.revenueByDay) - sumDays(before.branch.revenueByDay)).toBeCloseTo(NET, 2);
  });

  test('filtered dashboard period, monthly breakdown and yearly month: +400', () => {
    expect(after.filtered.periodRevenue - before.filtered.periodRevenue).toBeCloseTo(NET, 2);
    expect(sumDays(after.month.revenueByDay) - sumDays(before.month.revenueByDay)).toBeCloseTo(NET, 2);
    expect(monthOf(after.year) - monthOf(before.year)).toBeCloseTo(NET, 2);
  });

  test('API: branch dashboard monthly revenue and P&L gross revenue: +400', () => {
    expect(after.apiDash.monthlyRevenue - before.apiDash.monthlyRevenue).toBeCloseTo(NET, 2);
    expect(after.apiPnl.grossRevenue - before.apiPnl.grossRevenue).toBeCloseTo(NET, 2);
  });

  test('a status filter still reads that status only (no refund deduction)', async () => {
    const refunded = await reportsService.hostDashboardFiltered(tenant1, { branchIds: [branchId], paymentStatus: PaymentStatus.REFUNDED });
    expect(refunded.periodRevenue).toBeCloseTo(1000, 2);
  });
});
