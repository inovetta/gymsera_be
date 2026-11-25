const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { GymListing, Tenant, TenantSubscription } = require('../../src/models/platform');

let tenantDb;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  tenantDb = h.tenant1;
  await TenantSubscription.update({ branchCount: 20 }, { where: { organizationId: personaManager.context.tenant1.id } });
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const pdf = () => Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const upload = (businessId, type, persona = 'owner') =>
  asPersona(persona).post(`/host/businesses/${businessId}/kyc-documents`)
    .field('type', type).attach('documents', pdf(), { filename: 'doc.pdf', contentType: 'application/pdf' });

const addBusiness = async (name, { fewPhotos = false } = {}) => {
  // One business waits for review at a time (approval_pending); earlier ones are parked as REJECTED.
  await GymListing.update({ status: 'REJECTED' }, { where: { organizationId: personaManager.context.tenant1.id, status: 'PENDING' } });
  const firstBranch = await firstBranchInput({ branchName: `${name} Site` });
  const res = await asPersona('owner').post('/host/businesses').send({ businessName: name, firstBranch });
  expect(res.status).toBe(201);
  const id = res.body.data.business.id;
  if (fewPhotos) { // the submit validator needs 3; an admin photo removal can leave fewer (approval-photos.service)
    const listing = await GymListing.findByPk(id);
    await listing.update({ firstBranchDraft: { ...listing.firstBranchDraft, imagesJson: ['https://example.test/a.png'] } });
  }
  return id;
};

test('D10 documents: type is checked, answers never carry storage keys, only the owner reads them', async () => {
  const id = await addBusiness('Docs Business');
  const bad = await upload(id, 'OWNER_ID');
  expect(bad.status).toBe(422);
  expect(bad.body.code).toBe('invalid_document_type');

  const ok = await upload(id, 'PROOF_OF_PREMISES');
  expect(ok.status).toBe(201);
  expect(ok.body.data.documents).toHaveLength(1);
  expect(Object.keys(ok.body.data.documents[0]).sort()).toEqual(['id', 'rejectionReason', 'reviewedAt', 'status', 'type', 'uploadedAt']);
  expect(ok.body.data.documents[0]).toMatchObject({ type: 'PROOF_OF_PREMISES', status: 'PENDING', reviewedAt: null });

  const list = await asPersona('owner').get(`/host/businesses/${id}/kyc-documents`);
  expect(list.status).toBe(200);
  expect(list.body.data.documents).toHaveLength(1);
  expect(JSON.stringify(list.body)).not.toMatch(/tenants\/|\.pdf|"key"/);

  const stream = await asPersona('owner').get(`/host/businesses/${id}/kyc-documents/${list.body.data.documents[0].id}/stream`);
  expect(stream.status).toBe(200);
  expect(stream.headers['cache-control']).toMatch(/no-store/);

  const listing = await GymListing.findByPk(id);
  expect(listing.kycStatus).toBe('PENDING');
  expect(listing.kycSubmittedAt).toBeTruthy();
  const view = await asPersona('owner').get(`/host/businesses/${id}`);
  expect(JSON.stringify(view.body)).not.toMatch(/kycDocumentsJson|storage/);
  expect(view.body.data.kycDocuments).toHaveLength(1);
});

test('D10 approval needs proof of premises and 3 photos (422 business_requirements_missing), then builds the held branch', async () => {
  const organizationId = personaManager.context.tenant1.id;
  const id = await addBusiness('Gate Business', { fewPhotos: true });
  const missing = await asPersona('platformAdmin').post(`/admin/businesses/${id}/approve`).send({});
  expect(missing.status).toBe(422);
  expect(missing.body.code).toBe('business_requirements_missing');
  expect(missing.body.error.details.missing).toEqual(['PROOF_OF_PREMISES', 'PHOTOS_MIN_3']);

  // a branch cannot be added to a business that is not approved
  const gate = await asPersona('owner').post('/host/branches').send({
    businessId: id, ...(await firstBranchInput({ branchName: 'Too Early' })),
  });
  expect(gate.status).toBe(409);
  expect(gate.body.code).toBe('business_not_approved');

  const ok = await addBusiness('Approvable Business');
  expect((await upload(ok, 'PROOF_OF_PREMISES')).status).toBe(201);
  const before = await tenantDb.models.Branch.count();
  const approved = await asPersona('platformAdmin').post(`/admin/businesses/${ok}/approve`).send({});
  expect(approved.status).toBe(200);
  expect(approved.body.data.business).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED', businessVerified: false, heldFirstBranch: false });
  expect(await tenantDb.models.Branch.count()).toBe(before + 1);
  const listing = await GymListing.findByPk(ok);
  expect(listing.approvedBy).toBeTruthy();
  expect(listing.organizationId).toBe(organizationId);
});

