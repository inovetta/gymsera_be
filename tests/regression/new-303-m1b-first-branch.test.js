const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { Tenant, GymListing, CapacityEvent } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');

let tenantDb;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  tenantDb = h.tenant1;
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test('J10/J13 first-business accepts one complete FirstBranch and does not save kycDocumentsJson from the body', async () => {
  const user = await factories.createUser({ role: 'GYM_HOST', isHost: true });
  const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true, organizationId: tenant.id });
  const asHost = () => asPersona('anonymous', { Authorization: `Bearer ${token}` });
  const firstBranch = await firstBranchInput({ branchName: 'First Site', currency: 'USD' });
  const res = await asHost().post(`/organizations/${tenant.id}/first-business`).send({
    organizationName: 'First Host Brand', firstBusinessName: 'First Business',
    firstBusinessDescription: 'A complete first business', firstBranch,
  });
  expect(res.status).toBe(200);
  await tenant.reload();
  expect(tenant.firstBranchDraft).toMatchObject({ branchName: 'First Site', currency: 'USD', imagesJson: firstBranch.imagesJson });
  expect(tenant.kycDocumentsJson).toBeNull();
  const oldField = await asHost().post(`/organizations/${tenant.id}/first-business`).send({
    organizationName: 'First Host Brand', firstBusinessName: 'First Business', firstBranch,
    kycDocumentsJson: ['not-a-business-document'],
  });
  expect(oldField.status).toBe(422); // J10 removes this field from the submitted body
  await tenant.reload();
  expect(tenant.kycDocumentsJson).toBeNull();
});

test('H2/J10 Add Business holds one paid slot and builds the edited branch only on approval', async () => {
  const organizationId = personaManager.context.tenant1.id;
  const beforeBranches = await tenantDb.models.Branch.count();
  const body = { businessName: 'Held Business', firstBranch: await firstBranchInput({ branchName: 'Held Site' }) };
  const created = await asPersona('owner').post('/host/businesses').send(body);
  expect(created.status).toBe(201);
  expect(created.body.data).toMatchObject({ branch: null, heldFirstBranch: true,
    business: { name: 'Held Business', status: 'PENDING', reservedSlots: 1 } });
  const businessId = created.body.data.business.id;
  expect(await tenantDb.models.Branch.count()).toBe(beforeBranches);
  const listing = await GymListing.findByPk(businessId);
  expect(listing.firstBranchDraft).toMatchObject({ branchName: 'Held Site', imagesJson: body.firstBranch.imagesJson });
  expect(await CapacityEvent.count({ where: { organizationId, listingId: businessId, action: 'SLOT_ATTRIBUTED_UPGRADE' } })).toBe(1);

  const edited = await asPersona('owner').patch(`/host/businesses/${businessId}/first-branch`).send({ branchName: 'Edited Site' });
  expect(edited.status).toBe(200);
  expect(edited.body.data.business.firstBranchDraft.branchName).toBe('Edited Site');
  expect(await tenantDb.models.Branch.count()).toBe(beforeBranches);

  // D10: approval needs proof of premises (M2); the photos come with the FirstBranch.
  const proof = await asPersona('owner').post(`/host/businesses/${businessId}/kyc-documents`).field('type', 'PROOF_OF_PREMISES')
    .attach('documents', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'proof.pdf', contentType: 'application/pdf' });
  expect(proof.status).toBe(201);
  const admin = personaManager.personas.platformAdmin.user;
  await require('../../src/services/admin.service').approveTenant(`${organizationId}:${businessId}`, admin.id);
  await listing.reload();
  const branch = await tenantDb.models.Branch.findByPk(listing.primaryBranchId);
  expect(branch).toMatchObject({ businessId, branchName: 'Edited Site', status: 'ACTIVE' });
  expect(listing).toMatchObject({ status: 'ACTIVE', reservedSlots: 0, firstBranchDraft: null });
  expect(await tenantDb.models.Branch.count()).toBe(beforeBranches + 1);
  const tooLate = await asPersona('owner').patch(`/host/businesses/${businessId}/first-branch`).send({ branchName: 'Too Late' });
  expect(tooLate.status).toBe(409);
  expect(tooLate.body.code).toBe('first_branch_already_built');
});

test('J10 Add Business refuses the removed flat branch body before creating a business', async () => {
  const before = await GymListing.count({ where: { organizationId: personaManager.context.tenant1.id } });
  const res = await asPersona('owner').post('/host/businesses').send({
    businessName: 'Old Flat Shape', branchName: 'Flat Site', packages: [{ name: 'Monthly', price: 100 }],
  });
  expect(res.status).toBe(422);
  expect(await GymListing.count({ where: { organizationId: personaManager.context.tenant1.id } })).toBe(before);
});
