/**
 * BUG-24 — one tier-name table for every client.
 *
 * Before: GET /billing/plans sent only the branch count; the mobile plan picker kept its own
 * copy of the tier names (branch_plan_picker_screen.dart _friendlyName) and Host Profile
 * printed "Growth Plan" for everyone. After: each plan carries `tierName` from
 * src/constants/plan-tiers.js, the same table GET /host/status uses for the plan the host paid.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  const { BillingPlan } = require('../../src/models/platform');
  await BillingPlan.destroy({ where: {} });
  for (const [n, order] of [[1, 1], [3, 2], [6, 3], [10, 4]]) {
    await factories.createBillingPlan({ branchCount: n, sortOrder: order, monthlyPrice: 1000 * n, annualPrice: 10000 * n });
  }
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test.each(['ios', 'android', 'web', ''])('GET /billing/plans?platform=%s names each tier from the one table', async (platform) => {
  const res = await asPersona('member').get(`/billing/plans${platform ? `?platform=${platform}` : ''}`);
  expect(res.status).toBe(200);
  const names = Object.fromEntries(res.body.data.plans.map((p) => [p.branchCount, p.tierName]));
  expect(names).toEqual({ 1: 'Starter', 3: 'Professional', 6: 'Growth', 10: 'Scale' });
});
