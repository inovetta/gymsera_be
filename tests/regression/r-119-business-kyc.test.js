/**
 * R-119 D10 / D11 (NEW-303d): business documents, approval requirements and the verified badge.
 *  - POST /host/listings/:id/kyc-documents: business types only; the organization's owner (others 404);
 *    PENDING on first upload; GET lists them without storage keys.
 *  - Approval of a business: 422 business_requirements_missing without proof of premises or 3 photos;
 *    approved without a registration document (registration optional).
 *  - Verified badge: POST /admin/listings/:id/verify needs a registration document (422 otherwise); sets
 *    businessVerified on host listings; DELETE revokes; audited; a business is fine without it.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { personaManager } = require('../harness/personas');
const { GymListing, PlatformAuditLog } = require('../../src/models/platform');
const adminService = require('../../src/services/admin.service');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

describe('R-119 business KYC and the verified badge', () => {
  let tenantId; let adminId; let listing;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    tenantId = personaManager.personas.owner.tenantId;
    adminId = personaManager.personas.platformAdmin.user.id;
    listing = await factories.createGymListing(tenantId, { title: `R119 KYC ${Date.now()}`, status: 'PENDING', reservedSlots: 0 });
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  const upload = (persona, id, documentType) =>
    asPersona(persona).post(`/host/listings/${id}/kyc-documents`).field('documentType', documentType).attach('documents', PDF, { filename: 'doc.pdf', contentType: 'application/pdf' });

  test('upload: business types only; owner only (others 404); first upload makes the business PENDING review', async () => {
    expect((await upload('owner', listing.id, 'OWNER_ID')).status).toBe(422);
    expect((await upload('manager', listing.id, 'PROOF_OF_PREMISES')).status).toBe(404);
    const res = await upload('owner', listing.id, 'PROOF_OF_PREMISES');
    expect(res.status).toBe(201);
    expect(res.body.data.documents[0]).toMatchObject({ documentType: 'PROOF_OF_PREMISES' });
    expect(res.body.data.documents[0].key).toBeUndefined();
    await listing.reload();
    expect(listing.kycStatus).toBe('PENDING');
    expect(listing.kycSubmittedAt).not.toBeNull();
    const list = await asPersona('owner').get(`/host/listings/${listing.id}/kyc-documents`);
    expect(list.body.data.documents).toHaveLength(1);
  });

  test('approval: 3 photos still missing → 422 with the list; with them, approved without a registration', async () => {
    await expect(adminService.approveTenant(`${tenantId}:${listing.id}`, adminId, { photosChecked: true }))
      .rejects.toMatchObject({ statusCode: 422, code: 'business_requirements_missing', details: { missing: ['PHOTOS_MIN_3'] } });
    await listing.update({ coverImageUrl: 'https://img.test/a.jpg', imagesJson: ['https://img.test/b.jpg', 'https://img.test/c.jpg'] });
    await adminService.approveTenant(`${tenantId}:${listing.id}`, adminId, { photosChecked: true });
    await listing.reload();
    expect(listing).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED', approvedBy: adminId, verifiedAt: null });
  });

  test('host listings: the business is visible-ready without the badge; fields of §2.1, no storage keys', async () => {
    const res = await asPersona('owner').get('/host/listings');
    const row = res.body.data.find((l) => l.id === listing.id);
    expect(row).toMatchObject({ kycStatus: 'APPROVED', businessVerified: false, canReceiveBranches: true, heldFirstBranch: false, missingForApproval: [] });
    expect(row.kycDocumentsJson).toBeUndefined();
    expect(row.kycDocuments[0].key).toBeUndefined();
  });

  test('verify needs a registration document (422); then the badge appears; revoke removes it; both audited', async () => {
    const admin = () => asPersona('platformAdmin');
    const refused = await admin().post(`/admin/listings/${listing.id}/verify`).send({});
    expect([refused.status, refused.body.code]).toEqual([422, 'registration_missing']);
    expect((await asPersona('owner').post(`/admin/listings/${listing.id}/verify`).send({})).status).toBe(403);

    expect((await upload('owner', listing.id, 'BUSINESS_REGISTRATION')).status).toBe(201);
    const ok = await admin().post(`/admin/listings/${listing.id}/verify`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ businessVerified: true });
    let row = (await asPersona('owner').get(`/host/listings/${listing.id}`)).body.data;
    expect(row.businessVerified).toBe(true);

    const off = await admin().delete(`/admin/listings/${listing.id}/verify`).send({});
    expect(off.status).toBe(200);
    row = (await asPersona('owner').get(`/host/listings/${listing.id}`)).body.data;
    expect(row.businessVerified).toBe(false);
    await listing.reload();
    expect(listing.verifiedBy).toBeNull();
    expect(await PlatformAuditLog.count({ where: { targetId: listing.id, action: ['BUSINESS_VERIFIED', 'BUSINESS_UNVERIFIED'] } })).toBe(2);
  });

  test('a business that is already ACTIVE re-approves without the requirements (old data stays approvable)', async () => {
    const old = await factories.createGymListing(tenantId, { title: `R119 Old ${Date.now()}`, status: 'ACTIVE', reservedSlots: 0 });
    await adminService.approveTenant(`${tenantId}:${old.id}`, adminId, { photosChecked: true });
    expect((await GymListing.findByPk(old.id)).status).toBe('ACTIVE');
  });
});
