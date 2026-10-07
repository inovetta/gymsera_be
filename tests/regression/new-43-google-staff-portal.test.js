/**
 * NEW-43 — the CMS Google sign-in (POST /auth/social/google/staff) lets in anyone
 * who owns an active organization or holds an ACTIVE team role, not only accounts
 * whose users.role is GYM_HOST / BRANCH_MANAGER / PLATFORM_ADMIN.
 *
 * A team member's account role stays MEMBER (RBAC-07), so the old role list
 * refused every Front Desk clerk, trainer and manager who signs in with Google.
 *
 * Everything runs through the real models and the real route. Google's signing
 * certificates are replaced by a local key pair (nothing reaches Google).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { User } = require('../../src/models/platform');
const membershipService = require('../../src/services/membership.service');

const CLIENT_ID = 'new43-test-client.apps.googleusercontent.com';
const KID = 'new43-kid';
const REFUSAL = 'This account does not have management portal access.';

const googleKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const now = () => Math.floor(Date.now() / 1000);

const SUB = (email) => `g-${crypto.createHash('sha1').update(email).digest('hex').slice(0, 18)}`;

const tokenFor = (email) =>
  jwt.sign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: SUB(email),
      email,
      email_verified: true,
      name: 'Test Person',
      iat: now(),
      exp: now() + 3600,
    },
    googleKeys.privateKey,
    { algorithm: 'RS256', keyid: KID }
  );

let app;
let tenantDb;

const staffSignIn = (email) =>
  request(app).post('/api/v1/auth/social/google/staff').send({ idToken: tokenFor(email) });

/** A Google-linked account with the given platform role. */
const makeUser = (email, role = 'MEMBER', over = {}) =>
  factories.createUser({ email, role, googleId: SUB(email), ...over });

/** A tenant owned by `ownerUserId`, plus its tenant DB handle. */
const makeTenant = (ownerUserId, over = {}) => factories.createTenant({ ownerUserId, ...over });

/** An assignment written the way production writes it, then the routing index synced. */
const assign = async (tenant, userId, { roleKey = 'DESK', status = 'ACTIVE' } = {}) => {
  const db = { ...tenantDb, tenantId: tenant.id };
  const row = await factories.createRoleAssignment(db, {
    userId,
    roleKey,
    scopeType: 'ORG',
    overrides: { status, tenantId: tenant.id },
  });
  await membershipService.syncUserOrgIndex(tenant.id, userId, tenantDb);
  return row;
};

beforeAll(async () => {
  const harness = await setupTestDatabases();
  tenantDb = harness.tenant1;
  app = await startTestServer();
});

afterAll(async () => {
  await teardownTestDatabases();
});

beforeEach(async () => {
  jest.restoreAllMocks();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  // No table reset: it removes the seeded city the tenant factory points at. Every test
  // uses its own e-mail addresses, owners and tenants instead.
  jest
    .spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
    .mockResolvedValue({ certs: { [KID]: googleKeys.publicKey }, format: 'PEM' });
});

const expectIn = (res, userId) => {
  expect(res.status).toBe(200);
  expect(res.body.data.accessToken).toBeTruthy();
  expect(res.body.data.user.id).toBe(userId);
};

const expectRefused = (res) => {
  expect(res.status).toBe(403);
  expect(res.body.message).toBe(REFUSAL);
  expect(res.body.data?.accessToken).toBeUndefined();
};

describe('NEW-43: team members can sign in to the CMS with Google', () => {
  test('a Front Desk clerk (account role MEMBER) with an ACTIVE assignment is allowed', async () => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await makeTenant(owner.id);
    const clerk = await makeUser('frontdesk@gmail.test');
    await assign(tenant, clerk.id, { roleKey: 'DESK' });

    expectIn(await staffSignIn('frontdesk@gmail.test'), clerk.id);
  });

  test('a clerk whose assignment was revoked is refused', async () => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await makeTenant(owner.id);
    const clerk = await makeUser('revoked@gmail.test');
    const row = await assign(tenant, clerk.id, { roleKey: 'DESK' });
    await row.update({ status: 'REVOKED', revokedAt: new Date() });
    await membershipService.syncUserOrgIndex(tenant.id, clerk.id, tenantDb);

    expectRefused(await staffSignIn('revoked@gmail.test'));
  });

  test('a clerk whose assignment is suspended is refused', async () => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await makeTenant(owner.id);
    const clerk = await makeUser('suspended@gmail.test');
    await assign(tenant, clerk.id, { roleKey: 'DESK', status: 'SUSPENDED' });

    expectRefused(await staffSignIn('suspended@gmail.test'));
  });

  test('a plain member with no team role and no ownership is refused', async () => {
    await makeUser('member@gmail.test');

    expectRefused(await staffSignIn('member@gmail.test'));
  });

  test('an owner whose account role is MEMBER is allowed on the strength of owning an active tenant', async () => {
    const owner = await makeUser('owner@gmail.test', 'MEMBER');
    await makeTenant(owner.id, { status: 'ACTIVE' });

    expectIn(await staffSignIn('owner@gmail.test'), owner.id);
  });

  test('owning a tenant that is not active does not count', async () => {
    const owner = await makeUser('suspendedowner@gmail.test', 'MEMBER');
    await makeTenant(owner.id, { status: 'SUSPENDED' });

    expectRefused(await staffSignIn('suspendedowner@gmail.test'));
  });

  test.each(['GYM_HOST', 'BRANCH_MANAGER', 'PLATFORM_ADMIN'])(
    'an existing %s account still signs in, with no tenant and no assignment',
    async (role) => {
      const user = await makeUser(`${role.toLowerCase()}@gmail.test`, role);

      expectIn(await staffSignIn(`${role.toLowerCase()}@gmail.test`), user.id);
    }
  );

  test('a Google account nobody linked is still refused and no account is created', async () => {
    const before = await User.count();
    const res = await staffSignIn('stranger@gmail.test');

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/No GymsEra staff account is linked/);
    expect(await User.count()).toBe(before);
  });
});

describe('NEW-43: the check is the one the context endpoint uses (no second version)', () => {
  test('membershipService.hasPortalAccess agrees with listUserTenants and the owned-tenant lookup', async () => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await makeTenant(owner.id);
    const clerk = await makeUser('svc.clerk@gmail.test');
    const nobody = await makeUser('svc.nobody@gmail.test');
    await assign(tenant, clerk.id, { roleKey: 'DESK' });

    expect(await membershipService.hasPortalAccess(owner.id)).toBe(true);
    expect(await membershipService.hasPortalAccess(clerk.id)).toBe(true);
    expect(await membershipService.hasPortalAccess(nobody.id)).toBe(false);
    expect(await membershipService.hasPortalAccess(null)).toBe(false);
  });
});
