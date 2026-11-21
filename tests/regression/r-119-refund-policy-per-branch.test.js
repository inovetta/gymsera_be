'use strict';

/**
 * R-119 D12 (NEW-303b): the refund policy belongs to the branch only.
 *  - policyFor / quote read only the branch (never the gym row, never another branch).
 *  - PUT with branchId changes that branch; applyToAllBranches changes every branch the caller refunds at.
 *  - Old builds (no branchId): PUT changes every branch of the OLDEST business and nothing else; GET answers
 *    the oldest business's oldest branch, in the old shape (gymId, refundsAllowed, refundWindowDays).
 *  - A new branch starts with refunds off. gyms.refunds_allowed is no longer read.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { personaManager } = require('../harness/personas');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const refundService = require('../../src/services/subscription-refund.service');

let app; let personas; let ctx; let db1;
let oldGym; let oldBranches; let newGym; let newBranch;

const T1 = () => personas.owner.tenantId;
const as = (persona, method, body) => {
  const r = request(app)[method]('/api/v1/subscriptions/staff/refund-policy')
    .set('Authorization', `Bearer ${persona.token}`)
    .set('X-Tenant-Id', T1());
  return method === 'get' ? r.query(body || {}) : r.send(body || {});
};
const policyOf = async (branch) => {
  await branch.reload();
  return [branch.refundsAllowed, branch.refundWindowDays == null ? null : Number(branch.refundWindowDays)];
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  ctx = personaManager.context;
  db1 = ctx.tenant1Db;
  app = await startTestServer();
  const { Gym, Branch } = db1.models;
  oldGym = await Gym.findOne({ order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  // A second, newer business with its own branch (Add Business), created after the persona set-up.
  newGym = await Gym.create({ name: 'R119 Second Business', createdAt: new Date(Date.now() + 60000) });
  newBranch = await Branch.create({ gymId: newGym.id, branchName: 'R119 Second Main', city: 'Peshawar', status: 'ACTIVE' });
  oldBranches = await Branch.findAll({ where: { gymId: oldGym.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  await Branch.update({ refundsAllowed: false, refundWindowDays: null }, { where: {} });
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('R-119 D12: refund policy per branch', () => {
  test('a new branch starts with refunds off', async () => {
    const b = await db1.models.Branch.create({ gymId: oldGym.id, branchName: 'R119 Fresh', city: 'Peshawar', status: 'ACTIVE' });
    expect(await policyOf(b)).toEqual([false, null]);
    await b.destroy();
  });

  test('policyFor reads only the branch: the gym row and other branches do not matter', async () => {
    await oldGym.update({ refundsAllowed: true, refundWindowDays: 99 });
    await newBranch.update({ refundsAllowed: true, refundWindowDays: 7 });
    expect(await refundService.policyFor(db1, oldBranches[0].id)).toMatchObject({ branchId: oldBranches[0].id, refundsAllowed: false, refundWindowDays: null });
    expect(await refundService.policyFor(db1, newBranch.id)).toMatchObject({ branchId: newBranch.id, gymId: newGym.id, refundsAllowed: true, refundWindowDays: 7 });
    await oldGym.update({ refundsAllowed: false, refundWindowDays: null });
    await newBranch.update({ refundsAllowed: false, refundWindowDays: null });
  });

  test('PUT with branchId changes that branch only, audited per branch', async () => {
    const res = await as(personas.owner, 'put', { branchId: newBranch.id, refundsAllowed: true, refundWindowDays: 14 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ branchId: newBranch.id, refundsAllowed: true, refundWindowDays: 14 });
    expect(await policyOf(newBranch)).toEqual([true, 14]);
    for (const b of oldBranches) expect(await policyOf(b)).toEqual([false, null]);
    const audit = await db1.models.AuditLog.findOne({ where: { action: 'refunds.policy.update', targetId: newBranch.id }, order: [['createdAt', 'DESC']] });
    expect(audit).not.toBeNull();
    expect(audit.targetType).toBe('branch');
    const get = await as(personas.owner, 'get', { branchId: newBranch.id });
    expect(get.body.data).toMatchObject({ branchId: newBranch.id, refundsAllowed: true, refundWindowDays: 14 });
  });

  test('old build (no branchId): PUT changes every branch of the oldest business and nothing else; GET answers its oldest branch', async () => {
    await newBranch.update({ refundsAllowed: false, refundWindowDays: null });
    const put = await as(personas.owner, 'put', { refundsAllowed: true, refundWindowDays: 30 });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ gymId: oldGym.id, refundsAllowed: true, refundWindowDays: 30 });
    for (const b of oldBranches) expect(await policyOf(b)).toEqual([true, 30]);
    expect(await policyOf(newBranch)).toEqual([false, null]);
    const get = await as(personas.owner, 'get');
    expect(get.status).toBe(200);
    expect(get.body.data).toMatchObject({ gymId: oldGym.id, branchId: oldBranches[0].id, refundsAllowed: true, refundWindowDays: 30 });
  });

  test('applyToAllBranches changes every branch of every business', async () => {
    const res = await as(personas.owner, 'put', { applyToAllBranches: true, refundsAllowed: true, refundWindowDays: null });
    expect(res.status).toBe(200);
    expect(res.body.data.updatedBranchIds).toEqual(expect.arrayContaining([newBranch.id, ...oldBranches.map((b) => b.id)]));
    expect(await policyOf(newBranch)).toEqual([true, null]);
    for (const b of oldBranches) expect(await policyOf(b)).toEqual([true, null]);
  });

  test('guards: branchId with applyToAllBranches is 422; a manager and a front desk get 403 on every scope; bad values 422', async () => {
    expect((await as(personas.owner, 'put', { branchId: newBranch.id, applyToAllBranches: true, refundsAllowed: false })).status).toBe(422);
    expect((await as(personas.owner, 'put', { applyToAllBranches: 'yes', refundsAllowed: false })).status).toBe(422);
    expect((await as(personas.owner, 'put', { branchId: newBranch.id, refundWindowDays: 0 })).status).toBe(422);
    for (const p of [personas.manager, personas.frontDesk]) {
      expect((await as(p, 'put', { applyToAllBranches: true, refundsAllowed: false })).status).toBe(403);
      expect((await as(p, 'put', { refundsAllowed: false })).status).toBe(403);
    }
    expect(await policyOf(newBranch)).toEqual([true, null]);
  });
});
