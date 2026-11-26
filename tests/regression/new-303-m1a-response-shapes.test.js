const fs = require('fs');
const path = require('path');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');

beforeAll(async () => {
  await setupPersonas(await setupTestDatabases());
  const membershipService = require('../../src/services/membership.service');
  for (const name of ['orgAdmin', 'manager']) {
    await membershipService.syncUserOrgIndex(
      personaManager.context.tenant1.id,
      personaManager.personas[name].user.id,
      personaManager.context.tenant1Db
    );
  }
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

test('G5 business quota reports the organization capacity pool and sequential gate', async () => {
  const res = await asPersona('owner').get('/host/business-quota');
  expect(res.status).toBe(200);
  expect(Object.keys(res.body.data).sort()).toEqual(['blockingBusinessStatus', 'canAddBusiness', 'pool']);
  expect(Object.keys(res.body.data.pool).sort()).toEqual(['free', 'max', 'reserved', 'used']);
  expect(res.body.data.pool).toMatchObject({ max: 10, used: 1, reserved: 0, free: 9 });
  expect(res.body.data.canAddBusiness).toBe(true);
  expect(res.body.data.blockingBusinessStatus).toBeNull();
});

test('G8 capacity audit names businesses and drifted businesses with business ids', async () => {
  const res = await asPersona('platformAdmin').get(`/admin/organizations/${personaManager.context.tenant1.id}/capacity-audit`);
  expect(res.status).toBe(200);
  const { audit } = res.body.data;
  expect(audit.businesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ businessId: personaManager.context.listing1.id })
  ]));
  expect(Array.isArray(audit.driftedBusinesses)).toBe(true);
  expect(Array.isArray(audit.emptyActiveBusinesses)).toBe(true);
  expect(typeof audit.hasEmptyActiveBusinesses).toBe('boolean');
  expect(audit.listings).toBeUndefined();
  expect(audit.driftedListings).toBeUndefined();
});

test('J5 host status uses area for the current organization request', async () => {
  const res = await asPersona('owner').get('/host/status');
  expect(res.status).toBe(200);
  expect(res.body.data).toHaveProperty('area');
  expect(res.body.data.pendingArea).toBeUndefined();
});

test('J7 staff status groups organization scope and branch scope without inventing one business for ORG', async () => {
  const business = await personaManager.context.tenant1Db.models.Gym.findByPk(personaManager.context.listing1.id);
  const org = await asPersona('orgAdmin').get('/me/staff-status');
  expect(org.status).toBe(200);
  expect(org.body.data.isStaff).toBe(true);
  expect(org.body.data.organizations).toHaveLength(1);
  expect(org.body.data.organizations[0]).toMatchObject({
    organizationId: personaManager.context.tenant1.id,
    organizationName: personaManager.context.tenant1.organizationName,
    scopeType: 'ORG', roleKey: 'ORG_ADMIN', branches: [],
  });
  const scoped = await asPersona('manager').get('/me/staff-status');
  expect(scoped.status).toBe(200);
  expect(scoped.body.data.organizations).toHaveLength(1);
  expect(scoped.body.data.organizations[0]).toMatchObject({
    organizationId: personaManager.context.tenant1.id, scopeType: 'BRANCH', roleKey: 'MANAGER',
    branches: [{ branchId: personaManager.context.branch1.id,
      branchName: personaManager.context.branch1.branchName,
      businessId: personaManager.context.listing1.id,
      businessName: business.name }],
  });
  expect(scoped.body.data.branches).toBeUndefined();
});

test('J7 legacy staff invite describes its one branch with organization and business names', async () => {
  const business = await personaManager.context.tenant1Db.models.Gym.findByPk(personaManager.context.listing1.id);
  const { GymStaff } = personaManager.context.tenant1Db.models;
  const invite = await GymStaff.create({
    branchId: personaManager.context.branch1.id,
    userId: personaManager.personas.member.user.id,
    email: personaManager.personas.member.user.email,
    designation: 'Trainer', status: 'pending', employmentStatus: 'ACTIVE',
  });
  const res = await asPersona('member').get(`/staff-invites/${invite.id}?organizationId=${personaManager.context.tenant1.id}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toMatchObject({
    organization: { id: personaManager.context.tenant1.id, name: personaManager.context.tenant1.organizationName },
    scopeType: 'BRANCH', roleKey: 'TRAINER',
    branches: [{ branchId: personaManager.context.branch1.id,
      branchName: personaManager.context.branch1.branchName,
      businessId: personaManager.context.listing1.id,
      businessName: business.name }],
  });
  expect(res.body.data.gym).toBeUndefined();
  expect(res.body.data.branch).toBeUndefined();
});

test('G11 source deep links all use the contract paths', () => {
  const root = path.resolve(__dirname, '../../src');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/deepLink:\s*([`'"])(\/[\s\S]*?)\1/g)) {
          found.push(match[2].replace(/\$\{[^}]+\}/g, '<id>'));
        }
      }
    }
  };
  walk(root);
  const allowed = new Set([
    '/traveler/subscriptions', '/traveler/inbox',
    '/traveler/staff-invite-confirmation?staffId=<id>&organizationId=<id>',
    '/host/subscriptions', '/host/businesses', '/host/businesses/<id>', '/host/businesses/<id>/documents',
    '/host/profile', '/host/branches', '/host/today',
    '/host/devices', '/host/inbox', '/host/branches/<id>/staff', '/host/branches/<id>/staff-requests',
    '/host/operations?tab=subscriptions&filter=PENDING&subscriptionId=<id>',
    '/staff/dashboard', '/admin/organizations/<id>', '/admin/plan-payments', '/notifications',
  ]);
  expect(found.length).toBeGreaterThan(0);
  expect([...new Set(found.filter((url) => !allowed.has(url)))]).toEqual([]);
  expect(found).toContain('/host/operations?tab=subscriptions&filter=PENDING&subscriptionId=<id>');
  expect(found).toContain('/host/branches/<id>/staff-requests');
});
