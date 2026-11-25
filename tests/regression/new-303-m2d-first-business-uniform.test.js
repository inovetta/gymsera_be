/**
 * NEW-303 M2d (owner 2026-11-25, "uniform"): organization approval is identity only; the first business is created
 * PENDING with its first branch held, and the same business approval as Add Business (proof of premises + 3 photos)
 * builds the branch. Admin-created businesses stay APPROVED.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');
const { GymListing } = require('../../src/models/platform');
const TenantDbManager = require('../../src/database/TenantDbManager');

const dbNames = [];
let admin;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  admin = personaManager.personas.platformAdmin.user;
});
afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await stopTestServer();
  await teardownTestDatabases();
});

const pdf = () => Buffer.from('%PDF-1.4\n%%EOF\n');

test('organization approval needs no proof; the first business waits, its approval builds the branch', async () => {
  const organizationCode = `test_m2d_${Date.now().toString(36)}`;
  dbNames.push(`gymsera_${organizationCode}`);
  const tenant = await factories.createTenant({
    organizationCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER', cityId: 1,
    firstBranchDraft: {
      name: 'Main', cityId: 1, plans: [{ name: 'Monthly', price: 3000 }],
      imagesJson: ['https://example.test/1.png', 'https://example.test/2.png', 'https://example.test/3.png'],
    },
  });
  const adminService = require('../../src/services/admin.service');
  await adminService.approveTenant(tenant.id, admin.id); // identity only: no document needed
  await tenant.reload();
  expect(tenant.status).toBe('ACTIVE');
  const db = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);

  const listing = await GymListing.findOne({ where: { organizationId: tenant.id } });
  expect(listing).toMatchObject({ status: 'PENDING', kycStatus: 'NOT_SUBMITTED' });
  expect(listing.firstBranchDraft.imagesJson).toHaveLength(3);
  expect(await db.models.Branch.count()).toBe(0);

  // without proof: 422 with what is missing
  await expect(adminService.approveBusiness(listing.id, admin.id)).rejects.toMatchObject({
    code: 'business_requirements_missing', details: { missing: ['PROOF_OF_PREMISES'] },
  });

  // the host uploads the proof on the business, as for any business
  const token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, organizationId: tenant.id });
  const up = await asPersona('anonymous', { Authorization: `Bearer ${token}` })
    .post(`/host/businesses/${listing.id}/kyc-documents`).field('type', 'PROOF_OF_PREMISES')
    .attach('documents', pdf(), { filename: 'lease.pdf', contentType: 'application/pdf' });
  expect(up.status).toBe(201);

  await adminService.approveBusiness(listing.id, admin.id);
  await listing.reload();
  expect(listing).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED', firstBranchDraft: null });
  expect(await db.models.Branch.count()).toBe(1);
});

test('an administrator-created business stays APPROVED', async () => {
  const bare = await factories.createTenant({ status: 'ACTIVE', cityId: 1 }); // no business yet
  const res = await asPersona('platformAdmin').post(`/admin/organizations/${bare.id}/businesses`).send({ name: 'Admin Made' });
  expect(res.status).toBe(201);
  expect(res.body.data.business).toMatchObject({ status: 'ACTIVE', kycStatus: 'APPROVED' });
});
