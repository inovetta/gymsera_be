/**
 * AUTH-07 (Prompt 1I, spec §14 R-28): self-service account deletion — the REQUEST side.
 *
 * Before: `POST /me/request-deletion` only set `users.status = INACTIVE`
 * (me.service.js#requestAccountDeletion) — no re-authentication, no tenant, no
 * store-subscription check, no undo window, and a Google/Apple sign-in flipped the
 * account straight back to ACTIVE (auth.service.js googleLogin/appleLogin).
 *
 * Now: re-auth → preflight → PENDING_DELETION for the user and every tenant they own
 * (30-day undo window), sessions and device tokens removed, members told, Stripe
 * cancelled at period end, store subscriptions block. `POST /me/cancel-deletion` undoes it.
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
  setupPersonas,
} = require('../harness');
const { startTestServer } = require('../harness/test-server');
const { installMailFake } = require('../harness/mail-fake');
const {
  User,
  Tenant,
  GymListing,
  RefreshToken,
  DeviceToken,
  Notification,
  PlatformAuditLog,
  UserGymMembership,
  TenantSubscription,
} = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const authService = require('../../src/services/auth.service');
const stripeBilling = require('../../src/services/stripe-billing.service');
const { safeRedisDel } = require('../../src/config/redis.config');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'Test@12345';

describe('AUTH-07: account deletion request, preflight and undo', () => {
  let dbHarness;
  let server;
  let mail;

  const api = (method, path, { token, tenantId, body } = {}) => {
    const req = request(server)[method](`/api/v1${path}`).set('Accept', 'application/json');
    if (token) req.set('Authorization', `Bearer ${token}`);
    if (tenantId) req.set('X-Tenant-Id', tenantId);
    return body === undefined ? req : req.send(body);
  };

  const tokenFor = (user, extra = {}) =>
    signToken({ sub: user.id, id: user.id, email: user.email, role: user.role, isVerified: true, ...extra });

  /** A host with one ACTIVE tenant (own listing, one member, one session, one device token). */
  const createHost = async (tenantOverrides = {}) => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await factories.createTenant({
      ownerUserId: owner.id,
      connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr,
      ...tenantOverrides,
    });
    const listing = await factories.createGymListing(tenant.id);
    await RefreshToken.create({
      userId: owner.id,
      familyId: uuidv4(),
      token: `hash-${uuidv4()}`,
      expiresAt: new Date(Date.now() + 7 * DAY),
      isRevoked: false,
    });
    await DeviceToken.create({ userId: owner.id, token: `fcm-${uuidv4()}`, platform: 'android' });
    const member = await factories.createUser({ role: 'MEMBER' });
    await UserGymMembership.create({
      userId: member.id,
      tenantId: tenant.id,
      gymListingId: listing.id,
      subscriptionId: uuidv4(),
      gymName: 'Test Gym',
      planName: 'Monthly',
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * DAY),
      status: 'ACTIVE',
    });
    return { owner, tenant, listing, member };
  };

  const reload = (model, id) => model.findByPk(id);

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
    server = await startTestServer();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(() => {
    mail = installMailFake();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('re-authentication (no more one-tap deletion)', () => {
    test('no credential → 401 reauth_required and NOTHING changes', async () => {
      const { owner, tenant } = await createHost();
      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: {} });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('reauth_required');
      expect((await reload(User, owner.id)).status).toBe('ACTIVE');
      expect((await reload(Tenant, tenant.id)).status).toBe('ACTIVE');
    });

    test('wrong password → 401 invalid_credentials and NOTHING changes', async () => {
      const { owner, tenant } = await createHost();
      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: 'nope-nope' } });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect((await reload(User, owner.id)).status).toBe('ACTIVE');
      expect((await reload(Tenant, tenant.id)).status).toBe('ACTIVE');
    });

    test('a social-only account (no password) cannot pass with ANY password string', async () => {
      const social = await factories.createUser({ role: 'MEMBER', passwordHash: null, googleId: `g-${uuidv4()}` });
      const res = await api('post', '/me/request-deletion', { token: tokenFor(social), body: { password: 'anything' } });

      expect(res.status).toBe(401);
      expect((await reload(User, social.id)).status).toBe('ACTIVE');
    });

    test('a fresh Google token for the SAME Google account passes; for another account it does not', async () => {
      const googleId = `g-${uuidv4()}`;
      const social = await factories.createUser({ role: 'MEMBER', passwordHash: null, googleId });
      const spy = jest.spyOn(authService, 'verifyReauthCredential');
      spy.mockRejectedValueOnce(Object.assign(new Error('That Google account does not match your GymsEra account'), { statusCode: 401 }));
      const bad = await api('post', '/me/request-deletion', {
        token: tokenFor(social),
        body: { provider: 'GOOGLE', idToken: 'other-accounts-token' },
      });
      expect(bad.status).toBe(401);
      expect((await reload(User, social.id)).status).toBe('ACTIVE');

      spy.mockResolvedValueOnce(true);
      const ok = await api('post', '/me/request-deletion', {
        token: tokenFor(social),
        body: { provider: 'GOOGLE', idToken: 'my-token' },
      });
      expect(ok.status).toBe(200);
      expect((await reload(User, social.id)).status).toBe('PENDING_DELETION');
    });

    test('a platform admin account cannot be self-deleted', async () => {
      const admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
      const res = await api('post', '/me/request-deletion', { token: tokenFor(admin), body: { password: PASSWORD } });
      expect(res.status).toBe(403);
      expect((await reload(User, admin.id)).status).toBe('ACTIVE');
    });
  });

  describe('preflight: store subscriptions block, Stripe is cancelled for them', () => {
    test.each([['IOS', 'https://apps.apple.com/account/subscriptions'], ['ANDROID', 'https://play.google.com/store/account/subscriptions']])(
      'a live %s subscription → 409 store_subscription_active with the store link; nothing changes',
      async (platform, link) => {
        const { owner, tenant } = await createHost();
        await factories.createTenantSubscription(tenant.id, {
          platform,
          status: 'ACTIVE',
          externalOriginalTransactionId: `ext-${uuidv4()}`,
        });

        const pre = await api('get', '/me/deletion-preflight', { token: tokenFor(owner) });
        expect(pre.status).toBe(200);
        expect(pre.body.data.canDelete).toBe(false);
        expect(pre.body.data.blockers[0]).toMatchObject({ type: 'STORE_SUBSCRIPTION', platform, manageUrl: link, tenantId: tenant.id });

        const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('store_subscription_active');
        expect(res.body.data.blockers[0].manageUrl).toBe(link);
        expect((await reload(User, owner.id)).status).toBe('ACTIVE');
        expect((await reload(Tenant, tenant.id)).status).toBe('ACTIVE');
        expect(await RefreshToken.count({ where: { userId: owner.id, isRevoked: false } })).toBe(1);
      }
    );

    test('a store subscription the user already cancelled (PENDING_CANCEL / EXPIRED) does not block', async () => {
      const { owner, tenant } = await createHost();
      await factories.createTenantSubscription(tenant.id, { platform: 'IOS', status: 'PENDING_CANCEL', externalOriginalTransactionId: `ext-${uuidv4()}` });
      await factories.createTenantSubscription(tenant.id, { platform: 'ANDROID', status: 'EXPIRED', externalOriginalTransactionId: `ext-${uuidv4()}` });

      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
      expect(res.status).toBe(200);
    });

    test('a live Stripe subscription is cancelled at period end automatically (after the state change)', async () => {
      const { owner, tenant } = await createHost();
      const stripeId = `sub_${uuidv4()}`;
      await factories.createTenantSubscription(tenant.id, { platform: 'STRIPE', status: 'ACTIVE', externalOriginalTransactionId: stripeId });
      const cancel = jest.spyOn(stripeBilling, 'cancelAtPeriodEnd').mockResolvedValue(undefined);

      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      expect(res.status).toBe(200);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(stripeId);
      expect((await reload(Tenant, tenant.id)).status).toBe('PENDING_DELETION');
    });

    test('Stripe failing does not undo the request: it is audited for the day-30 retry', async () => {
      const { owner, tenant } = await createHost();
      await factories.createTenantSubscription(tenant.id, { platform: 'STRIPE', status: 'ACTIVE', externalOriginalTransactionId: `sub_${uuidv4()}` });
      jest.spyOn(stripeBilling, 'cancelAtPeriodEnd').mockRejectedValue(new Error('stripe down'));

      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      expect(res.status).toBe(200);
      expect((await reload(User, owner.id)).status).toBe('PENDING_DELETION');
      const logs = await PlatformAuditLog.findAll({ where: { action: 'ACCOUNT_DELETION_STRIPE_CANCEL_FAILED', targetId: tenant.id } });
      expect(logs).toHaveLength(1);
    });
  });

  describe('the request (R-28: effective at once, 30-day undo window)', () => {
    test('host: user + tenant → PENDING_DELETION, window = 30 days, sessions/devices gone, audited', async () => {
      const { owner, tenant } = await createHost();
      const before = Date.now();
      const res = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      expect(res.status).toBe(200);
      const scheduled = new Date(res.body.data.scheduledFor).getTime();
      expect(scheduled).toBeGreaterThanOrEqual(before + 30 * DAY - 5000);
      expect(scheduled).toBeLessThanOrEqual(Date.now() + 30 * DAY + 5000);

      const user = await reload(User, owner.id);
      expect(user.status).toBe('PENDING_DELETION');
      expect(user.deletionRequestedAt).toBeTruthy();
      expect(new Date(user.deletionScheduledFor).getTime()).toBe(scheduled);

      const t = await reload(Tenant, tenant.id);
      expect(t.status).toBe('PENDING_DELETION');
      expect(t.statusBeforeDeletion).toBe('ACTIVE');
      expect(new Date(t.deletionScheduledFor).getTime()).toBe(scheduled);

      expect(await RefreshToken.count({ where: { userId: owner.id, isRevoked: false } })).toBe(0);
      expect(await DeviceToken.count({ where: { userId: owner.id } })).toBe(0);

      const audit = await PlatformAuditLog.findAll({ where: { action: 'ACCOUNT_DELETION_REQUESTED', targetId: owner.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorUserId).toBe(owner.id);
      expect(JSON.stringify(audit[0].details)).not.toContain(PASSWORD);
    });

    test('the tenant stops working at once: owner calls on it get 404, not served', async () => {
      const { owner, tenant } = await createHost();
      const token = signToken({ sub: owner.id, id: owner.id, email: owner.email, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
      await safeRedisDel(`tenant:${tenant.id}:connStr`);
      await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      const res = await api('get', '/gyms/members', { token, tenantId: tenant.id });
      expect(res.status).toBe(404);
    });

    test('the tenant leaves discovery: traveler discovery reads only ACTIVE tenants (guard against that changing)', () => {
      const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../src/services/discovery.service.js'), 'utf8');
      expect(src).toMatch(/Tenant\.findAll\(\{\s*where:\s*\{\s*status:\s*'ACTIVE'\s*\}/);
      expect(src).not.toMatch(/PENDING_DELETION|status:\s*\[/);
    });

    test('members of the tenant are notified at request time; memberships are NOT cancelled yet', async () => {
      const { owner, tenant, member } = await createHost();
      await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      const notes = await Notification.findAll({ where: { userId: member.id, type: 'GYM_CLOSING' } });
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toMatch(/close/i);
      const m = await UserGymMembership.findOne({ where: { userId: member.id, tenantId: tenant.id } });
      expect(m.status).toBe('ACTIVE');
    });

    test('a SUSPENDED tenant remembers it was suspended', async () => {
      const { owner, tenant } = await createHost({ status: 'SUSPENDED' });
      await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
      expect((await reload(Tenant, tenant.id)).statusBeforeDeletion).toBe('SUSPENDED');
    });

    test('asking twice is idempotent: the window is not extended', async () => {
      const { owner } = await createHost();
      const first = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
      const second = await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });

      expect(second.status).toBe(200);
      expect(second.body.data.scheduledFor).toBe(first.body.data.scheduledFor);
      expect(await PlatformAuditLog.count({ where: { action: 'ACCOUNT_DELETION_REQUESTED', targetId: owner.id } })).toBe(1);
    });

    test('member-only account: same 30-day window (R-28), no tenant involved', async () => {
      const member = await factories.createUser({ role: 'MEMBER' });
      const res = await api('post', '/me/request-deletion', { token: tokenFor(member), body: { password: PASSWORD } });

      expect(res.status).toBe(200);
      const user = await reload(User, member.id);
      expect(user.status).toBe('PENDING_DELETION');
      expect(new Date(user.deletionScheduledFor).getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    });

    test('an already rejected tenant is left alone (not re-statused)', async () => {
      const { owner, tenant } = await createHost({ status: 'REJECTED' });
      await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
      expect((await reload(Tenant, tenant.id)).status).toBe('REJECTED');
    });
  });

  describe('while pending: sign-in works (to undo) but nothing else', () => {
    const pendingHost = async () => {
      const ctx = await createHost();
      await api('post', '/me/request-deletion', { token: tokenFor(ctx.owner), body: { password: PASSWORD } });
      return ctx;
    };

    test('password login succeeds and says the deletion is pending', async () => {
      const { owner } = await pendingHost();
      const res = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });

      expect(res.status).toBe(200);
      expect(res.body.data.user.deletionPending.scheduledFor).toBeTruthy();
    });

    test('a pending token is refused everywhere except the undo/profile/preflight routes', async () => {
      const { owner } = await pendingHost();
      const login = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });
      const token = login.body.data.accessToken;

      const blocked = await api('get', '/me/saved-gyms', { token });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('account_pending_deletion');

      expect((await api('get', '/me/profile', { token })).status).toBe(200);
      expect((await api('get', '/me/deletion-preflight', { token })).status).toBe(200);
    });

    test('refreshing keeps the pending flag (a refresh cannot launder the restriction)', async () => {
      const { owner } = await pendingHost();
      const login = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });
      const refreshed = await api('post', '/auth/refresh', { body: { refreshToken: login.body.data.refreshToken } });
      expect(refreshed.status).toBe(200);
      const blocked = await api('get', '/me/saved-gyms', { token: refreshed.body.data.accessToken });
      expect(blocked.status).toBe(403);
    });

    test('Google / Apple sign-in does NOT flip a pending account back to ACTIVE (the old INACTIVE bug)', async () => {
      const googleId = `g-${uuidv4()}`;
      const email = `social_${uuidv4().slice(0, 8)}@gymseratest.com`;
      const social = await factories.createUser({ role: 'MEMBER', email, passwordHash: null, googleId, status: 'PENDING_DELETION' });
      await social.update({ deletionRequestedAt: new Date(), deletionScheduledFor: new Date(Date.now() + 29 * DAY) });

      // The token verification itself is NEW-02/NEW-03's job; here it is just replaced by the claims it returns.
      const verifySpy = jest.spyOn(require('google-auth-library').OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
        getPayload: () => ({ sub: googleId, email, email_verified: true, name: 'Social', aud: process.env.GOOGLE_CLIENT_ID }),
      });
      let result;
      try {
        result = await authService.googleLogin({ idToken: 'x' }, '127.0.0.1', 'jest');
      } catch (err) {
        // If the verifier seam differs, fail loudly instead of passing vacuously.
        throw new Error(`Could not drive googleLogin with the fake verifier: ${err.message}`);
      } finally {
        verifySpy.mockRestore();
      }
      expect((await reload(User, social.id)).status).toBe('PENDING_DELETION');
      expect(result.user.deletionPending).toBeTruthy();
    });

    test('POST /me/cancel-deletion restores the user AND the tenant exactly as before', async () => {
      const { owner, tenant } = await pendingHost();
      const login = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });

      const res = await api('post', '/me/cancel-deletion', { token: login.body.data.accessToken });
      expect(res.status).toBe(200);

      const user = await reload(User, owner.id);
      expect(user.status).toBe('ACTIVE');
      expect(user.deletionRequestedAt).toBeNull();
      expect(user.deletionScheduledFor).toBeNull();
      const t = await reload(Tenant, tenant.id);
      expect(t.status).toBe('ACTIVE');
      expect(t.statusBeforeDeletion).toBeNull();
      expect(t.deletionScheduledFor).toBeNull();
      expect(await PlatformAuditLog.count({ where: { action: 'ACCOUNT_DELETION_CANCELLED', targetId: owner.id } })).toBe(1);

      // and a fresh login carries no restriction
      const again = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });
      expect(again.body.data.user.deletionPending).toBeFalsy();
      expect((await api('get', '/me/saved-gyms', { token: again.body.data.accessToken })).status).toBe(200);
    });

    test('a SUSPENDED tenant comes back SUSPENDED, not ACTIVE', async () => {
      const ctx = await createHost({ status: 'SUSPENDED' });
      await api('post', '/me/request-deletion', { token: tokenFor(ctx.owner), body: { password: PASSWORD } });
      const login = await api('post', '/auth/login', { body: { email: ctx.owner.email, password: PASSWORD } });
      await api('post', '/me/cancel-deletion', { token: login.body.data.accessToken });
      expect((await reload(Tenant, ctx.tenant.id)).status).toBe('SUSPENDED');
    });

    test('undo is refused once the window has passed (even if the sweep has not run yet)', async () => {
      const { owner, tenant } = await pendingHost();
      await User.update({ deletionScheduledFor: new Date(Date.now() - 1000) }, { where: { id: owner.id } });
      const login = await api('post', '/auth/login', { body: { email: owner.email, password: PASSWORD } });

      const res = await api('post', '/me/cancel-deletion', { token: login.body.data.accessToken });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('deletion_window_ended');
      expect((await reload(User, owner.id)).status).toBe('PENDING_DELETION');
      expect((await reload(Tenant, tenant.id)).status).toBe('PENDING_DELETION');
    });

    test('cancel-deletion on an account that is not pending → 409, nothing changes', async () => {
      const member = await factories.createUser({ role: 'MEMBER' });
      const res = await api('post', '/me/cancel-deletion', { token: tokenFor(member) });
      expect(res.status).toBe(409);
      expect((await reload(User, member.id)).status).toBe('ACTIVE');
    });
  });

  test('a listing of the pending tenant is left as it is until day 30 (visibility is decided by the tenant status)', async () => {
    const { owner, listing } = await createHost();
    await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
    expect((await reload(GymListing, listing.id)).status).toBe('ACTIVE');
  });

  test('no mail is sent with the password, and TenantSubscription rows are never touched', async () => {
    const { owner, tenant } = await createHost();
    const sub = await factories.createTenantSubscription(tenant.id, { platform: 'MANUAL', status: 'ACTIVE' });
    await api('post', '/me/request-deletion', { token: tokenFor(owner), body: { password: PASSWORD } });
    expect(JSON.stringify(mail.sent)).not.toContain(PASSWORD);
    expect((await reload(TenantSubscription, sub.id)).status).toBe('ACTIVE'); // financial record kept as is (R-16)
  });
});
