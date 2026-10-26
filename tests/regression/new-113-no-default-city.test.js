/**
 * NEW-113 — no branch is filed under city id 1 by default.
 *
 * Before: discovery.service.js gave a branch with no city of its own, no listing city
 * and no tenant city the city id 1; tenant-provisioning.service.js created the first
 * listing with city 1 when the tenant had no (or an unknown) city. Such a gym appeared
 * under an unrelated city. After: discovery leaves the city null (the gym is listed,
 * just not under a city filter); approval uses the tenant's city, else the main-branch
 * city from onboarding, else refuses with 422 `city_required` before changing anything.
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

const completeListing = { branchName: 'Main', plans: [{ name: 'Monthly', price: 5000 }] };

const makeHost = async (key, tenantOverrides = {}) => {
  const user = await factories.createUser({ email: `${key.toLowerCase()}@new113.test`, role: 'GYM_HOST', isHost: true });
  const tenant = await factories.createTenant({
    ownerUserId: user.id, gymName: `${key} Gym`, connectionStringEncrypted: 'PENDING_PROVISIONING', ...tenantOverrides,
  });
  return { user, tenant };
};

describe('NEW-113: no branch is filed under city id 1 by default', () => {
  const resolveBranchCityId = (...a) => require('../../src/services/discovery.service').resolveBranchCityId(...a);

  test('branch, then listing, then tenant city; otherwise null', () => {
    expect(resolveBranchCityId({ cityId: 7 }, { cityId: 8 }, { cityId: 9 })).toBe(7);
    expect(resolveBranchCityId({ cityId: null }, { cityId: 8 }, { cityId: 9 })).toBe(8);
    expect(resolveBranchCityId({ cityId: null }, null, { cityId: 9 })).toBe(9);
    expect(resolveBranchCityId({ cityId: null }, null, { cityId: null })).toBeNull();
  });

  test('approval refuses a gym with no known city (422 city_required) and changes nothing', async () => {
    const { tenant } = await makeHost('NoCity', {
      status: 'PENDING_REVIEW',
      cityId: null,
      mainBranchDataJson: { ...completeListing, cityId: null },
    });
    const res = await asPersona('platformAdmin').post(`/admin/tenants/${tenant.id}/approve`).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('city_required');
    const { Tenant } = require('../../src/models/platform');
    expect((await Tenant.findByPk(tenant.id)).status).toBe('PENDING_REVIEW');
  });

  test('an unknown city id on the tenant is not replaced by city 1: the main branch city is used', async () => {
    const { resolveTenantCityId } = require('../../src/services/tenant-provisioning.service');
    const { City } = require('../../src/models/platform');
    const city = await City.create({ name: 'P2 Test City', isActive: true });
    await expect(resolveTenantCityId({ cityId: 987654, mainBranchDataJson: { cityId: city.id } })).resolves.toBe(city.id);
    await expect(resolveTenantCityId({ cityId: 987654, mainBranchDataJson: JSON.stringify({ cityId: 987655 }) })).resolves.toBeNull();
  });
});
