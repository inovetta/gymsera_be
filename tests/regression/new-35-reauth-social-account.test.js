/**
 * NEW-35 (spec §12.13.12 / §13):
 * Re-authentication must never be skipped for accounts with no password (social-only accounts).
 *
 * Prior bug:
 * In `src/controllers/gyms.controller.js:37-47` (payout bank details update) and `:121-131` (delete branch),
 * the password checks used `if (user && user.passwordHash)`.
 * A Google/Apple-only user has `passwordHash: null`.
 * Sending ANY made-up `password` string caused the condition to evaluate to false,
 * completely bypassing password validation and letting the mutation succeed without re-auth.
 * Furthermore, in branch deletion, sending no credential at all (`{}`) bypassed all checks.
 *
 * Fix:
 * Route both call sites through `authService.assertReauth(userId, credential)`,
 * matching the reference pattern introduced in Prompt 1I (AUTH-07 account deletion).
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
const { User, Tenant } = require('../../src/models/platform');
const authService = require('../../src/services/auth.service');

const PASSWORD = 'Test@12345';

describe('NEW-35: Re-auth must reject made-up passwords for social accounts and require credentials', () => {
  let dbHarness;
  let server;
  let tenant1;

  // Helper to make API requests
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
   * with their own tenant, listing, and branches in tenant1 DB.
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
      gymName: 'Social Host Gym',
    });

    await factories.createTenantSubscription(tenant.id, { branchCount: 5 });
    const listing = await factories.createGymListing(tenant.id, { title: 'Social Host Listing' });
    const branch = await factories.createBranch(tenant1, listing.id, { branchName: 'Social Branch 1' });

    return { user, tenant, listing, branch, googleId, appleId };
  };

  /**
   * Helper to create a normal password host.
   */
  const createPasswordHost = async () => {
    const user = await factories.createUser({
      role: 'GYM_HOST',
    });

    const tenant = await factories.createTenant({
      ownerUserId: user.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
      gymName: 'Password Host Gym',
    });

    await factories.createTenantSubscription(tenant.id, { branchCount: 5 });
    const listing = await factories.createGymListing(tenant.id, { title: 'Password Host Listing' });
    const branch = await factories.createBranch(tenant1, listing.id, { branchName: 'Password Branch 1' });

    return { user, tenant, listing, branch };
  };

  describe('Call site 1: PATCH /gyms/profile (payout bank details re-auth)', () => {
    const sampleBankDetails = {
      bankName: 'Standard Chartered',
      accountTitle: 'Test Account',
      accountNumber: '1234567890',
      iban: 'PK12SCBL0012345678901234',
    };

    test('social-only account + random password is REJECTED (401 invalid_credentials)', async () => {
      const { user, tenant } = await createSocialHost();

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
          password: 'made-up-random-password',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      // Verify tenant was NOT updated
      const reloadedTenant = await Tenant.findByPk(tenant.id);
      expect(reloadedTenant.paymentDetailsUpdatedAt).toBeNull();
    });

    test('social-only account with no credentials is REJECTED (401 reauth_required)', async () => {
      const { user, tenant } = await createSocialHost();

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');
    });

    test('social-only account with valid fresh social token is ACCEPTED (200)', async () => {
      const { user, tenant } = await createSocialHost({ provider: 'GOOGLE' });

      const spy = jest.spyOn(authService, 'verifyReauthCredential').mockResolvedValue(true);

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
          provider: 'GOOGLE',
          idToken: 'valid-google-id-token',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(spy).toHaveBeenCalledWith(user.id, {
        provider: 'GOOGLE',
        idToken: 'valid-google-id-token',
      });

      const reloadedTenant = await Tenant.findByPk(tenant.id);
      expect(reloadedTenant.paymentDetailsUpdatedAt).not.toBeNull();
    });

    test('social-only account with invalid social token is REJECTED (401)', async () => {
      const { user, tenant } = await createSocialHost({ provider: 'GOOGLE' });

      jest.spyOn(authService, 'verifyReauthCredential').mockRejectedValue(
        Object.assign(new Error('That Google account does not match your GymsEra account'), { statusCode: 401 })
      );

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
          provider: 'GOOGLE',
          idToken: 'mismatched-google-token',
        },
      });

      expect(res.status).toBe(401);
    });

    test('normal password account with correct password is ACCEPTED (200)', async () => {
      const { user, tenant } = await createPasswordHost();

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
          password: PASSWORD,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const reloadedTenant = await Tenant.findByPk(tenant.id);
      expect(reloadedTenant.paymentDetailsUpdatedAt).not.toBeNull();
    });

    test('normal password account with incorrect password is REJECTED (401 invalid_credentials)', async () => {
      const { user, tenant } = await createPasswordHost();

      const res = await api('patch', '/gyms/profile', {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          paymentDetailsJson: sampleBankDetails,
          password: 'IncorrectPassword!',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
    });
  });

  describe('Call site 2: DELETE /gyms/branches/:branchId (branch deletion re-auth)', () => {
    test('social-only account + random password is REJECTED (401 invalid_credentials)', async () => {
      const { user, tenant, branch } = await createSocialHost();

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: 'made-up-random-password',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      // Verify branch is still ACTIVE
      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });

    test('request with NO credentials at all is REJECTED (401 reauth_required)', async () => {
      const { user, tenant, branch } = await createSocialHost();

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');

      // Verify branch is still ACTIVE
      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });

    test('social-only account with valid fresh social token is ACCEPTED (200)', async () => {
      const { user, tenant, branch } = await createSocialHost({ provider: 'GOOGLE' });

      const spy = jest.spyOn(authService, 'verifyReauthCredential').mockResolvedValue(true);

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          provider: 'GOOGLE',
          idToken: 'valid-google-id-token',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(user.id, {
        provider: 'GOOGLE',
        idToken: 'valid-google-id-token',
      });

      // Verify branch is now INACTIVE
      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('INACTIVE');
    });

    test('social-only account with valid fresh social token using reauthProvider/reauthIdToken is ACCEPTED (200)', async () => {
      const { user, tenant, branch } = await createSocialHost({ provider: 'APPLE' });

      const spy = jest.spyOn(authService, 'verifyReauthCredential').mockResolvedValue(true);

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          reauthProvider: 'APPLE',
          reauthIdToken: 'valid-apple-id-token',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledWith(user.id, {
        provider: 'APPLE',
        idToken: 'valid-apple-id-token',
      });

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('INACTIVE');
    });

    test('social-only account with invalid social token is REJECTED (401)', async () => {
      const { user, tenant, branch } = await createSocialHost({ provider: 'GOOGLE' });

      jest.spyOn(authService, 'verifyReauthCredential').mockRejectedValue(
        Object.assign(new Error('That Google account does not match your GymsEra account'), { statusCode: 401 })
      );

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          provider: 'GOOGLE',
          idToken: 'wrong-token',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(401);

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });

    test('normal password account with correct password is ACCEPTED (200)', async () => {
      const { user, tenant, branch } = await createPasswordHost();

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: PASSWORD,
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(200);

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('INACTIVE');
    });

    test('normal password account with incorrect password is REJECTED (401 invalid_credentials)', async () => {
      const { user, tenant, branch } = await createPasswordHost();

      const res = await api('delete', `/gyms/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: 'WrongPassword!',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });
  });

  describe('Call site 2b: DELETE /host/branches/:branchId (same controller via host route)', () => {
    test('social-only account + random password is REJECTED (401 invalid_credentials)', async () => {
      const { user, tenant, branch } = await createSocialHost();

      const res = await api('delete', `/host/branches/${branch.id}`, {
        token: tokenFor(user, tenant.id),
        tenantId: tenant.id,
        body: {
          password: 'made-up-random-password',
          confirmOrganizationDeletion: true,
        },
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');

      const reloadedBranch = await tenant1.models.Branch.findByPk(branch.id);
      expect(reloadedBranch.status).toBe('ACTIVE');
    });
  });
});
