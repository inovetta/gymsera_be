/**
 * Verification for Business `canReceiveBranches` (API contract v2 §3):
 *   - true ONLY when status === 'ACTIVE', kycStatus === 'APPROVED', organization is ACTIVE,
 *     and either the business has its own reserved slot, the org pool has free > 0, or
 *     another ACTIVE business in the org holds a transferable reserved slot (W4).
 *   - false for pending, rejected, unapproved kycStatus, and full-pool cases (including when the
 *     only reserved slot is parked on a PENDING business rather than an ACTIVE donor).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { GymListing, TenantSubscription } = require('../../src/models/platform');

let tenant1;
let tenantDb;
let listing1;

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  tenant1 = personaManager.context.tenant1;
  tenantDb = h.tenant1;
  listing1 = personaManager.context.listing1;
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const setPool = async (max) => TenantSubscription.update({ branchCount: max }, { where: { organizationId: tenant1.id } });

describe('Business.canReceiveBranches', () => {
  test('normal case: ACTIVE + APPROVED business with free pool unit returns canReceiveBranches=true on host and admin endpoints', async () => {
    await setPool(10);

    const listRes = await asPersona('owner').get('/host/businesses');
    expect(listRes.status).toBe(200);
    const bizFromList = listRes.body.data.find((b) => b.id === listing1.id);
    expect(bizFromList.canReceiveBranches).toBe(true);

    const getRes = await asPersona('owner').get(`/host/businesses/${listing1.id}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.canReceiveBranches).toBe(true);

    const patchRes = await asPersona('owner').patch(`/host/businesses/${listing1.id}`).send({ businessName: 'FitZone Alpha' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.canReceiveBranches).toBe(true);

    const adminBiz = await asPersona('platformAdmin').get(`/admin/businesses/${listing1.id}`);
    expect(adminBiz.status).toBe(200);
    expect(adminBiz.body.data.business.canReceiveBranches).toBe(true);

    const adminOrg = await asPersona('platformAdmin').get(`/admin/organizations/${tenant1.id}`);
    expect(adminOrg.status).toBe(200);
    expect(adminOrg.body.data.organization.gymListing.canReceiveBranches).toBe(true);
    expect(adminOrg.body.data.organization.businesses.find((b) => b.id === listing1.id).canReceiveBranches).toBe(true);
  });

  test('pending and rejected businesses return canReceiveBranches=false even when pool has free units', async () => {
    await setPool(10);
    await GymListing.update({ status: 'REJECTED' }, { where: { organizationId: tenant1.id, status: 'PENDING' } });

    const createRes = await asPersona('owner').post('/host/businesses').send({
      businessName: 'Pending Biz',
      firstBranch: await firstBranchInput({ branchName: 'Pending Site' }),
    });
    expect(createRes.status).toBe(201);
    const pendingId = createRes.body.data.business.id;
    expect(createRes.body.data.business.canReceiveBranches).toBe(false);

    const editFirstRes = await asPersona('owner').patch(`/host/businesses/${pendingId}/first-branch`).send({
      branchName: 'Pending Site Updated',
    });
    expect(editFirstRes.status).toBe(200);
    expect(editFirstRes.body.data.business.canReceiveBranches).toBe(false);

    const hostSingle = await asPersona('owner').get(`/host/businesses/${pendingId}`);
    expect(hostSingle.body.data.canReceiveBranches).toBe(false);

    const adminSingle = await asPersona('platformAdmin').get(`/admin/businesses/${pendingId}`);
    expect(adminSingle.body.data.business.canReceiveBranches).toBe(false);

    const rejectRes = await asPersona('platformAdmin').post(`/admin/businesses/${pendingId}/reject`).send({ reason: 'Incomplete' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.data.business).toMatchObject({ id: pendingId, status: 'REJECTED', canReceiveBranches: false });

    const afterReject = await asPersona('owner').get(`/host/businesses/${pendingId}`);
    expect(afterReject.body.data.canReceiveBranches).toBe(false);
  });

  test('full-pool case returns canReceiveBranches=false (and a PENDING reserved slot does not unlock another active business)', async () => {
    const activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
    await GymListing.update({ reservedSlots: 0 }, { where: { organizationId: tenant1.id } });
    await setPool(activeBranches);

    const fullHost = await asPersona('owner').get(`/host/businesses/${listing1.id}`);
    expect(fullHost.body.data.canReceiveBranches).toBe(false);

    const fullAdmin = await asPersona('platformAdmin').get(`/admin/businesses/${listing1.id}`);
    expect(fullAdmin.body.data.business.canReceiveBranches).toBe(false);

    const adminOrg = await asPersona('platformAdmin').get(`/admin/organizations/${tenant1.id}`);
    expect(adminOrg.body.data.organization.gymListing.canReceiveBranches).toBe(false);

    // Reserve 1 slot inside a PENDING business and grow pool by 1 so free === 0 still holds:
    // the PENDING unit cannot be transferred per W4, so listing1 remains false.
    await setPool(activeBranches + 1);
    const pendingRes = await asPersona('owner').post('/host/businesses').send({
      businessName: 'Holds Own Pending Slot',
      firstBranch: await firstBranchInput({ branchName: 'Pending Slot Site' }),
    });
    expect(pendingRes.status).toBe(201);
    const pendingId = pendingRes.body.data.business.id;

    const listWithPendingSlot = await asPersona('owner').get('/host/businesses');
    const byId = Object.fromEntries(listWithPendingSlot.body.data.map((b) => [b.id, b]));
    expect(byId[listing1.id].canReceiveBranches).toBe(false);
    expect(byId[pendingId].canReceiveBranches).toBe(false);

    await asPersona('platformAdmin').post(`/admin/businesses/${pendingId}/reject`).send({ reason: 'Cleanup' });
  });

  test('W4 donor transfer: full free pool returns canReceiveBranches=true when another ACTIVE business holds reservedSlots > 0', async () => {
    const activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
    await GymListing.update({ reservedSlots: 0 }, { where: { organizationId: tenant1.id } });
    const donor = await factories.createGymListing(tenant1.id, {
      name: 'Donor Active Biz',
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      reservedSlots: 1,
    });
    await setPool(activeBranches + 1); // free === 0, donor holds 1 active reserved unit

    const listRes = await asPersona('owner').get('/host/businesses');
    const byId = Object.fromEntries(listRes.body.data.map((b) => [b.id, b]));
    expect(byId[listing1.id].canReceiveBranches).toBe(true);
    expect(byId[donor.id].canReceiveBranches).toBe(true);

    // Unapproved ACTIVE business stays false despite transferable donor unit
    await donor.update({ kycStatus: 'PENDING' });
    const unapprovedRes = await asPersona('owner').get(`/host/businesses/${donor.id}`);
    expect(unapprovedRes.body.data.canReceiveBranches).toBe(false);
  });

  test('approveBusiness sets canReceiveBranches based on post-approval pool capacity and verify/unverify preserve it', async () => {
    const activeBranches = await tenantDb.models.Branch.count({ where: { status: 'ACTIVE' } });
    await GymListing.update({ reservedSlots: 0 }, { where: { organizationId: tenant1.id } });
    await GymListing.update({ status: 'REJECTED' }, { where: { organizationId: tenant1.id, status: 'PENDING' } });
    await setPool(activeBranches + 5);

    const createRes = await asPersona('owner').post('/host/businesses').send({
      businessName: 'Ready To Approve',
      firstBranch: await firstBranchInput({ branchName: 'Approved First Branch' }),
    });
    expect(createRes.status).toBe(201);
    const bizId = createRes.body.data.business.id;
    expect(createRes.body.data.business.canReceiveBranches).toBe(false);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    expect((await asPersona('owner').post(`/host/businesses/${bizId}/kyc-documents`)
      .field('type', 'PROOF_OF_PREMISES').attach('documents', pdf, { filename: 'pop.pdf', contentType: 'application/pdf' })).status).toBe(201);
    expect((await asPersona('owner').post(`/host/businesses/${bizId}/kyc-documents`)
      .field('type', 'BUSINESS_REGISTRATION').attach('documents', pdf, { filename: 'reg.pdf', contentType: 'application/pdf' })).status).toBe(201);

    const approveRes = await asPersona('platformAdmin').post(`/admin/businesses/${bizId}/approve`).send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.business.status).toBe('ACTIVE');
    expect(approveRes.body.data.business.kycStatus).toBe('APPROVED');
    expect(approveRes.body.data.business.canReceiveBranches).toBe(true);

    const verifyRes = await asPersona('platformAdmin').post(`/admin/businesses/${bizId}/verify`).send({});
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.business.canReceiveBranches).toBe(true);

    const unverifyRes = await asPersona('platformAdmin').delete(`/admin/businesses/${bizId}/verify`);
    expect(unverifyRes.status).toBe(200);
    expect(unverifyRes.body.data.business.canReceiveBranches).toBe(true);
  });
});

