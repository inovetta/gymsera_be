/**
 * NEW-114 — a failed branch-quota read must not look like real capacity.
 *
 * Before: branch-quota.service.js caught every error from the tenant database and
 * answered 0 used / 0 active, so the Gyms tab showed "0 of N used" (or "Limit
 * reached") for a gym whose data simply did not load (UX-08: a failed load must not
 * look empty). After: the error reaches the route; /me/bootstrap still turns it into
 * `quota: null`.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');

let personas;

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const ownerOfUnreachableGym = async () => {
  const user = await factories.createUser({ email: 'unreachable@new114.test', role: 'GYM_HOST', isHost: true });
  const tenant = await factories.createTenant({
    ownerUserId: user.id, status: 'ACTIVE', kycStatus: 'APPROVED', connectionStringEncrypted: 'not-a-valid-ciphertext',
  });
  personaManager.personas.Unreachable = {
    user,
    token: signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isHost: true, isVerified: true, tenantId: tenant.id }),
    ownTenantId: tenant.id,
  };
  return tenant;
};

beforeAll(ownerOfUnreachableGym);

describe('NEW-114: branch quota never turns a failure into zeros', () => {
  test('getBranchQuota rejects when the tenant database cannot be reached', async () => {
    const branchQuotaService = require('../../src/services/branch-quota.service');
    const tenantId = personaManager.personas.Unreachable.ownTenantId;
    await expect(branchQuotaService.getBranchQuota(tenantId)).rejects.toThrow();
  });

  test('GET /host/branch-quota answers an error, not "0 used"', async () => {
    const res = await asPersona('Unreachable').get('/host/branch-quota');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

describe('NEW-114: a reachable gym is unchanged', () => {
  test('owner still gets real numbers', async () => {
    const res = await asPersona('owner').get('/host/branch-quota');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ maxBranches: 10, usedBranches: expect.any(Number), activeBranches: expect.any(Number) });
    expect(res.body.data.activeBranches).toBeGreaterThan(0);
  });

  test('bootstrap reports quota null instead of failing', async () => {
    const res = await asPersona('Unreachable').get('/me/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.data.quota).toBeNull();
  });
});
