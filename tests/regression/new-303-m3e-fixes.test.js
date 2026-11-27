/**
 * NEW-303 M3e (remaining six fixes):
 *  1. G1: GET /admin/review-queue honours `kind` and returns `{ items, page, total }`.
 *  2. G2: GET /admin/organizations/:organizationId returns `organization.businesses` (not `organizations`).
 *  3. J18: GET /discovery/businesses/:businessId returns `business.businessVerified`.
 *  4. G16: inactive organization context returns 409 `organization_not_active`, and ERROR_COPY uses `organization_not_active`.
 *  5. first-business accepts and saves `genderType`, `logoUrl`, `coverImageUrl` (and provisioning carries them to the business).
 *  6. Notifications: `organization_approved` (waiting for proof of premises, deep link `/host/businesses/:id/documents`)
 *     and `business_approved` (deep link `/host/businesses/:id`).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { signToken } = require('../../src/utils/jwt.utils');
const { ERROR_COPY } = require('../../src/constants/error-copy');
const { GymListing, Notification, Tenant, TenantSubscription } = require('../../src/models/platform');
const TenantDbManager = require('../../src/database/TenantDbManager');
const adminService = require('../../src/services/admin.service');

const dbNames = [];
let admin;
let tenant1;
let tenantDb;

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  admin = personaManager.personas.platformAdmin.user;
  tenant1 = personaManager.context.tenant1;
  tenantDb = h.tenant1;
  await TenantSubscription.update({ branchCount: 20 }, { where: { organizationId: tenant1.id } });
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

test('G1: GET /admin/review-queue honours kind and returns page and total', async () => {
  const biz = await factories.createGymListing(tenant1.id, { title: 'Queue Filter Biz', status: 'PENDING' });
  const orgOwner = await factories.createUser({ role: 'GYM_HOST', isHost: true });
  const org = await factories.createTenant({ ownerUserId: orgOwner.id, organizationName: 'Queue Filter Org', status: 'PENDING_REVIEW' });

  const all = await asPersona('platformAdmin').get('/admin/review-queue?page=1&limit=50');
  expect(all.status).toBe(200);
  expect(all.body.data.page).toBe(1);
  expect(all.body.data.total).toBeGreaterThanOrEqual(2);
  expect(all.body.data.items.some((i) => i.kind === 'BUSINESS' && i.businessId === biz.id)).toBe(true);
  expect(all.body.data.items.some((i) => i.kind === 'ORGANIZATION' && i.organizationId === org.id)).toBe(true);

  const onlyBiz = await asPersona('platformAdmin').get('/admin/review-queue?kind=BUSINESS&page=1&limit=1');
  expect(onlyBiz.status).toBe(200);
  expect(onlyBiz.body.data.page).toBe(1);
  expect(onlyBiz.body.data.items).toHaveLength(1);
  expect(onlyBiz.body.data.items.every((i) => i.kind === 'BUSINESS')).toBe(true);

  const onlyOrg = await asPersona('platformAdmin').get('/admin/review-queue?kind=ORGANIZATION&limit=50');
  expect(onlyOrg.status).toBe(200);
  expect(onlyOrg.body.data.items.every((i) => i.kind === 'ORGANIZATION')).toBe(true);
  expect(onlyOrg.body.data.items.some((i) => i.organizationId === org.id)).toBe(true);

  const badKind = await asPersona('platformAdmin').get('/admin/review-queue?kind=UNKNOWN');
  expect(badKind.status).toBe(400);
});

test('G2: GET /admin/organizations/:organizationId exposes organization.businesses', async () => {
  const res = await asPersona('platformAdmin').get(`/admin/organizations/${tenant1.id}`);
  expect(res.status).toBe(200);
  const org = res.body.data.organization;
  expect(Array.isArray(org.businesses)).toBe(true);
  expect(org.organizations).toBeUndefined();
  expect(org.businesses.length).toBeGreaterThanOrEqual(1);
  expect(org.businesses[0]).toMatchObject({
    id: expect.any(String),
    name: expect.any(String),
    status: expect.any(String),
    kycStatus: expect.any(String),
    businessVerified: expect.any(Boolean),
  });
});

test('J18: GET /discovery/businesses/:businessId includes businessVerified', async () => {
  const listing = await GymListing.findOne({ where: { organizationId: tenant1.id, status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
  const branch = await tenantDb.models.Branch.findOne({ where: { businessId: listing.id } });
  await factories.makeBranchLive(tenantDb, branch);
  await listing.update({ kycStatus: 'APPROVED', verifiedAt: null });

  const unverified = await asPersona('anonymous').get(`/discovery/businesses/${listing.id}`);
  expect(unverified.status).toBe(200);
  expect(unverified.body.data.business.businessVerified).toBe(false);

  await listing.update({ verifiedAt: new Date(), verifiedBy: admin.id });
  const verified = await asPersona('anonymous').get(`/discovery/businesses/${listing.id}`);
  expect(verified.status).toBe(200);
  expect(verified.body.data.business.businessVerified).toBe(true);
});

test('G16: ERROR_COPY defines organization_not_active and not tenant_not_active', () => {
  expect(ERROR_COPY.organization_not_active).toBeDefined();
  expect(ERROR_COPY.organization_not_active.en).toBeTruthy();
  expect(ERROR_COPY.tenant_not_active).toBeUndefined();
});

test('first-business accepts and saves genderType, logoUrl, coverImageUrl; notifications use new types and deep links', async () => {
  const user = await factories.createUser({ role: 'GYM_HOST', isHost: true });
  const organizationCode = `test_m3e_fix_${Date.now().toString(36)}`;
  dbNames.push(`gymsera_${organizationCode}`);
  const tenant = await factories.createTenant({
    ownerUserId: user.id,
    organizationCode,
    status: 'DRAFT',
    connectionStringEncrypted: null,
    paymentMethod: 'BANK_TRANSFER',
    cityId: 1,
  });

  const firstBranch = await firstBranchInput({ branchName: 'Main Branch' });
  const res = await hostOf(tenant, user)().post(`/organizations/${tenant.id}/first-business`).send({
    organizationName: 'Iron Guild',
    firstBusinessName: 'Iron Guild Fitness',
    firstBusinessDescription: 'Strength & conditioning',
    genderType: 'FEMALE_ONLY',
    logoUrl: 'https://example.test/guild-logo.png',
    coverImageUrl: 'https://example.test/guild-cover.png',
    firstBranch,
  });
  expect(res.status).toBe(200);
  expect(res.body.data.organization).toMatchObject({
    genderType: 'FEMALE_ONLY',
    logoUrl: 'https://example.test/guild-logo.png',
    coverImageUrl: 'https://example.test/guild-cover.png',
  });

  await tenant.update({ status: 'PENDING_REVIEW', paymentMethod: 'BANK_TRANSFER' });
  await adminService.approveTenant(tenant.id, admin.id, { photosChecked: true });

  await tenant.reload();
  const listing = await GymListing.findOne({ where: { organizationId: tenant.id } });
  expect(listing).toMatchObject({
    genderType: 'FEMALE_ONLY',
    logoUrl: 'https://example.test/guild-logo.png',
    coverImageUrl: 'https://example.test/guild-cover.png',
  });
  const db = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const gym = await db.models.Gym.findByPk(listing.id);
  expect(gym).toMatchObject({
    genderType: 'FEMALE_ONLY',
    logoUrl: 'https://example.test/guild-logo.png',
    coverImageUrl: 'https://example.test/guild-cover.png',
  });

  // Give async notification creation a tick to flush
  await new Promise((r) => setTimeout(r, 150));
  const orgNotif = await Notification.findOne({
    where: { userId: user.id, type: 'organization_approved' },
    order: [['createdAt', 'DESC']],
  });
  expect(orgNotif).not.toBeNull();
  expect(orgNotif.message).toMatch(/proof of premises/i);
  expect(orgNotif.deepLink).toBe(`/host/businesses/${listing.id}/documents`);

  const up = await hostOf(tenant, user)().post(`/host/businesses/${listing.id}/kyc-documents`)
    .field('type', 'PROOF_OF_PREMISES')
    .attach('documents', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'lease.pdf', contentType: 'application/pdf' });
  expect(up.status).toBe(201);

  await adminService.approveBusiness(listing.id, admin.id);
  await new Promise((r) => setTimeout(r, 150));
  const bizNotif = await Notification.findOne({
    where: { userId: user.id, type: 'business_approved' },
    order: [['createdAt', 'DESC']],
  });
  expect(bizNotif).not.toBeNull();
  expect(bizNotif.deepLink).toBe(`/host/businesses/${listing.id}`);
});

