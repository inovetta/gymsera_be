/**
 * NEW-45 (c) — GET /gyms/members/search needs members.create at one or more branches.
 *
 * Before: any team member could look up any platform user by e-mail (name, phone,
 * status) — a Trainer or a Support account too.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, factories } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam, teamMember } = require('../harness/two-branch-team');

let app;
let team;
let trainer;
let support;
const LOOKUP = 'someone.else@new45.test';

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  const personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  await factories.createUser({ email: LOOKUP, fullName: 'Someone Else', phone: '+923009990000' });
  const base = { tenantDb: dbHarness.tenant1, tenantId: team.tenantId, scopeType: 'BRANCH', branchIds: [team.branchA.id] };
  trainer = await teamMember({ ...base, email: 'trainer@new45s.test', roleKey: 'TRAINER' });
  support = await teamMember({ ...base, email: 'support@new45s.test', roleKey: 'SUPPORT' });
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const search = (token) =>
  request(app)
    .get('/api/v1/gyms/members/search')
    .query({ email: LOOKUP })
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Id', team.tenantId);

describe('NEW-45: member search needs members.create', () => {
  test.each([
    ['Trainer', () => trainer.token],
    ['Support', () => support.token],
  ])('%s gets 403 and no user details', async (_label, token) => {
    const res = await search(token());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('+923009990000');
  });

  test.each([
    ['Front Desk (needs-approval tier)', () => team.frontDeskOff.token],
    ['Branch Manager', () => team.managerA.token],
    ['Org Admin', () => team.orgAdmin.token],
    ['owner', () => team.ownerToken],
  ])('%s can search', async (_label, token) => {
    const res = await search(token());
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(LOOKUP);
  });
});
