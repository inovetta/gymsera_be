/**
 * NEW-38 (spec §12.13.12 / §13):
 * Re-authentication required for organization deletion (DELETE /host/listings/:id).
 *
 * Prior bug:
 * `DELETE /host/listings/:id` (`host.controller.js:717-733`, `deleteListing`)
 * deleted a whole organization (and could cascade-delete branches via strategy: 'deleteBranches')
 * with only a session token and no re-auth check.
 *
 * Fix:
 * Call `authService.assertReauth(req.user.sub, {...})` in `deleteListing` before any deletion,
 * requiring password for password accounts or fresh Google/Apple token for social accounts.
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
  factories,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { installMailFake } = require('../harness/mail-fake');
const { signToken } = require('../../src/utils/jwt.utils');
const { GymListing } = require('../../src/models/platform');
const authService = require('../../src/services/auth.service');

const PASSWORD = 'Test@12345';

describe('NEW-38: Organization deletion re-authentication', () => {
  let dbHarness;
  let server;
  let tenant1;

  const api = (method, path, { token, tenantId, body } = {}) => {
    const req = request(server)[method](`/api/v1${path}`).set('Accept', 'application/json');
    if (token) req.set('Authorization', `Bearer ${token}`);
    if (tenantId) req.set('X-Tenant-Id', tenantId);
    return body === undefined ? req : req.send(body);
  };

  const tokenFor = (user, tenantId) =>
    signToken({
      sub: user.id,
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: tenantId || user.tenantId,
      isVerified: true,
    });

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;
    await setupPersonas(dbHarness);
    server = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(() => {
    installMailFake();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Helper to create a social host (Google/Apple only, no passwordHash)
   * with an empty organization listing in platform DB.
   */
  const createSocialHost = async ({ provider = 'GOOGLE' } = {}) => {
    const googleId = provider === 'GOOGLE' ? `g-${uuidv4()}` : null;
    const appleId = provider === 'APPLE' ? `a-${uuidv4()}` : null;

    const user = await factories.createUser({
      role: 'GYM_HOST',
      passwordHash: null,
      googleId,
      appleId,
    });

    const tenant = await factories.createTenant({
      ownerUserId: user.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
      gymName: 'Social Host Gym Org',
    });

    await factories.createTenantSubscription(tenant.id, { branchCount: 5 });
    const listing = await factories.createGymListing(tenant.id, {
      title: 'Social Host Empty Org',
      status: 'ACTIVE',
      reservedSlots: 0,
    });

    return { user, tenant, listing, googleId, appleId };
  };

  /**
   * Helper to create a password host with an empty organization listing.
   */
  const createPasswordHost = async () => {
    const user = await factories.createUser({
      role: 'GYM_HOST',
      password: PASSWORD,
    });

    const tenant = await factories.createTenant({
      ownerUserId: user.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
      gymName: 'Password Host Gym Org',
    });

    await factories.createTenantSubscription(tenant.id, { branchCount: 5 });
    const listing = await factories.createGymListing(tenant.id, {
      title: 'Password Host Empty Org',
      status: 'ACTIVE',
      reservedSlots: 0,
    });

    return { user, tenant, listing };
  };

  describe('DELETE /host/listings/:id re-authentication requirements', () => {
    test('exempt case: caller owns it, 0 branches, created < 5m ago, no cascade flag -> works without credentials (200)', async () => {
      const { user, tenant, listing } = await createPasswordHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {},
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('INACTIVE');
    });

    test('exemption fails: has an ACTIVE branch -> 401 reauth_required and deletes nothing', async () => {
      const { user, tenant, listing } = await createPasswordHost();
      const branch = await factories.createBranch(tenant1, listing.id, { branchName: 'Active Branch In Org' });

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {},
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });

    test('exemption fails: has an INACTIVE branch -> 401 reauth_required and deletes nothing', async () => {
      const { user, tenant, listing } = await createPasswordHost();
      const branch = await factories.createBranch(tenant1, listing.id, {
        branchName: 'Inactive Branch In Org',
        status: 'INACTIVE',
      });

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {},
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('INACTIVE');
    });

    test('exemption fails: created > 5 minutes ago -> 401 reauth_required and deletes nothing', async () => {
      const { user, tenant, listing } = await createPasswordHost();
      // Age listing beyond 5-minute rollback window (6 minutes ago)
      await GymListing.sequelize.query('UPDATE gym_listings SET created_at = :createdAt WHERE id = :id', {
        replacements: {
          createdAt: new Date(Date.now() - 6 * 60 * 1000),
          id: listing.id,
        },
      });

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {},
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('exemption fails: belongs to another owner -> 401 reauth_required and deletes nothing', async () => {
      const hostA = await createPasswordHost();
      const hostB = await createPasswordHost();

      // Host A attempts to delete Host B's listing with no credentials
      const res = await api('delete', `/host/listings/${hostB.listing.id}`, {
        token: tokenFor(hostA.user, hostA.tenant.id),
        tenantId: hostA.tenant.id,
        body: {},
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(hostB.listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('exemption fails: cascade flag set (strategy: deleteBranches) without credentials -> 401 reauth_required', async () => {
      const { user, tenant, listing } = await createPasswordHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          strategy: 'deleteBranches',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('exemption fails: cascade flag set (cascade: true) without credentials -> 401 reauth_required', async () => {
      const { user, tenant, listing } = await createPasswordHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          cascade: true,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('social-only account + random password -> 401 invalid_credentials and nothing deleted', async () => {
      const { user, tenant, listing } = await createSocialHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: 'some-random-made-up-password',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      // Verify listing is still ACTIVE
      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('normal password account with wrong password -> 401 and nothing deleted', async () => {
      const { user, tenant, listing } = await createPasswordHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: 'WrongPassword@123',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('normal password account with valid password -> works (200) and organization deleted', async () => {
      const { user, tenant, listing } = await createPasswordHost();

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: PASSWORD,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('INACTIVE');
    });

    test('social-only account with valid fresh social token -> works (200) and organization deleted', async () => {
      const { user, tenant, listing } = await createSocialHost({ provider: 'GOOGLE' });

      const spy = jest.spyOn(authService, 'verifyReauthCredential').mockResolvedValue(true);

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          provider: 'GOOGLE',
          idToken: 'valid-fresh-google-id-token',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(user.id, {
        provider: 'GOOGLE',
        idToken: 'valid-fresh-google-id-token',
      });

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('INACTIVE');
    });

    test('social-only account with valid fresh social token using reauthProvider/reauthIdToken -> works (200)', async () => {
      const { user, tenant, listing } = await createSocialHost({ provider: 'APPLE' });

      const spy = jest.spyOn(authService, 'verifyReauthCredential').mockResolvedValue(true);

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          reauthProvider: 'APPLE',
          reauthIdToken: 'valid-fresh-apple-id-token',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(user.id, {
        provider: 'APPLE',
        idToken: 'valid-fresh-apple-id-token',
      });

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('INACTIVE');
    });

    test('social-only account with invalid social token is REJECTED (401) and nothing deleted', async () => {
      const { user, tenant, listing } = await createSocialHost({ provider: 'GOOGLE' });

      jest.spyOn(authService, 'verifyReauthCredential').mockRejectedValue(
        Object.assign(new Error('That Google account does not match your GymsEra account'), { statusCode: 401 })
      );

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          provider: 'GOOGLE',
          idToken: 'wrong-google-token',
        },
      });

      expect(res.status).toBe(401);

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');
    });

    test('cascade deletion with strategy: deleteBranches without credentials fails (401) and branches stay ACTIVE', async () => {
      const { user, tenant, listing } = await createPasswordHost();
      const branch = await factories.createBranch(tenant1, listing.id, { branchName: 'Branch In Org' });

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          strategy: 'deleteBranches',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('ACTIVE');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });

    test('cascade deletion with strategy: deleteBranches with valid password succeeds (200) and deletes org and branches', async () => {
      const { user, tenant, listing } = await createPasswordHost();
      const branch = await factories.createBranch(tenant1, listing.id, { branchName: 'Branch In Org To Cascade' });

      const res = await api('delete', `/host/listings/${listing.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: PASSWORD,
          strategy: 'deleteBranches',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const reloadedListing = await GymListing.findByPk(listing.id);
      expect(reloadedListing.status).toBe('INACTIVE');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('INACTIVE');
    });
  });
});
