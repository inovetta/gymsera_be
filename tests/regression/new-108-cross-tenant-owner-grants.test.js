/**
 * NEW-108 / BUG-16 — a host must never get owner rights in a gym they do not own.
 *
 * Before:
 * - Becoming a host sets the account role GYM_HOST at once, even for a DRAFT tenant
 *   (tenant.service.js registerTenant).
 * - tenantContext accepted a gym where the user is only a traveller (any
 *   UserGymMembership row, a PENDING booking included) as a tenant the user
 *   "belongs" to, so `X-Tenant-Id: <that gym>` was accepted. With no header, the
 *   default-tenant fallback picked that gym by itself when the host's own tenant was
 *   not ACTIVE (membership.service.js resolveDefaultTenantForUser).
 * - hasAllBranches returned true for any req.user.role === 'GYM_HOST' / isHost,
 *   without asking which tenant, so can() handed out ownerGrants(); legacy
 *   authorize('GYM_HOST') and the `role === 'GYM_HOST' || isHost` checks in the
 *   invoices/payments/expenses controllers passed too.
 *
 * Persona: host A owns a DRAFT tenant (unpaid) and has a PENDING booking at gym B
 * (persona tenant1). Every team / approvals / reports / payouts route of gym B must
 * answer 403, and the host must not reach gym B without a header either.
 */
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { buildTwoBranchTeam } = require('../harness/two-branch-team');
const { signToken } = require('../../src/utils/jwt.utils');
const { hasAllBranches } = require('../../src/utils/branchAccess.utils');

let dbHarness;
let personas;
let team;
let hostA;
let hostAToken;
let hostADraftTenant;
let gymBId;
let orgAdminAssignmentId;

