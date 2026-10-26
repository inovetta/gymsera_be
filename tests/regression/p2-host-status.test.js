/**
 * Phase 7 P2 — one source of truth for host status and plan
 * (BUG-10, BUG-11, BUG-12, BUG-13, BUG-18, BUG-24; owner decision R-75).
 *
 * Before:
 * - No server field said where a host stands. Each host tab guessed from
 *   /host/today-summary "state" A/B/C, which reads the JWT's tenantId: a token
 *   issued before the traveller became a host (tenantId null) answered "A" (DRAFT)
 *   for a host already under review (host.controller.js getTodaySummary).
 * - Nothing said "payment due", so the Gyms tab told an unpaid (DRAFT) host
 *   "waiting for admin approval" (BUG-12).
 * - When the tenant database could not be reached, today-summary answered
 *   state "B" + APPROVED, which the app drew as a full dashboard of zeros (BUG-11).
 * - The plan tier name lived only in the app (and Host Profile printed "Growth Plan"
 *   for everyone, BUG-24).
 *
 * After: host-status.service.js derives DRAFT / AWAITING_PAYMENT / PENDING_REVIEW /
 * APPROVED / REJECTED / SUSPENDED (+ NONE, CLOSED) from the owned tenant, its
 * subscription row and its review data, and GET /host/status, GET /me/bootstrap and
 * GET /host/today-summary all return it.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona, factories } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { personaManager } = require('../harness/personas');
const { signToken } = require('../../src/utils/jwt.utils');
// Required lazily so the route cases also run (red) against code that has no such module yet.
const deriveHostStatus = (...a) => require('../../src/services/host-status.service').deriveHostStatus(...a);
const tierForBranchCount = (n) => require('../../src/constants/plan-tiers').tierForBranchCount(n);
const planTiers = () => require('../../src/constants/plan-tiers').PLAN_TIERS;

const completeListing = { branchName: 'Main', plans: [{ name: 'Monthly', price: 5000 }] };

let personas;

const hostToken = (user, overrides = {}) =>
  signToken({ sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isHost: true, isVerified: true, ...overrides });

/** A host who owns one tenant in `status`, as a persona named `key`. */
const makeHost = async (key, tenantOverrides = {}, tokenOverrides = {}) => {
  const user = await factories.createUser({ email: `${key.toLowerCase()}@p2.test`, role: 'GYM_HOST', isHost: true });
  const tenant = await factories.createTenant({
    ownerUserId: user.id,
    gymName: `${key} Gym`,
    connectionStringEncrypted: 'PENDING_PROVISIONING',
    ...tenantOverrides,
  });
  const token = hostToken(user, { tenantId: tenant.id, ...tokenOverrides });
  // Not `tenantId`: the harness would send it as X-Tenant-Id, and host screens send none.
  personaManager.personas[key] = { user, token, ownTenantId: tenant.id };
  return { user, tenant };
};

