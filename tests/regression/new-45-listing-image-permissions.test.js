/**
 * NEW-45 (d) — the profile routes and PATCH /gyms/profile need listing.manage
 * (organization-wide); the branch image routes need branch.settings at the branch.
 *
 * Image routes are called with no file: a request that gets past the permission check
 * answers 422 ("image required"), so nothing is stored and 403 is the only refusal.
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

describe('NEW-45 (d): profile writes need listing.manage, organization-wide', () => {
  test.each(PROFILE_WRITES)('Front Desk: %s %s → 403', async (method, path) => {
    const res = await call(method, path, team.frontDeskOff.token, method === 'patch' ? { description: 'x' } : undefined);
    expect(res.status).toBe(403);
  });

  test.each(PROFILE_WRITES)('Branch Manager (no listing.manage): %s %s → 403', async (method, path) => {
    const res = await call(method, path, team.managerA.token, method === 'patch' ? { description: 'x' } : undefined);
    expect(res.status).toBe(403);
  });

  test('Org Admin (listing.manage) and the owner get past the check on PATCH /gyms/profile', async () => {
    for (const token of [team.orgAdmin.token, team.ownerToken]) {
      const res = await call('patch', '/gyms/profile', token, { description: 'Updated by the NEW-45 test' });
      expect(res.status).toBe(200);
    }
  });

  test('Org Admin and the owner get past the check on the image routes (422: no file, nothing stored)', async () => {
    for (const token of [team.orgAdmin.token, team.ownerToken]) {
      expect((await call('post', '/gyms/profile/logo', token)).status).toBe(422);
      expect((await call('delete', '/gyms/profile/images', token, {})).status).toBe(422);
    }
  });
});

describe('NEW-45 (d): branch image routes need branch.settings at that branch', () => {
  test('Front Desk at A: 403 on both methods', async () => {
    expect((await call('post', `/gyms/branches/${team.branchA.id}/images`, team.frontDeskOff.token)).status).toBe(403);
    expect((await call('delete', `/gyms/branches/${team.branchA.id}/images`, team.frontDeskOff.token, {})).status).toBe(403);
  });

  test('Manager of A: past the check at A, 403 at B', async () => {
    expect((await call('post', `/gyms/branches/${team.branchA.id}/images`, team.managerA.token)).status).toBe(422);
    expect((await call('post', `/gyms/branches/${team.branchB.id}/images`, team.managerA.token)).status).toBe(403);
    expect((await call('delete', `/gyms/branches/${team.branchB.id}/images`, team.managerA.token, {})).status).toBe(403);
  });

  test('owner: past the check', async () => {
    expect((await call('post', `/gyms/branches/${team.branchB.id}/images`, team.ownerToken)).status).toBe(422);
  });
});
