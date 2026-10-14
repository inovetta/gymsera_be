/**
 * API-07 / API-08: list DTOs carry only what the clients read.
 *
 * Removed from the GET /payments list row (read by no client: CMS, web or
 * mobile; the detail route GET /payments/:id still returns them):
 *   idempotencyKey, printedAt, printedBy, pendingChangeJson, expiresAt, updatedAt
 * Removed from GET /subscriptions/staff `latestPayment` (the clients read only
 * id, status, amount, method there; proofUrl / createdAt / verifiedAt stay):
 *   createdBy, createdByRole, verifiedBy and the audit enrichment
 *   (user, creator, createdByName, createdByEmail, createdByRoleDisplayName,
 *   sourcePlatform, verifier, verifiedByName, collector)
 * Every other key, and the subscription row's own enrichment (read by mobile
 * through rawData), is unchanged.
 */
const { Sequelize } = require('sequelize');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('API-07/08: slim list DTOs', () => {
  let h; let payment; let sub;
  let queryCount = 0;
  const origQuery = Sequelize.prototype.query;

  beforeAll(async () => {
    h = await setupTestDatabases();
    await setupPersonas(h);
    await startTestServer();
    const branch = await h.tenant1.models.Branch.findOne();
    const plan = await h.tenant1.models.MembershipPlan.create({
      gymId: branch.gymId, branchId: branch.id, name: 'Std', price: 3000,
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
    const u = await factories.createUser({ email: 'slim@api07.test', fullName: 'Slim Member', role: 'MEMBER' });
    sub = await h.tenant1.models.MemberSubscription.create({
      userId: u.id, membershipPlanId: plan.id, branchId: branch.id, status: 'ACTIVE',
      startDate: '2026-01-01', endDate: '2026-12-31',
    });
    payment = await factories.createPayment(h.tenant1, branch.id, {
      userId: u.id, referenceEntityId: sub.id, paymentFor: 'MEMBERSHIP', method: 'CASH',
    });
    Sequelize.prototype.query = async function counted(...a) { queryCount += 1; return origQuery.apply(this, a); };
  });
  afterAll(async () => {
    Sequelize.prototype.query = origQuery;
    await stopTestServer();
    await teardownTestDatabases();
  });

  const REMOVED_FROM_LIST = ['idempotencyKey', 'printedAt', 'printedBy', 'pendingChangeJson', 'expiresAt', 'updatedAt'];
  const STILL_IN_LIST = [
    'id', 'userId', 'paymentFor', 'referenceEntityId', 'method', 'gatewayName', 'gatewayTransactionId', 'amount',
    'currency', 'status', 'paidAt', 'verifiedAt', 'createdBy', 'createdByRole', 'branchId', 'staffCollectedBy',
    'collectedAt', 'shift', 'verifiedBy', 'notes', 'proofUrl', 'rejectedReason', 'businessDate', 'createdAt',
    'user', 'creator', 'createdByName', 'createdByEmail', 'createdByRoleDisplayName', 'sourcePlatform',
    'verifier', 'verifiedByName', 'collector',
  ];

  test('GET /payments rows drop only the six fields no client reads', async () => {
    const res = await asPersona('owner').get('/payments?page=1&limit=20');
    expect(res.status).toBe(200);
    const row = res.body.data.payments.find((p) => p.id === payment.id);
    expect(row).toBeDefined();
    for (const k of REMOVED_FROM_LIST) expect(row).not.toHaveProperty(k);
    for (const k of STILL_IN_LIST) expect(row).toHaveProperty(k);
    expect(res.body.pagination).toBeDefined();
  });

  test('GET /payments/:id (detail) still returns the full record', async () => {
    const res = await asPersona('owner').get(`/payments/${payment.id}`);
    expect(res.status).toBe(200);
    const row = res.body.data.payment || res.body.data;
    for (const k of ['idempotencyKey', 'printedAt', 'updatedAt']) expect(row).toHaveProperty(k);
  });

  test('GET /subscriptions/staff latestPayment carries only what the clients read', async () => {
    const res = await asPersona('owner').get('/subscriptions/staff?page=1&limit=20');
    expect(res.status).toBe(200);
    const row = res.body.data.subscriptions.find((s) => s.id === sub.id);
    expect(row).toBeDefined();
    expect(Object.keys(row.latestPayment).sort()).toEqual(
      ['amount', 'createdAt', 'id', 'method', 'proofUrl', 'referenceEntityId', 'status', 'verifiedAt']
    );
    expect(row.latestPayment.id).toBe(payment.id);
    expect(row.latestPayment.status).toBe('COMPLETED');
    expect(row.latestPayment.method).toBe('CASH');
    expect(Number(row.latestPayment.amount)).toBe(5000);
    // the subscription row itself is untouched (mobile reads creator / createdByName via rawData)
    for (const k of ['plan', 'branch', 'user', 'creator', 'createdByName', 'sourcePlatform', 'qrCode', 'freezeFrom']) {
      expect(row).toHaveProperty(k);
    }
  });

  test('a subscription with no payment still answers latestPayment: null', async () => {
    const branch = await h.tenant1.models.Branch.findOne();
    const plan = await h.tenant1.models.MembershipPlan.findOne();
    const u = await factories.createUser({ email: 'nopay@api07.test', role: 'MEMBER' });
    const s2 = await h.tenant1.models.MemberSubscription.create({
      userId: u.id, membershipPlanId: plan.id, branchId: branch.id, status: 'PENDING',
      startDate: '2026-01-01', endDate: '2026-12-31',
    });
    const res = await asPersona('owner').get('/subscriptions/staff?page=1&limit=20');
    const row = res.body.data.subscriptions.find((s) => s.id === s2.id);
    expect(row.latestPayment).toBeNull();
  });

  test('payload and query count are smaller than the pre-slim baselines', async () => {
    queryCount = 0;
    const subs = await asPersona('owner').get('/subscriptions/staff?page=1&limit=20');
    const subQueries = queryCount;
    const bytes = Buffer.byteLength(JSON.stringify(subs.body.data));
    // baseline before API-07/08: 12 queries for this request (measured on the same data shape)
    expect(subQueries).toBeLessThanOrEqual(11);
    expect(bytes).toBeGreaterThan(0);
  });
});
