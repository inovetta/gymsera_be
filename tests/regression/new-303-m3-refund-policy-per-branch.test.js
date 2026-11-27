/**
 * NEW-303 M3 (enterprise D12, API contract G9): the refund policy belongs to the branch only.
 *  - tenant migration 032 puts `refunds_allowed` / `refund_window_days` on `branches` and drops them from `businesses`;
 *  - `policyFor` reads only the branch (no business default, no fallback);
 *  - GET without `branchId` lists the branches; PUT takes `branchId` or `applyToAllBranches`, else 422 `branch_required`;
 *  - `applyToAllBranches` skips (and lists) branches where the caller has no direct `payments.refund`.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const refundService = require('../../src/services/subscription-refund.service');
const rename = require('../../src/database/rename-helpers');
const { MIGRATIONS } = require('../../src/database/tenant-migration-runner');

let app; let personas; let ctx; let db1;
const as = (persona, method, path, body) => {
  const r = request(app)[method](`/api/v1/subscriptions/${path}`).set('Authorization', `Bearer ${persona.token}`)
    .set('X-Organization-Id', persona.organizationId);
  return method === 'get' ? r : r.send(body || {});
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = personaManager.context;
  db1 = ctx.tenant1Db;
  app = await startTestServer();
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test('migration 032: the policy columns are on branches (off by default) and gone from the business table', async () => {
  expect(MIGRATIONS.at(-1).name).toBe('032_branch_refund_policy');
  const seq = db1.sequelize;
  expect(await rename.columnInfo(seq, 'branches', 'refunds_allowed')).toBeTruthy();
  expect(await rename.columnInfo(seq, 'branches', 'refund_window_days')).toBeTruthy();
  expect(await rename.columnInfo(seq, 'businesses', 'refunds_allowed')).toBeFalsy();
  expect(await rename.columnInfo(seq, 'businesses', 'refund_window_days')).toBeFalsy();
  const fresh = await db1.models.Branch.create({ businessId: ctx.branch1.businessId, branchName: 'Fresh', currency: 'PKR', timezone: 'Asia/Karachi' });
  expect(await refundService.policyFor(db1, fresh.id)).toMatchObject({ refundsAllowed: false, refundWindowDays: null });
});

test('policyFor reads only the branch: another branch of the same business is unaffected, and a missing branch refunds nothing', async () => {
  const a = await db1.models.Branch.create({ businessId: ctx.branch1.businessId, branchName: 'A', currency: 'PKR', timezone: 'Asia/Karachi' });
  const b = await db1.models.Branch.create({ businessId: ctx.branch1.businessId, branchName: 'B', currency: 'PKR', timezone: 'Asia/Karachi' });
  await a.update({ refundsAllowed: true, refundWindowDays: 14 });
  expect(await refundService.policyFor(db1, a.id)).toMatchObject({ refundsAllowed: true, refundWindowDays: 14 });
  expect(await refundService.policyFor(db1, b.id)).toMatchObject({ refundsAllowed: false, refundWindowDays: null });
  expect(await refundService.policyFor(db1, null)).toMatchObject({ branchId: null, refundsAllowed: false });
});

test('G9: GET without branchId lists the branches; PUT needs branchId or applyToAllBranches', async () => {
  const list = await as(personas.owner, 'get', 'staff/refund-policy');
  expect(list.status).toBe(200);
  expect(Object.keys(list.body.data)).toEqual(['branches']);
  const row = list.body.data.branches.find((x) => x.branchId === ctx.branch1.id);
  expect(Object.keys(row).sort()).toEqual(['branchId', 'branchName', 'businessId', 'refundWindowDays', 'refundsAllowed']);

  const none = await as(personas.owner, 'put', 'staff/refund-policy', { refundsAllowed: true });
  expect(none.status).toBe(422);
  expect(none.body.code).toBe('branch_required');
});

test('G9: applyToAllBranches changes every branch the caller may and reports the skipped ones; one audit row per branch', async () => {
  const before = await db1.models.AuditLog.count({ where: { action: 'refunds.policy.update' } });
  const all = await as(personas.owner, 'put', 'staff/refund-policy', { applyToAllBranches: true, refundsAllowed: true, refundWindowDays: 30 });
  expect(all.status).toBe(200);
  const active = await db1.models.Branch.findAll({ where: { status: 'ACTIVE' } });
  expect(all.body.data.updatedBranchIds.sort()).toEqual(active.map((x) => x.id).sort());
  expect(all.body.data.skippedBranchIds).toEqual([]);
  for (const br of active) expect(await refundService.policyFor(db1, br.id)).toMatchObject({ refundsAllowed: true, refundWindowDays: 30 });
  expect(await db1.models.AuditLog.count({ where: { action: 'refunds.policy.update' } })).toBe(before + active.length);
  const audit = await db1.models.AuditLog.findOne({ where: { action: 'refunds.policy.update' }, order: [['createdAt', 'DESC']] });
  expect(audit.targetType).toBe('branch');

  // a manager has no direct refund: nothing changes, 403
  const denied = await as(personas.manager, 'put', 'staff/refund-policy', { applyToAllBranches: true, refundsAllowed: false });
  expect(denied.status).toBe(403);
  expect((await refundService.policyFor(db1, ctx.branch1.id)).refundsAllowed).toBe(true);
});

test('PUT with a branchId changes only that branch', async () => {
  const other = await db1.models.Branch.create({ businessId: ctx.branch1.businessId, branchName: 'Other', currency: 'PKR', timezone: 'Asia/Karachi' });
  const res = await as(personas.owner, 'put', 'staff/refund-policy', { branchId: other.id, refundsAllowed: true, refundWindowDays: null });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ branchId: other.id, refundsAllowed: true, refundWindowDays: null });
  expect((await refundService.policyFor(db1, ctx.branch1.id)).refundWindowDays).toBe(30);
});
