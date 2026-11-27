/**
 * NEW-303 M3: F7 (no compound `organizationId:businessId` id in the admin API) and F9 (Add Business does not borrow
 * the organization's, or another business's, logo and cover).
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { firstBranchInput } = require('../harness/first-branch-input');
const { GymListing, Tenant, TenantSubscription } = require('../../src/models/platform');

let organizationId;
beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
  organizationId = personaManager.context.tenant1.id;
  await TenantSubscription.update({ branchCount: 20 }, { where: { organizationId } });
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const addBusiness = async (name, extra = {}) => {
  await GymListing.update({ status: 'REJECTED' }, { where: { organizationId, status: 'PENDING' } });
  const res = await asPersona('owner').post('/host/businesses').send({ businessName: name, firstBranch: await firstBranchInput({ branchName: `${name} Site` }), ...extra });
  expect(res.status).toBe(201);
  return res.body.data.business;
};

test('F9: a new business has the logo and cover it was sent, never the organization\'s', async () => {
  await Tenant.update({ logoUrl: 'https://example.test/org-logo.png', coverImageUrl: 'https://example.test/org-cover.png' }, { where: { id: organizationId } });
  const none = await addBusiness('No Images');
  expect(none.logoUrl).toBeNull();
  expect(none.coverImageUrl).toBeNull();
  const own = await addBusiness('Own Images', { logoUrl: 'https://example.test/own-logo.png', coverImageUrl: 'https://example.test/own-cover.png' });
  expect(own).toMatchObject({ logoUrl: 'https://example.test/own-logo.png', coverImageUrl: 'https://example.test/own-cover.png' });
});

test('F7: the organization list holds organizations only; a waiting business is in the review queue and is decided by its own id', async () => {
  const biz = await addBusiness('Waiting Business');
  const list = await asPersona('platformAdmin').get('/admin/organizations?limit=50');
  expect(list.status).toBe(200);
  const ids = list.body.data.organizations.map((o) => o.id);
  expect(ids.every((id) => !String(id).includes(':'))).toBe(true);
  expect(list.body.data.organizations.some((o) => o.isAdditionalOrganization)).toBe(false);
  expect(list.body.data.total).toBe(await Tenant.count());

  const queue = await asPersona('platformAdmin').get('/admin/review-queue');
  expect(queue.body.data.items.find((i) => i.businessId === biz.id)).toMatchObject({ kind: 'BUSINESS', organizationId });

  // an id with a colon is no id any more
  const compound = await asPersona('platformAdmin').post(`/admin/businesses/${organizationId}:${biz.id}/approve`).send({});
  expect([404, 422]).toContain(compound.status);

  const reject = await asPersona('platformAdmin').post(`/admin/businesses/${biz.id}/reject`).send({ reason: 'Not a gym' });
  expect(reject.status).toBe(200);
  expect(await GymListing.findByPk(biz.id)).toMatchObject({ status: 'REJECTED', kycStatus: 'REJECTED', rejectionReason: 'Not a gym' });
});
