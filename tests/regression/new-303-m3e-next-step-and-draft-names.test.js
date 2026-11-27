/**
 * NEW-303 M3e (live-app review, Agent B):
 *  S2  GET /host/status `nextStep`: an approved organization whose first business holds its first branch is told to
 *      upload the proof of premises (with the businessId), then to wait for the business approval; null afterwards.
 *  S3  the first-branch draft stores one set of names, the FirstBranch names (branchName, packages, googlePlaceId,
 *      hours, …); the old second set (name, plans, placeId, hoursJson) is never written.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { signToken } = require('../../src/utils/jwt.utils');
const { GymListing } = require('../../src/models/platform');

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

const hostOf = (tenant, user) => () => asPersona('anonymous', {
  Authorization: `Bearer ${signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true, organizationId: tenant.id })}`,
});

test('S3: Become a Host stores the FirstBranch names only', async () => {
  const user = await factories.createUser({ role: 'GYM_HOST', isHost: true });
  const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
  const firstBranch = await firstBranchInput({ branchName: 'Draft Site', googlePlaceId: 'ChIJ_test_place', hours: undefined });
  delete firstBranch.hours;
  const res = await hostOf(tenant, user)().post(`/organizations/${tenant.id}/first-business`).send({
    organizationName: 'Names Brand', firstBusinessName: 'Names Business', firstBranch,
  });
  expect(res.status).toBe(200);
  await tenant.reload();
  const draft = tenant.firstBranchDraft;
  expect(draft).toMatchObject({ branchName: 'Draft Site', googlePlaceId: 'ChIJ_test_place', packages: firstBranch.packages });
  for (const old of ['name', 'plans', 'placeId', 'hoursJson', 'facilities']) expect(draft).not.toHaveProperty(old);
});

test('S2: nextStep goes upload_proof_of_premises → wait_for_business_approval → null', async () => {
  const user = await factories.createUser({ role: 'GYM_HOST', isHost: true });
  const organizationCode = `test_m3e_${Date.now().toString(36)}`;
  dbNames.push(`gymsera_${organizationCode}`);
  const tenant = await factories.createTenant({
    ownerUserId: user.id, organizationCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER', cityId: 1,
    firstBranchDraft: {
      branchName: 'Main', cityId: 1, packages: [{ name: 'Monthly', price: 3000 }],
      imagesJson: ['https://example.test/1.png', 'https://example.test/2.png', 'https://example.test/3.png'],
    },
  });
  const asHost = hostOf(tenant, user);
  const before = await asHost().get('/host/status');
  expect(before.body.data.nextStep).toBeNull(); // not approved yet

  const adminService = require('../../src/services/admin.service');
  await adminService.approveTenant(tenant.id, admin.id);
  const listing = await GymListing.findOne({ where: { organizationId: tenant.id } });

  const upload = await asHost().get('/host/status');
  expect(upload.status).toBe(200);
  expect(upload.body.data.nextStep).toEqual({ key: 'upload_proof_of_premises', businessId: listing.id });

  const doc = await asHost().post(`/host/businesses/${listing.id}/kyc-documents`).field('type', 'PROOF_OF_PREMISES')
    .attach('documents', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'lease.pdf', contentType: 'application/pdf' });
  expect(doc.status).toBe(201);
  expect((await asHost().get('/host/status')).body.data.nextStep).toEqual({ key: 'wait_for_business_approval', businessId: listing.id });

  await adminService.approveBusiness(listing.id, admin.id);
  expect((await asHost().get('/host/status')).body.data.nextStep).toBeNull();
});
