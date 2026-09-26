/**
 * Regression Test: §9.1 updateBranch status bypass
 * Spec §13 / Mobile Doc §9.1
 *
 * Requirement:
 * `PATCH` branch with `status` -> 400 `branch_status_immutable_here`; same value -> 200.
 */
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
  asPersona,
} = require('../harness');

describe('Regression §9.1: updateBranch status bypass', () => {
  let dbHarness;
  let tenant;
  let listing;
  let branch;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    const personas = await setupPersonas(dbHarness);
    tenant = personas.owner.tenantId;

    listing = await factories.createGymListing(tenant, { title: 'Bypass Test Org' });
    branch = await factories.createBranch(dbHarness.tenant1, listing.id, {
      branchName: 'Status Bypass Test Branch',
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('PATCH /gyms/branches/:id with changed status returns 400 branch_status_immutable_here', async () => {
    const res = await asPersona('owner').patch(`/gyms/branches/${branch.id}`, {
      status: 'INACTIVE',
    });

    expect(res.status).toBe(400);
    expect(res.body.code || res.body.error?.code).toBe('branch_status_immutable_here');
  });

  test('PATCH /gyms/branches/:id with identical status returns 200', async () => {
    const res = await asPersona('owner').patch(`/gyms/branches/${branch.id}`, {
      status: 'ACTIVE',
      branchName: 'Updated Branch Name',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