test('D11 verified badge: set by approving the registration, revocable, never needs approval, 422 registration_missing', async () => {
  const id = await addBusiness('Badge Business');
  const none = await asPersona('platformAdmin').post(`/admin/businesses/${id}/verify`).send({});
  expect(none.status).toBe(422);
  expect(none.body.code).toBe('registration_missing');

  const up = await upload(id, 'BUSINESS_REGISTRATION');
  const docId = up.body.data.documents[0].id;
  const docs = await asPersona('platformAdmin').get(`/admin/businesses/${id}/documents`);
  expect(docs.body.data.documents).toHaveLength(1);

  const approvedDoc = await asPersona('platformAdmin').post(`/admin/businesses/${id}/documents/${docId}/approve`).send({});
  expect(approvedDoc.status).toBe(200);
  expect(approvedDoc.body.data.document.status).toBe('APPROVED');
  let listing = await GymListing.findByPk(id);
  expect(listing.verifiedAt).toBeTruthy();
  expect(listing.verifiedBy).toBeTruthy();
  expect(listing.status).toBe('PENDING'); // the badge never approves the business (D11)
  expect((await asPersona('owner').get(`/host/businesses/${id}`)).body.data.businessVerified).toBe(true);

  const revoke = await asPersona('platformAdmin').delete(`/admin/businesses/${id}/verify`);
  expect(revoke.status).toBe(200);
  listing = await GymListing.findByPk(id);
  expect(listing.verifiedAt).toBeNull();
  expect(listing.verifiedBy).toBeNull();

  const again = await asPersona('platformAdmin').post(`/admin/businesses/${id}/verify`).send({});
  expect(again.status).toBe(200);
  const reject = await asPersona('platformAdmin').post(`/admin/businesses/${id}/documents/${docId}/reject`).send({});
  expect(reject.status).toBe(422);
  const rejected = await asPersona('platformAdmin').post(`/admin/businesses/${id}/documents/${docId}/reject`).send({ reason: 'Blurry' });
  expect(rejected.body.data.document).toMatchObject({ status: 'REJECTED', rejectionReason: 'Blurry' });
  expect((await GymListing.findByPk(id)).verifiedAt).toBeNull();
});

test('G1 review queue lists organizations and businesses waiting, with their own ids', async () => {
  const id = await addBusiness('Queue Business');
  const res = await asPersona('platformAdmin').get('/admin/review-queue');
  expect(res.status).toBe(200);
  const item = res.body.data.items.find((i) => i.businessId === id);
  expect(item).toMatchObject({ kind: 'BUSINESS', name: 'Queue Business', status: 'PENDING', kycStatus: 'NOT_SUBMITTED' });
  expect(item.organizationId).toBe(personaManager.context.tenant1.id);
  const org = await Tenant.create({
    ownerUserId: personaManager.personas.owner.user.id, organizationName: 'Waiting Org', status: 'PENDING_REVIEW',
    connectionStringEncrypted: 'PENDING_PROVISIONING', organizationCode: 'ORG-QUEUE001',
  }).catch(() => null);
  if (org) {
    const again = await asPersona('platformAdmin').get('/admin/review-queue');
    const orgItem = again.body.data.items.find((i) => i.kind === 'ORGANIZATION' && i.organizationId === org.id);
    expect(orgItem).toBeTruthy();
    expect(orgItem.businessId).toBeUndefined();
  }
  expect((await asPersona('owner').get('/admin/review-queue')).status).toBe(403);
});

test('§1.4 a business is traveller-visible only when approved, and discovery carries businessVerified', async () => {
  const cache = require('../../src/services/discovery-cache.service');
  const { makeBranchLive } = require('../harness/factories');
  const request = require('supertest');
  const { startTestServer } = require('../harness/test-server');
  const server = await startTestServer();
  const listing = await GymListing.findOne({ where: { organizationId: personaManager.context.tenant1.id, status: 'ACTIVE' } });
  const branch = await tenantDb.models.Branch.findOne({ where: { businessId: listing.id } });
  await makeBranchLive(tenantDb, branch);
  const listed = async () => {
    cache.invalidate();
    const res = await request(server).get('/api/v1/discovery/branches?page=1&limit=50');
    expect(res.status).toBe(200);
    return res.body.data.branches.find((g) => g.id === branch.id);
  };
  expect(await listed()).toBeTruthy();
  await listing.update({ kycStatus: 'PENDING' });
  expect(await listed()).toBeUndefined();
  await listing.update({ kycStatus: 'APPROVED', verifiedAt: null });
  expect((await listed()).businessVerified).toBe(false);
  await listing.update({ verifiedAt: new Date(), verifiedBy: personaManager.personas.platformAdmin.user.id });
  expect((await listed()).businessVerified).toBe(true);
});
