/**
 * Phase 7 P9, NEW-158 / R-84: photo check at CMS approval.
 *
 * Before: POST /admin/tenants/:id/approve took an empty body (`validate.allowBody([])`,
 * admin.routes.js:118) and approved without anyone having looked at the gym's photos; the admin
 * detail (`getTenant`, admin.service.js:266) listed no photo, and a photo on a pending application
 * (`mainBranchDataJson.imagesJson`) could not be removed by an admin. A screenshot of the app's
 * own "Submitted!" screen became a live gym's cover (BUG-30).
 * After: the detail lists every photo the approval would publish (`approvalPhotos`); an admin can
 * remove one (DELETE /admin/tenants/:id/approval-photos, audited); approve answers 422
 * `photos_not_checked` without `photosChecked: true`, and writes who checked into the audit log.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories, getAdminConnection } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

let personas;
const dbNames = [];

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  const { City } = require('../../src/models/platform');
  await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
});

afterAll(async () => {
  const conn = await getAdminConnection();
  for (const db of dbNames) await conn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
  await stopTestServer();
  await teardownTestDatabases();
});

const PHOTOS = ['https://cdn.gymsera.test/a.jpg', 'https://cdn.gymsera.test/screenshot.png'];

const pendingTenant = async (key) => {
  const user = await factories.createUser({ email: `${key}@p9r84.test`, role: 'GYM_HOST', isHost: true });
  const tenantCode = `test_p9r84_${key}_${Date.now().toString(36)}`;
  dbNames.push(`gymsera_${tenantCode}`);
  return factories.createTenant({
    ownerUserId: user.id,
    tenantCode,
    status: 'PENDING_REVIEW',
    connectionStringEncrypted: null,
    paymentMethod: 'BANK_TRANSFER',
    cityId: 1,
    logoUrl: 'https://cdn.gymsera.test/logo.png',
    coverImageUrl: 'https://cdn.gymsera.test/cover.jpg',
    mainBranchDataJson: { name: 'Main', cityId: 1, plans: [{ name: 'Monthly', price: 3000 }], imagesJson: [...PHOTOS] },
  });
};

const auditRows = (action, targetId) =>
  require('../../src/models/platform').PlatformAuditLog.findAll({ where: { action, targetId } });

describe('R-84: the admin sees, can remove and must confirm the photos before approving', () => {
  test('the admin detail lists every photo the approval would publish', async () => {
    const tenant = await pendingTenant('list');
    const res = await asPersona('platformAdmin').get(`/admin/tenants/${tenant.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tenant.approvalPhotos).toEqual([
      { url: 'https://cdn.gymsera.test/logo.png', kind: 'logo' },
      { url: 'https://cdn.gymsera.test/cover.jpg', kind: 'cover' },
      { url: PHOTOS[0], kind: 'gallery' },
      { url: PHOTOS[1], kind: 'gallery' },
    ]);
  });

  test('approve without photosChecked: 422 photos_not_checked, nothing changes', async () => {
    const tenant = await pendingTenant('nocheck');
    const res = await asPersona('platformAdmin').post(`/admin/tenants/${tenant.id}/approve`).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('photos_not_checked');
    await tenant.reload();
    expect(tenant.status).toBe('PENDING_REVIEW');
    expect(tenant.connectionStringEncrypted).toBeNull();
  });

  test('photosChecked must be exactly true', async () => {
    const tenant = await pendingTenant('falsy');
    const res = await asPersona('platformAdmin').post(`/admin/tenants/${tenant.id}/approve`).send({ photosChecked: 'yes' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('photos_not_checked');
  });

  test('removing a photo takes it off the application and is audited; an unknown photo is 404', async () => {
    const tenant = await pendingTenant('remove');
    const res = await asPersona('platformAdmin')
      .delete(`/admin/tenants/${tenant.id}/approval-photos`)
      .send({ imageUrl: PHOTOS[1] });
    expect(res.status).toBe(200);
    await tenant.reload();
    const data = typeof tenant.mainBranchDataJson === 'string' ? JSON.parse(tenant.mainBranchDataJson) : tenant.mainBranchDataJson;
    expect(data.imagesJson).toEqual([PHOTOS[0]]);
    const rows = await auditRows('admin.approval_photo_removed', tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(personas.platformAdmin.user.id);

    const cover = await asPersona('platformAdmin')
      .delete(`/admin/tenants/${tenant.id}/approval-photos`)
      .send({ imageUrl: 'https://cdn.gymsera.test/cover.jpg' });
    expect(cover.status).toBe(200);
    await tenant.reload();
    expect(tenant.coverImageUrl).toBeNull();

    const missing = await asPersona('platformAdmin')
      .delete(`/admin/tenants/${tenant.id}/approval-photos`)
      .send({ imageUrl: 'https://cdn.gymsera.test/nope.jpg' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('photo_not_found');
  });

  test.each(['owner', 'manager', 'member', 'otherTenantOwner'])('%s cannot remove an application photo', async (persona) => {
    const tenant = await pendingTenant(`deny${persona.length}${persona[0]}`);
    const res = await asPersona(persona).delete(`/admin/tenants/${tenant.id}/approval-photos`).send({ imageUrl: PHOTOS[0] });
    expect([401, 403]).toContain(res.status);
    await tenant.reload();
    const data = typeof tenant.mainBranchDataJson === 'string' ? JSON.parse(tenant.mainBranchDataJson) : tenant.mainBranchDataJson;
    expect(data.imagesJson).toEqual(PHOTOS);
  });

  test('approve with photosChecked: true approves and records who checked how many photos', async () => {
    const tenant = await pendingTenant('ok');
    const res = await asPersona('platformAdmin').post(`/admin/tenants/${tenant.id}/approve`).send({ photosChecked: true });
    expect(res.status).toBe(200);
    await tenant.reload();
    expect(tenant.status).toBe('ACTIVE');
    const rows = await auditRows('admin.approval_photos_checked', tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(personas.platformAdmin.user.id);
    expect(rows[0].details).toMatchObject({ photoCount: 4 });
  });
});
