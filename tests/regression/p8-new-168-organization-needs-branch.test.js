/**
 * Phase 7 P8, NEW-168 (P3): an organization is never created empty.
 *
 * Before: `POST /host/listings` with `branchSource: 'none'` created an organization with no
 * branch and no reserved slot (host.controller.js createListing). It existed for "create, then
 * move a branch in"; P5b removed moving (R-81), so 'none' only left an empty organization behind
 * (CAP-07: an organization is never empty).
 * Now: 422 organization_needs_branch, nothing created. 'new' and 'reserve' are unchanged.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { GymListing } = require('../../src/models/platform');
const { ERROR_COPY: errorCopy } = require('../../src/constants/error-copy');

describe('NEW-168: no organization without a branch', () => {
  let personas;

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test("branchSource 'none': 422 organization_needs_branch and no organization is created", async () => {
    const before = await GymListing.count({ where: { tenantId: personas.owner.tenantId } });
    const res = await asPersona('owner').post('/host/listings', { gymName: 'Empty Org', branchSource: 'none', cityId: 1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('organization_needs_branch');
    expect(await GymListing.count({ where: { tenantId: personas.owner.tenantId } })).toBe(before);
  });

  test('the code has user-facing copy in every language', () => {
    expect(errorCopy.organization_needs_branch).toMatchObject({
      en: expect.any(String), ur: expect.any(String), ar: expect.any(String),
    });
  });
});
