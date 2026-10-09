/**
 * NEW-45 (b) — GET /gyms/profile shows the payout bank details only to someone who
 * holds payouts.bank.manage (the owner). Everyone else gets the profile without them.
 *
 * Before: every team member received paymentDetailsJson (bank account) with the profile.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, setupPersonas } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');

let app;
let team;
const BANK = { bankName: 'Placeholder Bank', accountTitle: 'Placeholder Gym', accountNumber: '0000-PLACEHOLDER' };

beforeAll(async () => {
  const dbHarness = await setupTestDatabases();
  const personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  const { Tenant } = require('../../src/models/platform');
  await Tenant.update({ paymentDetailsJson: BANK }, { where: { id: team.tenantId } });
  app = await startTestServer();
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const profile = (token) =>
  request(app).get('/api/v1/gyms/profile').set('Authorization', `Bearer ${token}`).set('X-Tenant-Id', team.tenantId);

describe('NEW-45: bank details on GET /gyms/profile', () => {
  test.each([
    ['Front Desk', () => team.frontDeskOff.token],
    ['Branch Manager', () => team.managerA.token],
    ['Org Admin', () => team.orgAdmin.token],
  ])('%s gets the profile without paymentDetailsJson', async (_label, token) => {
    const res = await profile(token());
    expect(res.status).toBe(200);
    expect(res.body.data.gym).toBeTruthy();
    expect(res.body.data.gym).not.toHaveProperty('paymentDetailsJson');
    expect(JSON.stringify(res.body)).not.toContain('0000-PLACEHOLDER');
  });

  test('the owner still gets the bank details', async () => {
    const res = await profile(team.ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.gym.paymentDetailsJson).toEqual(BANK);
  });
});