beforeAll(async () => {
  dbHarness = await setupTestDatabases();
  personas = await setupPersonas(dbHarness);
  team = await buildTwoBranchTeam(dbHarness, personas);
  gymBId = team.tenantId;
  orgAdminAssignmentId = team.orgAdmin.assignment.id;

  const { Tenant, GymListing, UserGymMembership } = require('../../src/models/platform');

  // Host A: account role GYM_HOST (set by registerTenant), owns a DRAFT tenant.
  hostA = await factories.createUser({ email: 'host-a@new108.test', role: 'GYM_HOST', isHost: true, fullName: 'Host A' });
  hostADraftTenant = await factories.createTenant({
    tenantCode: 'GYM-NEW108A',
    gymName: 'Host A Draft Gym',
    ownerUserId: hostA.id,
    status: 'DRAFT',
    connectionStringEncrypted: 'PENDING_PROVISIONING',
  });

  // Host A, as a traveller, sent a booking request to gym B: a PENDING membership row.
  const listingB = await GymListing.findOne({ where: { tenantId: gymBId } });
  await UserGymMembership.create({
    userId: hostA.id,
    tenantId: gymBId,
    gymListingId: listingB.id,
    subscriptionId: uuidv4(),
    gymName: 'Alpha Fitness Club',
    planName: 'Monthly',
    status: 'PENDING',
  });

  // Another traveller's invoice at gym B: host A must never list it.
  const stranger = await factories.createUser({ email: 'stranger@new108.test', role: 'MEMBER' });
  await dbHarness.tenant1.models.Invoice.create({
    userId: stranger.id,
    branchId: team.branchA.id,
    invoiceNo: 'INV-NEW108-1',
    invoiceType: 'MEMBERSHIP',
    subtotal: 5000,
    totalAmount: 5000,
    status: 'PAID',
  });

  // The token auth.service issues to host A: role GYM_HOST, tenantId = own DRAFT tenant.
  hostAToken = signToken({
    sub: hostA.id,
    id: hostA.id,
    email: hostA.email,
    role: 'GYM_HOST',
    isHost: true,
    isVerified: true,
    tenantId: hostADraftTenant.id,
  });
  personas.hostA = { user: hostA, token: hostAToken };

  // Same host, but gym B is ACTIVE and host A's tenant is unrelated: sanity that the
  // tenant row of gym B is the persona tenant.
  expect((await Tenant.findByPk(gymBId)).ownerUserId).toBe(personas.owner.user.id);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

const asHostA = (headers = {}) => asPersona('hostA', headers);
const atGymB = () => asHostA({ 'X-Tenant-Id': gymBId });

// Runs first: the attack cases below would revoke the ORG_ADMIN on the old code.
describe('NEW-108: real owners, real staff and the traveller path still work', () => {
  test('owner of gym B still lists the team', async () => {
    const res = await asPersona('owner').get('/team');
    expect(res.status).toBe(200);
  });

  test('ORG_ADMIN team member of gym B still lists the team', async () => {
    const { personaManager } = require('../harness/personas');
    personaManager.personas.teamOrgAdmin = { token: team.orgAdmin.token, tenantId: gymBId };
    const res = await asPersona('teamOrgAdmin').get('/team');
    expect(res.status).toBe(200);
  });

  test('other tenant owner is still refused at gym B (404, existence not leaked)', async () => {
    const res = await asPersona('otherTenantOwner', { 'X-Tenant-Id': gymBId }).get('/team');
    expect(res.status).toBe(404);
  });

  test('host A as a traveller can still read their own booking status at gym B', async () => {
    const res = await atGymB().get(`/member/branches/${team.branchA.id}/subscription-status`);
    expect(res.status).toBe(200);
  });
});

describe('NEW-108: GYM_HOST with a PENDING booking at gym B gets 403 on gym B staff routes', () => {
  const cases = [
    ['GET /team', (c) => c.get('/team')],
    ['GET /team/meta/roles', (c) => c.get('/team/meta/roles')],
    ['GET /team/meta/permissions', (c) => c.get('/team/meta/permissions')],
    ['GET /team/:assignmentId', (c) => c.get(`/team/${orgAdminAssignmentId}`)],
    ['POST /team/invites', (c) => c.post('/team/invites', { email: 'attacker-friend@new108.test', fullName: 'Friend', roleKey: 'ORG_ADMIN', scopeType: 'ORG' })],
    ['PUT /team/:assignmentId/permissions', (c) => c.put(`/team/${orgAdminAssignmentId}/permissions`, { overrides: [] })],
    ['PATCH /team/:assignmentId', (c) => c.patch(`/team/${orgAdminAssignmentId}`, { status: 'SUSPENDED' })],
    ['DELETE /team/:assignmentId', (c) => c.delete(`/team/${orgAdminAssignmentId}`)],
    ['GET /approvals', (c) => c.get('/approvals')],
    ['GET /approvals/policies', (c) => c.get('/approvals/policies')],
    ['GET /reports/dashboard', (c) => c.get('/reports/dashboard')],
    ['GET /reports/yearly', (c) => c.get('/reports/yearly')],
    ['GET /host/payouts', (c) => c.get('/host/payouts')],
    ['GET /host/payouts/balance', (c) => c.get('/host/payouts/balance')],
    ['POST /host/payouts', (c) => c.post('/host/payouts', { amount: 1000, branchId: team.branchA.id }).set('Idempotency-Key', uuidv4())],
    ['GET /gyms/staff (legacy authorize GYM_HOST)', (c) => c.get('/gyms/staff')],
    ['GET /gyms/members', (c) => c.get('/gyms/members')],
    ['GET /host/branches', (c) => c.get('/host/branches')],
    ['POST /host/branches', (c) => c.post('/host/branches', { branchName: 'Planted', gymListingId: team.branchA.gymListingId })],
    ['PATCH /host/branches/:id/listing-content', (c) => c.patch(`/host/branches/${team.branchA.id}/listing-content`, { tagline: 'pwned' })],
    ['POST /host/branches/:id/restore', (c) => c.post(`/host/branches/${team.branchA.id}/restore`, {})],
    ['POST /host/listings', (c) => c.post('/host/listings', { gymName: 'Planted Org' })],
  ];

  test.each(cases)('%s with X-Tenant-Id: gym B → 403', async (_name, call) => {
    const res = await call(atGymB());
    expect(res.status).toBe(403);
  });

  test('the orgAdmin assignment at gym B is untouched by the attempts', async () => {
    const assignment = await dbHarness.tenant1.models.RoleAssignment.findByPk(orgAdminAssignmentId);
    expect(assignment.status).toBe('ACTIVE');
    const { StaffInvite } = dbHarness.tenant1.models;
    if (StaffInvite) {
      expect(await StaffInvite.count({ where: { email: 'attacker-friend@new108.test' } })).toBe(0);
    }
  });

  test('GET /invoices at gym B lists only host A\'s own invoices (none), not other travellers\'', async () => {
    const res = await atGymB().get('/invoices');
    expect(res.status).toBe(200);
    const invoices = res.body.data.invoices || [];
    expect(invoices.filter((i) => i.userId !== hostA.id)).toEqual([]);
  });

  test('hasAllBranches is false for a GYM_HOST whose request resolved to a tenant they do not own', async () => {
    const req = {
      user: { id: hostA.id, role: 'GYM_HOST', isHost: true, tenantId: gymBId },
      tenantDb: dbHarness.tenant1,
      tenantId: gymBId,
    };
    expect(await hasAllBranches(req)).toBe(false);
  });
});

describe('NEW-108: without a header the unpaid host is never placed in gym B', () => {
  test('GET /team answers 409 tenant_not_active, not gym B\'s team', async () => {
    const res = await asHostA().get('/team');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tenant_not_active');
    expect(JSON.stringify(res.body)).not.toContain('X-Tenant-Id');
  });

  test('a member route still finds gym B (as a member) without a header', async () => {
    const res = await asHostA().get(`/member/branches/${team.branchA.id}/subscription-status`);
    expect(res.status).toBe(200);
  });

  test('GET /reports/yearly answers 409 tenant_not_active', async () => {
    const res = await asHostA().get('/reports/yearly');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tenant_not_active');
  });
});
