/**
 * NEW-266 (owner 2026-11-16, build 25, R-110): the amenities a host picks in Become a Host are lost.
 *
 * Before: the app kept them in memory only; the server had no place for them on the draft, approval
 * (tenant-provisioning.service.js step 4) built the first branch without them, and POST /host/businesses
 * (another organisation) did not accept them. The live branch showed "No amenities listed."
 *
 * After: the draft first branch keeps `firstBranchDraft.facilitiesJson` (a list of names, checked), approval
 * copies it to the branch's facilitiesJson, and POST /host/businesses passes `facilitiesJson` to the first
 * branch of the new organisation.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');
const { Area } = require('../../src/models/platform');

const dbNames = [];
let admin;
let areaId;

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  admin = personaManager.personas.platformAdmin.user;
  areaId = (await Area.create({ cityId: 1, name: 'NEW-266 Test Area' })).id;
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await stopTestServer();
  await teardownTestDatabases();
});

const AMENITIES = ['Free Wi-Fi', 'Parking', 'Showers'];
const firstBranch = (facilitiesJson = AMENITIES) => ({
  branchName: 'Main', cityId: 1, areaId, address: 'Main Street', latitude: 24.86,
  longitude: 67.01, phone: '+923001234567', facilitiesJson,
  imagesJson: ['https://example.test/1.png', 'https://example.test/2.png', 'https://example.test/3.png'],
  packages: [{ name: 'Monthly', price: 10, durationType: 'MONTHLY', durationValue: 1, isPublic: true }],
});

const draftHost = async () => {
  const user = await factories.createUser({ email: `n266-${Date.now()}@new266.test`, role: 'GYM_HOST', isHost: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
  const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
  return { tenant, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
};

describe('NEW-266: Become a Host keeps the amenities', () => {
  test('a complete first-business submission stores firstBranchDraft.facilitiesJson for resume', async () => {
    const { tenant, as } = await draftHost();
    const saved = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: 'Fitness Brand', firstBusinessName: 'Gym', firstBranch: firstBranch() });
    expect(saved.status).toBe(200);
    await tenant.reload();
    expect(tenant.firstBranchDraft.facilitiesJson).toEqual(AMENITIES);
    expect((await as().get('/organizations/me')).body.data.organization.firstBranchDraft.facilitiesJson).toEqual(AMENITIES);
  });

  test('a list of names only: not a list, a non-text item or an over-long name → 422, nothing saved', async () => {
    const { tenant, as } = await draftHost();
    for (const bad of ['Parking', [{ name: 'x' }], ['x'.repeat(101)]]) {
      const res = await as().post(`/organizations/${tenant.id}/first-business`).send({ organizationName: 'Fitness Brand', firstBusinessName: 'Gym', firstBranch: firstBranch(bad) });
      expect(res.status).toBe(422);
    }
    await tenant.reload();
    expect((tenant.firstBranchDraft || {}).facilitiesJson).toBeUndefined();
  });

  test('approval copies them to the first branch', async () => {
    const organizationCode = `test_n266_${Date.now().toString(36)}`;
    dbNames.push(`gymsera_${organizationCode}`);
    const tenant = await factories.createTenant({
      organizationCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER',
      firstBranchDraft: { branchName: 'Main', packages: [{ name: 'Monthly', price: 3000 }], facilitiesJson: AMENITIES },
    });
    await require('../../src/services/admin.service').approveTenant(tenant.id, admin.id);
    await require('../harness/business-proof').approveFirstBusiness(tenant.id, admin.id); // M2d
    await tenant.reload();
    const db = await require('../../src/database/TenantDbManager').getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await db.models.Branch.findOne();
    expect(branch.facilitiesJson).toEqual(AMENITIES);
  });

  test('POST /host/businesses (another organisation) gives its first branch the amenities', async () => {
    const res = await asPersona('owner').post('/host/businesses').send({
      businessName: `Org 266 ${Date.now()}`, firstBranch: firstBranch(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.branch).toBeNull();
    expect(res.body.data.business.firstBranchDraft.facilitiesJson).toEqual(AMENITIES);
  });
});
