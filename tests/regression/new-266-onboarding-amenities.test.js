/**
 * NEW-266 (owner 2026-11-16, build 25, R-110): the amenities a host picks in Become a Host are lost.
 *
 * Before: the app kept them in memory only; the server had no place for them on the draft, approval
 * (tenant-provisioning.service.js step 4) built the first branch without them, and POST /host/listings
 * (another organisation) did not accept them. The live branch showed "No amenities listed."
 *
 * After: the draft first branch keeps `mainBranchData.facilitiesJson` (a list of names, checked), approval
 * copies it to the branch's facilitiesJson, and POST /host/listings passes `facilitiesJson` to the first
 * branch of the new organisation.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');

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

const AMENITIES = ['Free Wi-Fi', 'Parking', 'Showers'];

const draftHost = async () => {
  const user = await factories.createUser({ email: `n266-${Date.now()}@new266.test`, role: 'GYM_HOST', isHost: true });
  const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true });
  const tenant = await factories.createTenant({ ownerUserId: user.id, status: 'DRAFT', connectionStringEncrypted: 'PENDING_PROVISIONING' });
  return { tenant, as: () => asPersona('anonymous', { Authorization: `Bearer ${token}` }) };
};

describe('NEW-266: Become a Host keeps the amenities', () => {
  test('gym-profile stores mainBranchData.facilitiesJson; a later save without it keeps it', async () => {
    const { tenant, as } = await draftHost();
    const saved = await as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { facilitiesJson: AMENITIES } });
    expect(saved.status).toBe(200);
    await tenant.reload();
    expect(tenant.mainBranchDataJson.facilitiesJson).toEqual(AMENITIES);
    // The plans step sends its own fields only: the amenities stay.
    await as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { plans: [{ name: 'Monthly', price: 10 }] } });
    await tenant.reload();
    expect(tenant.mainBranchDataJson.facilitiesJson).toEqual(AMENITIES);
    // GET /tenants/me returns them for resume.
    expect((await as().get('/tenants/me')).body.data.tenant.mainBranchDataJson.facilitiesJson).toEqual(AMENITIES);
  });

  test('a list of names only: not a list, a non-text item or an over-long name → 422, nothing saved', async () => {
    const { tenant, as } = await draftHost();
    for (const bad of ['Parking', [{ name: 'x' }], ['x'.repeat(101)]]) {
      const res = await as().post(`/tenants/${tenant.id}/gym-profile`).send({ gymName: 'G', mainBranchData: { facilitiesJson: bad } });
      expect(res.status).toBe(422);
    }
    await tenant.reload();
    expect((tenant.mainBranchDataJson || {}).facilitiesJson).toBeUndefined();
  });

  test('approval copies them to the first branch', async () => {
    const tenantCode = `test_n266_${Date.now().toString(36)}`;
    dbNames.push(`gymsera_${tenantCode}`);
    const tenant = await factories.createTenant({
      tenantCode, status: 'PENDING_REVIEW', connectionStringEncrypted: null, paymentMethod: 'BANK_TRANSFER',
      mainBranchDataJson: { name: 'Main', plans: [{ name: 'Monthly', price: 3000 }], facilitiesJson: AMENITIES },
    });
    await require('../../src/services/admin.service').approveTenant(tenant.id, admin.id);
    await tenant.reload();
    const db = await require('../../src/database/TenantDbManager').getConnection(tenant.id, tenant.connectionStringEncrypted);
    const branch = await db.models.Branch.findOne();
    expect(branch.facilitiesJson).toEqual(AMENITIES);
  });

  test('POST /host/listings (another organisation) gives its first branch the amenities', async () => {
    const res = await asPersona('owner').post('/host/listings').send({
      gymName: `Org 266 ${Date.now()}`, facilitiesJson: AMENITIES, packages: [{ name: 'Monthly', price: 50 }],
    });
    expect(res.status).toBe(201);
    const branch = await personaManager.context.tenant1Db.models.Branch.findByPk(res.body.data.branch.id);
    expect(branch.facilitiesJson).toEqual(AMENITIES);
  });
});
