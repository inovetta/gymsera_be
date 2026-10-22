/**
 * FLOW-04: a rejected host reopens the SAME application (POST /tenants/:id/reapply), edits it and submits again.
 * Before: a rejected tenant could not edit (`submitGymProfile` refuses REJECTED) and could not register again
 * (one tenant per owner), so a rejection was a dead end.
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { createUser, createTenant } = require('../harness/factories');
const { Tenant, PlatformAuditLog } = require('../../src/models/platform');
const { runKycRetentionSweep } = require('../../src/jobs/kyc-retention.sweep');
const { signToken } = require('../../src/utils/jwt.utils');

const API = '/api/v1';
const DOCS = [{ key: 'kyc/x/id-front.png', name: 'id-front.png', type: 'image/png', size: 10 }];
const PLAN = { name: 'Monthly', durationType: 'MONTHLY', durationValue: 1, price: 5000, joiningFee: 0, securityFee: 0, status: 'ACTIVE', isPublic: true };

describe('FLOW-04: re-apply after rejection', () => {
  let app;
  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  const rejectedHost = async (over = {}) => {
    const owner = await createUser({ role: 'GYM_HOST', email: `flow04_${uuidv4().slice(0, 8)}@gymseratest.com` });
    const tenant = await createTenant({
      ownerUserId: owner.id,
      status: 'REJECTED',
      kycStatus: 'REJECTED',
      rejectionReason: 'The ID photo is unreadable',
      rejectedAt: new Date(Date.now() - 100 * 86400000),
      gymName: 'Iron Works',
      address: 'Main Boulevard',
      onboardingStep: 5,
      kycDocumentsJson: DOCS,
      mainBranchDataJson: { name: 'Iron Works', plans: [PLAN] },
      connectionStringEncrypted: null,
      ...over,
    });
    const token = signToken({ sub: owner.id, id: owner.id, email: owner.email, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
    return { owner, tenant, token };
  };
  const reapply = (id, token) => request(app).post(`${API}/tenants/${id}/reapply`).set('Authorization', `Bearer ${token}`).send({});

  test('the owner reopens the same tenant: DRAFT, everything entered is kept, the reason stays visible', async () => {
    const { tenant, token } = await rejectedHost();
    const res = await reapply(tenant.id, token);
    expect(res.status).toBe(200);
    expect(res.body.data.tenant.id).toBe(tenant.id);
    const row = await Tenant.findByPk(tenant.id);
    expect(row.status).toBe('DRAFT');
    expect(row.gymName).toBe('Iron Works');
    expect(row.address).toBe('Main Boulevard');
    expect(row.rejectionReason).toBe('The ID photo is unreadable');
    expect(row.kycStatus).toBe('PENDING');
    expect(await Tenant.count({ where: { ownerUserId: row.ownerUserId } })).toBe(1);
    const audit = await PlatformAuditLog.findAll({ where: { action: 'tenant.reapplied', targetId: tenant.id } });
    expect(audit).toHaveLength(1);
  });

  test('when the retention sweep already removed the KYC files, the host must upload them again', async () => {
    const { tenant, token } = await rejectedHost({ kycDocumentsJson: null });
    expect((await reapply(tenant.id, token)).status).toBe(200);
    expect((await Tenant.findByPk(tenant.id)).kycStatus).toBe('NOT_SUBMITTED');
  });

  test.each(['DRAFT', 'PENDING_REVIEW', 'UNDER_REVIEW', 'ACTIVE'])('a %s application cannot be "reopened": 409 and unchanged', async (status) => {
    const { tenant, token } = await rejectedHost({ status, kycStatus: 'PENDING' });
    const res = await reapply(tenant.id, token);
    expect(res.status).toBe(409);
    expect(res.body.error?.code || res.body.code).toBe('not_rejected');
    expect((await Tenant.findByPk(tenant.id)).status).toBe(status);
  });

  test('another host cannot reopen someone else\'s application', async () => {
    const { tenant } = await rejectedHost();
    const other = await createUser({ role: 'GYM_HOST', email: `flow04_other_${uuidv4().slice(0, 8)}@gymseratest.com` });
    const token = signToken({ sub: other.id, id: other.id, email: other.email, role: 'GYM_HOST', isVerified: true });
    expect((await reapply(tenant.id, token)).status).toBe(404);
    expect((await Tenant.findByPk(tenant.id)).status).toBe('REJECTED');
  });

  test('a body never changes the outcome (the route takes none)', async () => {
    const { tenant, token } = await rejectedHost();
    const res = await request(app).post(`${API}/tenants/${tenant.id}/reapply`).set('Authorization', `Bearer ${token}`).send({ status: 'ACTIVE' });
    expect([200, 422]).toContain(res.status); // log mode today (R-61); never changes the status to the body's value
    expect((await Tenant.findByPk(tenant.id)).status).not.toBe('ACTIVE');
  });

  test('the host can edit the profile, then submit again: PENDING_REVIEW', async () => {
    const { tenant, token } = await rejectedHost();
    expect((await reapply(tenant.id, token)).status).toBe(200);
    const edit = await request(app)
      .post(`${API}/tenants/${tenant.id}/gym-profile`)
      .set('Authorization', `Bearer ${token}`)
      .send({ gymName: 'Iron Works 2' });
    expect(edit.status).toBe(200);
    const fin = await request(app)
      .post(`${API}/tenants/${tenant.id}/finalize`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'PAY_LATER' });
    expect(fin.status).toBe(200);
    const row = await Tenant.findByPk(tenant.id);
    expect(row.status).toBe('PENDING_REVIEW');
    expect(row.gymName).toBe('Iron Works 2');
  });

  test('a reopened application is not swept by the 90-day KYC retention, a still-rejected one is', async () => {
    const reopened = await rejectedHost();
    const stillRejected = await rejectedHost();
    expect((await reapply(reopened.tenant.id, reopened.token)).status).toBe(200);
    const sweep = await runKycRetentionSweep({ dryRun: true });
    const ids = sweep.details.map((d) => d.tenantId);
    expect(ids).toContain(stillRejected.tenant.id);
    expect(ids).not.toContain(reopened.tenant.id);
  });
});
