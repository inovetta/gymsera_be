/**
 * NEW-45 (e) — GET/PATCH /gyms/branches/:id use branch.settings at the branch instead of
 * the keys that do not exist in the catalogue (branches.view / branches.manage), which
 * made every non-owner (an Org Admin too) get 404.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');

let app;
let team;

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  const personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const call = (method, path, token, body) => {
  const r = request(app)[method](`/api/v1${path}`).set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId);
  return body ? r.send(body) : r;
};

const PROFILE_WRITES = [
  ['post', '/gyms/profile/logo'],
  ['post', '/gyms/profile/cover'],
  ['post', '/gyms/profile/images'],
  ['delete', '/gyms/profile/images'],
  ['patch', '/gyms/profile'],
];

describe('NEW-45 (e): branch detail and edit use branch.settings at the branch', () => {
  test('Manager of A can read and edit branch A (the old keys made this 403 for every non-owner)', async () => {
    const get = await call('get', `/gyms/branches/${team.branchA.id}`, team.managerA.token);
    expect(get.status).toBe(200);
    expect(get.body.data.branch.id).toBe(team.branchA.id);

    const patch = await call('patch', `/gyms/branches/${team.branchA.id}`, team.managerA.token, { tagline: 'Edited by manager' });
    expect(patch.status).toBe(200);
  });

  // A branch the caller has no right to answers 404, not 403, so ids cannot be probed
  // (the SEC-01 IDOR matrix expects this).
  test('Manager of A cannot read or edit branch B (404)', async () => {
    expect((await call('get', `/gyms/branches/${team.branchB.id}`, team.managerA.token)).status).toBe(404);
    expect((await call('patch', `/gyms/branches/${team.branchB.id}`, team.managerA.token, { tagline: 'nope' })).status).toBe(404);
  });

  test('Front Desk (no branch.settings) cannot read or edit even their own branch (404)', async () => {
    expect((await call('get', `/gyms/branches/${team.branchA.id}`, team.frontDeskOff.token)).status).toBe(404);
    expect((await call('patch', `/gyms/branches/${team.branchA.id}`, team.frontDeskOff.token, { tagline: 'nope' })).status).toBe(404);
  });

  test('the owner is unchanged: 200 at any branch', async () => {
    expect((await call('get', `/gyms/branches/${team.branchB.id}`, team.ownerToken)).status).toBe(200);
  });

  test('an Org Admin (branch.settings organization-wide) can read any branch (was 404 for every non-owner)', async () => {
    expect((await call('get', `/gyms/branches/${team.branchB.id}`, team.orgAdmin.token)).status).toBe(200);
  });
});