beforeAll(async () => {
  const h = await setupTestDatabases();
  personas = await setupPersonas(h);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('BUG-24: one plan tier table', () => {
  test('branch count to tier name (1 = Starter, never Growth)', () => {
    expect(tierForBranchCount(1)).toMatchObject({ key: 'STARTER', name: 'Starter' });
    expect(tierForBranchCount(2).name).toBe('Professional');
    expect(tierForBranchCount(4).name).toBe('Professional');
    expect(tierForBranchCount(5).name).toBe('Growth');
    expect(tierForBranchCount(7).name).toBe('Growth');
    expect(tierForBranchCount(8).name).toBe('Scale');
    expect(tierForBranchCount(50).name).toBe('Scale');
    expect(tierForBranchCount(0)).toBeNull();
    expect(tierForBranchCount(null)).toBeNull();
  });

  test('the table is JSON-safe (served to clients as is)', () => {
    expect(JSON.parse(JSON.stringify(planTiers()))).toEqual(planTiers());
  });
});

describe('deriveHostStatus: every transition', () => {
  const tenant = (o = {}) => ({
    id: 't1', gymName: 'G', businessName: 'B', status: 'DRAFT', kycStatus: 'NOT_SUBMITTED',
    mainBranchDataJson: null, paymentMethod: null, rejectionReason: null, ...o,
  });
  const paidSub = (o = {}) => ({ status: 'ACTIVE', paymentStatus: 'PAID', branchCount: 1, billingCycle: 'MONTHLY', platform: 'IOS', ...o });

  test('no tenant: NONE, next action BECOME_HOST', () => {
    expect(deriveHostStatus({ tenant: null })).toMatchObject({ status: 'NONE', nextAction: 'BECOME_HOST', plan: null });
  });

  test('DRAFT, listing not finished: DRAFT / COMPLETE_LISTING', () => {
    const s = deriveHostStatus({ tenant: tenant() });
    expect(s).toMatchObject({ status: 'DRAFT', nextAction: 'COMPLETE_LISTING', listingComplete: false, applicationSubmitted: false });
    expect(s.payment.done).toBe(false);
  });

  test('DRAFT, listing done, not paid: AWAITING_PAYMENT / CHOOSE_PLAN, no plan label', () => {
    const s = deriveHostStatus({ tenant: tenant({ mainBranchDataJson: completeListing }) });
    expect(s).toMatchObject({ status: 'AWAITING_PAYMENT', nextAction: 'CHOOSE_PLAN', listingComplete: true, plan: null });
    expect(s.payment).toMatchObject({ done: false, entitled: false });
  });

  test('mainBranchDataJson stored as a JSON string still counts', () => {
    const s = deriveHostStatus({ tenant: tenant({ mainBranchDataJson: JSON.stringify(completeListing) }) });
    expect(s.status).toBe('AWAITING_PAYMENT');
  });

  test('DRAFT, paid in the store but not submitted: DRAFT / SUBMIT_APPLICATION', () => {
    const s = deriveHostStatus({ tenant: tenant({ mainBranchDataJson: completeListing }), entitledSub: paidSub() });
    expect(s).toMatchObject({ status: 'DRAFT', nextAction: 'SUBMIT_APPLICATION' });
    expect(s.payment.done).toBe(true);
    expect(s.plan).toMatchObject({ tierName: 'Starter', branchCount: 1 });
  });

  test.each(['PENDING_REVIEW', 'UNDER_REVIEW', 'APPROVED'])('%s: PENDING_REVIEW / WAIT_FOR_REVIEW', (st) => {
    const s = deriveHostStatus({ tenant: tenant({ status: st, kycStatus: 'PENDING' }), entitledSub: paidSub() });
    expect(s).toMatchObject({ status: 'PENDING_REVIEW', nextAction: 'WAIT_FOR_REVIEW', applicationSubmitted: true });
    expect(s.verification).toEqual({ status: 'PENDING', verified: false });
  });

  test('pay later under review: payment not done, method PAY_LATER', () => {
    const s = deriveHostStatus({ tenant: tenant({ status: 'PENDING_REVIEW', paymentMethod: 'PAY_LATER' }) });
    expect(s.status).toBe('PENDING_REVIEW');
    expect(s.payment).toMatchObject({ done: false, entitled: false, method: 'PAY_LATER' });
    expect(s.plan).toBeNull();
  });

  test('REJECTED: reason passed through, FIX_AND_RESUBMIT', () => {
    const s = deriveHostStatus({ tenant: tenant({ status: 'REJECTED', kycStatus: 'REJECTED', rejectionReason: 'Photos unclear' }) });
    expect(s).toMatchObject({ status: 'REJECTED', nextAction: 'FIX_AND_RESUBMIT', rejectionReason: 'Photos unclear' });
  });

  test('ACTIVE and paid: APPROVED, verified, plan label from the branch count', () => {
    const s = deriveHostStatus({ tenant: tenant({ status: 'ACTIVE', kycStatus: 'APPROVED' }), entitledSub: paidSub({ branchCount: 3 }) });
    expect(s).toMatchObject({ status: 'APPROVED', nextAction: 'NONE' });
    expect(s.verification).toEqual({ status: 'APPROVED', verified: true });
    expect(s.plan).toMatchObject({ tierKey: 'PROFESSIONAL', tierName: 'Professional', branchCount: 3 });
  });

  test('ACTIVE in a pay-later grace plan: entitled, not paid, no plan label, PAY_SUBSCRIPTION', () => {
    const s = deriveHostStatus({
      tenant: tenant({ status: 'ACTIVE', kycStatus: 'APPROVED', paymentMethod: 'PAY_LATER' }),
      entitledSub: paidSub({ status: 'GRACE', paymentStatus: 'PENDING', platform: 'MANUAL' }),
    });
    expect(s).toMatchObject({ status: 'APPROVED', nextAction: 'PAY_SUBSCRIPTION', plan: null });
    expect(s.payment).toMatchObject({ done: false, entitled: true });
  });

  test('ACTIVE with no entitling plan (lapsed): APPROVED / CHOOSE_PLAN', () => {
    const s = deriveHostStatus({ tenant: tenant({ status: 'ACTIVE', kycStatus: 'APPROVED' }) });
    expect(s).toMatchObject({ status: 'APPROVED', nextAction: 'CHOOSE_PLAN', plan: null });
  });

  test('SUSPENDED: CONTACT_SUPPORT', () => {
    const s = deriveHostStatus({ tenant: tenant({ status: 'SUSPENDED', kycStatus: 'APPROVED' }), entitledSub: paidSub() });
    expect(s).toMatchObject({ status: 'SUSPENDED', nextAction: 'CONTACT_SUPPORT' });
  });

  test.each(['PENDING_DELETION', 'DELETED'])('%s: CLOSED', (st) => {
    expect(deriveHostStatus({ tenant: tenant({ status: st }) })).toMatchObject({ status: 'CLOSED', nextAction: 'NONE' });
  });

  test('a legacy package plan is labelled by its branch allowance', () => {
    const s = deriveHostStatus({
      tenant: tenant({ status: 'ACTIVE', kycStatus: 'APPROVED' }),
      entitledSub: paidSub({ branchCount: null, package: { maxBranches: 1 } }),
    });
    expect(s.plan).toMatchObject({ tierName: 'Starter', branchCount: 1 });
  });
});

describe('GET /host/status', () => {
  test('anonymous: 401', async () => {
    expect((await asPersona('anonymous').get('/host/status')).status).toBe(401);
  });

  test('a traveller who is not a host: NONE', async () => {
    const res = await asPersona('member').get('/host/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'NONE', nextAction: 'BECOME_HOST' });
  });

  test('unpaid host with a finished listing: AWAITING_PAYMENT (BUG-12, not "under review")', async () => {
    await makeHost('Unpaid', { status: 'DRAFT', mainBranchDataJson: completeListing });
    const res = await asPersona('Unpaid').get('/host/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'AWAITING_PAYMENT', nextAction: 'CHOOSE_PLAN', plan: null });
    expect(res.body.data.verification.verified).toBe(false);
  });

  test('BUG-11: a token issued before the person became a host (role MEMBER, no tenantId) still gets their status', async () => {
    await makeHost('Stale', { status: 'PENDING_REVIEW', kycStatus: 'PENDING' }, { role: 'MEMBER', isHost: false, tenantId: null });
    const res = await asPersona('Stale').get('/host/status');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PENDING_REVIEW');
  });

  test('approved host on a 1-branch store plan: APPROVED, Starter, verified (BUG-13, BUG-24)', async () => {
    const res = await asPersona('owner').get('/host/status');
    expect(res.status).toBe(200);
    // persona owner holds a 10-branch MANUAL row (factories default paymentStatus PENDING)
    expect(res.body.data.status).toBe('APPROVED');

    const { tenant } = await makeHost('Starter', { status: 'ACTIVE', kycStatus: 'APPROVED' });
    await factories.createTenantSubscription(tenant.id, { branchCount: 1, platform: 'IOS', paymentStatus: 'PAID' });
    const res2 = await asPersona('Starter').get('/host/status');
    expect(res2.body.data).toMatchObject({ status: 'APPROVED', nextAction: 'NONE' });
    expect(res2.body.data.plan).toMatchObject({ tierName: 'Starter', branchCount: 1 });
    expect(res2.body.data.verification.verified).toBe(true);
  });

  test('never reveals another host\'s tenant: always the caller\'s own', async () => {
    const res = await asPersona('Unpaid', { 'X-Tenant-Id': personas.owner.tenantId }).get('/host/status');
    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(personaManager.personas.Unpaid.ownTenantId);
  });
});

describe('GET /me/bootstrap carries the same host status', () => {
  test('unpaid host', async () => {
    const res = await asPersona('Unpaid').get('/me/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.data.hostStatus).toMatchObject({ status: 'AWAITING_PAYMENT', nextAction: 'CHOOSE_PLAN' });
  });

  test('traveller', async () => {
    const res = await asPersona('member').get('/me/bootstrap');
    expect(res.body.data.hostStatus).toMatchObject({ status: 'NONE' });
  });
});

describe('GET /host/today-summary', () => {
  test('BUG-11: resolves the host\'s own tenant, not the token\'s tenantId (stale token said DRAFT)', async () => {
    // Same person as "Stale", but with a GYM_HOST token that still has no tenantId.
    const stale = personaManager.personas.Stale;
    personaManager.personas.StaleHost = { token: hostToken(stale.user, { tenantId: null }) };
    const res = await asPersona('StaleHost').get('/host/today-summary');
    expect(res.status).toBe(200);
    expect(res.body.data.applicationStatus).toBe('PENDING_REVIEW');
    expect(res.body.data.state).toBe('B');
    expect(res.body.data.hostStatus).toMatchObject({ status: 'PENDING_REVIEW' });
  });

  test('BUG-11: an unreachable tenant database is an error with a code, never an empty "APPROVED" dashboard', async () => {
    await makeHost('Unreachable', { status: 'ACTIVE', kycStatus: 'APPROVED', connectionStringEncrypted: 'not-a-valid-ciphertext' });
    const res = await asPersona('Unreachable').get('/host/today-summary');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('tenant_unavailable');
  });
});
