/**
 * NEW-103 (found while listing the SEC-06 tier-1 bodies): POST /billing/purchase-intent took `tenantId` from the
 * request body with only `authenticate` in front, so any signed-in user could ask about another tenant's
 * subscription (platform, auto-renew, blocker, and the tenant id echoed as `appAccountToken`). SEC-02: the tenant
 * comes from the login, never from input.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

let personas;
beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
  await startTestServer();
});
afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('POST /billing/purchase-intent', () => {
  test('another tenant\'s id in the body is ignored: the answer is about the caller\'s own tenant', async () => {
    const res = await asPersona('otherTenantOwner').post('/billing/purchase-intent', {
      platform: 'ios',
      tenantId: personas.owner.tenantId,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.appAccountToken).toBe(personas.otherTenantOwner.tenantId);
    expect(res.body.data.appAccountToken).not.toBe(personas.owner.tenantId);
  });

  test('a signed-in user with no tenant gets 404 even if the body names one', async () => {
    const res = await asPersona('member').post('/billing/purchase-intent', {
      platform: 'ios',
      tenantId: personas.owner.tenantId,
    });
    expect(res.status).toBe(404);
  });

  test('the owner still gets the answer for their own tenant', async () => {
    const res = await asPersona('owner').post('/billing/purchase-intent', { platform: 'android' });
    expect(res.status).toBe(200);
    expect(res.body.data.appAccountToken).toBe(personas.owner.tenantId);
  });
});
