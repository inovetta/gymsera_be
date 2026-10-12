/**
 * UX-24: the /tenants/* signup contract, as used by BOTH clients.
 *
 * Characterization tests (no production code changed). They pin the request
 * shapes the web wizard (gymsera_web gym-owner-register.tsx) and the mobile
 * become-host wizard (gyms_era host_onboarding_providers.dart) send today, so
 * aligning the web wizard to mobile cannot silently change the contract.
 *
 *   web    : register -> gym-profile (once) -> select-package -> finalize
 *            paymentMethod BANK_TRANSFER | PAY_LATER
 *   mobile : register -> gym-profile (x3, last one carries plans)
 *            -> onboarding-images -> finalize paymentMethod IN_APP_PURCHASE
 *            (never calls select-package)
 *
 * The first block documents M1: a finalize without membership plans is refused
 * (tenant.service.js finalizeApplication), which is what today's web wizard
 * sends because it has no plans step.
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');
const { createUser } = require('../harness/factories');
const { Tenant, PlatformPackage } = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');

const API = '/api/v1';

// What mobile's _formatPlansForApi produces for one plan.
const MOBILE_PLAN = {
  name: 'Monthly',
  description: null,
  durationType: 'MONTHLY',
  durationValue: 1,
  price: 5000,
  joiningFee: 0,
  securityFee: 0,
  visitLimit: null,
  freezeLimitDays: 0,
  isTrial: false,
  isPublic: true,
  status: 'ACTIVE',
  isDeactivated: false,
};

describe('UX-24: /tenants/* signup contract (web and mobile shapes)', () => {
  let app;
  let pkg;

  beforeAll(async () => {
    await setupTestDatabases();
    app = await startTestServer();
    pkg = await PlatformPackage.create({
      name: 'Starter',
      price: 5000,
      billingCycle: 'MONTHLY',
      maxBranches: 1,
      maxMembers: 200,
      maxTrainers: 5,
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  // A verified, non-host user, then POST /tenants/register. Returns tenant id
  // and a token carrying the GYM_HOST role, which clients get by refreshing
  // their JWT right after register.
  const registerHost = async (suffix) => {
    const user = await createUser({
      role: 'MEMBER',
      email: `ux24_${suffix}_${uuidv4().slice(0, 6)}@gymseratest.com`,
    });
    const memberToken = signToken({
      sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true,
    });
    const res = await request(app)
      .post(`${API}/tenants/register`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        businessName: 'UX24 Fitness',
        email: user.email,
        phone: '+923001234567',
        cityId: 1,
      });
    expect(res.status).toBeLessThan(300);
    const tenantId = res.body.data.tenant.id;
    const token = signToken({
      sub: user.id, id: user.id, email: user.email, role: 'GYM_HOST', isVerified: true, tenantId,
    });
    return { user, tenantId, token };
  };

  const baseProfile = {
    gymName: 'UX24 Gym',
    gymDescription: 'A gym used to pin the signup contract between clients.',
    genderType: 'MIXED',
    address: 'Main Boulevard, Peshawar',
    latitude: 34.01,
    longitude: 71.57,
  };

  const mainBranch = (extra = {}) => ({
    name: 'UX24 Gym',
    address: 'Main Boulevard, Peshawar',
    latitude: 34.01,
    longitude: 71.57,
    phone: null,
    openingTime: null,
    closingTime: null,
    cityId: 1,
    ...extra,
  });

  describe('register', () => {
    test('promotes the caller to host and creates a DRAFT tenant at step 1', async () => {
      const { user, tenantId } = await registerHost('reg');
      const tenant = await Tenant.findByPk(tenantId);
      expect(tenant.status).toBe('DRAFT');
      expect(tenant.onboardingStep).toBe(1);
      await user.reload();
      expect(user.role).toBe('GYM_HOST');
    });

    test('rejects a missing business name and a malformed email (422)', async () => {
      const user = await createUser({ role: 'MEMBER' });
      const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
      const res = await request(app)
        .post(`${API}/tenants/register`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(422);
    });

    test('accepts the optional-phone / optional-city shape mobile sends', async () => {
      const user = await createUser({ role: 'MEMBER' });
      const token = signToken({ sub: user.id, id: user.id, email: user.email, role: 'MEMBER', isVerified: true });
      const res = await request(app)
        .post(`${API}/tenants/register`)
        .set('Authorization', `Bearer ${token}`)
        .send({ businessName: 'No Phone Gym', email: user.email });
      expect(res.status).toBeLessThan(300);
    });
  });

  describe('M1: web shape (gym-profile without plans) cannot finalize', () => {
    test('finalize BANK_TRANSFER is refused with 400 when no membership plan was sent', async () => {
      const { tenantId, token } = await registerHost('web');

      // Exactly what gym-owner-register.tsx sends: no mainBranchData.plans.
      const profile = await request(app)
        .post(`${API}/tenants/${tenantId}/gym-profile`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...baseProfile, mainBranchData: mainBranch() });
      expect(profile.status).toBe(200);

      const select = await request(app)
        .post(`${API}/tenants/${tenantId}/select-package`)
        .set('Authorization', `Bearer ${token}`)
        .send({ packageId: pkg.id });
      expect(select.status).toBe(200);

      const finalize = await request(app)
        .post(`${API}/tenants/${tenantId}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ paymentMethod: 'BANK_TRANSFER', bankTransferRef: 'TXN-1' });

      expect(finalize.status).toBe(400);
      expect(finalize.body.message).toMatch(/at least 1 membership plan/i);

      const tenant = await Tenant.findByPk(tenantId);
      expect(tenant.status).toBe('DRAFT');
    });
  });

  describe('web shape with plans (target for the web wizard)', () => {
    test.each(['BANK_TRANSFER', 'PAY_LATER'])(
      'register -> gym-profile(plans) -> select-package -> finalize %s submits for review',
      async (paymentMethod) => {
        const { tenantId, token } = await registerHost(`web_${paymentMethod}`);

        const profile = await request(app)
          .post(`${API}/tenants/${tenantId}/gym-profile`)
          .set('Authorization', `Bearer ${token}`)
          .send({ ...baseProfile, mainBranchData: mainBranch({ plans: [MOBILE_PLAN] }) });
        expect(profile.status).toBe(200);

        const select = await request(app)
          .post(`${API}/tenants/${tenantId}/select-package`)
          .set('Authorization', `Bearer ${token}`)
          .send({ packageId: pkg.id });
        expect(select.status).toBe(200);

        const finalize = await request(app)
          .post(`${API}/tenants/${tenantId}/finalize`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            paymentMethod,
            ...(paymentMethod === 'BANK_TRANSFER' ? { bankTransferRef: 'TXN-2' } : {}),
          });
        expect(finalize.status).toBe(200);

        const tenant = await Tenant.findByPk(tenantId);
        expect(tenant.status).toBe('PENDING_REVIEW');
        expect(tenant.paymentMethod).toBe(paymentMethod);
        expect(tenant.selectedPackageId).toBe(pkg.id);
      }
    );
  });

  describe('mobile shape', () => {
    test('three gym-profile saves, then finalize IN_APP_PURCHASE with no select-package', async () => {
      const { tenantId, token } = await registerHost('mobile');
      const post = (body) =>
        request(app)
          .post(`${API}/tenants/${tenantId}/gym-profile`)
          .set('Authorization', `Bearer ${token}`)
          .send(body);

      // step 1 (saveStep1Data): name, description, gender only
      const s1 = await post({
        gymName: baseProfile.gymName,
        gymDescription: baseProfile.gymDescription,
        genderType: 'FEMALE_ONLY',
      });
      expect(s1.status).toBe(200);

      // step 2 (saveStep2Data): address + branch data
      const s2 = await post({
        gymName: baseProfile.gymName,
        gymDescription: baseProfile.gymDescription,
        genderType: 'FEMALE_ONLY',
        address: baseProfile.address,
        latitude: baseProfile.latitude,
        longitude: baseProfile.longitude,
        mainBranchData: mainBranch(),
      });
      expect(s2.status).toBe(200);

      // step 5 (saveStep5Plans): same branch data plus plans
      const s5 = await post({
        gymName: baseProfile.gymName,
        gymDescription: baseProfile.gymDescription,
        genderType: 'FEMALE_ONLY',
        address: baseProfile.address,
        latitude: baseProfile.latitude,
        longitude: baseProfile.longitude,
        mainBranchData: mainBranch({ plans: [MOBILE_PLAN] }),
      });
      expect(s5.status).toBe(200);

      // Plans survive the merge; later saves do not drop earlier fields.
      const stored = await Tenant.findByPk(tenantId);
      const branch = typeof stored.mainBranchDataJson === 'string'
        ? JSON.parse(stored.mainBranchDataJson)
        : stored.mainBranchDataJson;
      expect(branch.plans).toHaveLength(1);
      expect(branch.address).toBe(baseProfile.address);
      expect(stored.genderType).toBe('FEMALE_ONLY');

      const finalize = await request(app)
        .post(`${API}/tenants/${tenantId}/finalize`)
        .set('Authorization', `Bearer ${token}`)
        .send({ paymentMethod: 'IN_APP_PURCHASE' });
      expect(finalize.status).toBe(200);

      const done = await Tenant.findByPk(tenantId);
      expect(done.status).toBe('PENDING_REVIEW');
      expect(done.paymentMethod).toBe('IN_APP_PURCHASE');
      expect(done.selectedPackageId).toBeNull();
    });

    test('onboarding-images PUT replaces the staged list and keeps plans', async () => {
      const { tenantId, token } = await registerHost('images');
      await request(app)
        .post(`${API}/tenants/${tenantId}/gym-profile`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...baseProfile, mainBranchData: mainBranch({ plans: [MOBILE_PLAN] }) })
        .expect(200);

      const urls = ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'];
      const put = await request(app)
        .put(`${API}/tenants/${tenantId}/onboarding-images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imagesJson: urls });
      expect(put.status).toBe(200);

      const stored = await Tenant.findByPk(tenantId);
      const branch = typeof stored.mainBranchDataJson === 'string'
        ? JSON.parse(stored.mainBranchDataJson)
        : stored.mainBranchDataJson;
      expect(branch.imagesJson).toEqual(urls);
      expect(branch.plans).toHaveLength(1);
    });
  });

  describe('request validation both clients rely on', () => {
    test('gym-profile rejects an unknown genderType (422)', async () => {
      const { tenantId, token } = await registerHost('gender');
      const res = await request(app)
        .post(`${API}/tenants/${tenantId}/gym-profile`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...baseProfile, genderType: 'EVERYONE' });
      expect(res.status).toBe(422);
    });

    test('gym-profile rejects a plan with a negative price (422)', async () => {
      const { tenantId, token } = await registerHost('price');
      const res = await request(app)
        .post(`${API}/tenants/${tenantId}/gym-profile`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...baseProfile, mainBranchData: mainBranch({ plans: [{ ...MOBILE_PLAN, price: -1 }] }) });
      expect(res.status).toBe(422);
    });

    test('select-package rejects a non-UUID packageId (422)', async () => {
      const { tenantId, token } = await registerHost('pkgid');
      const res = await request(app)
        .post(`${API}/tenants/${tenantId}/select-package`)
        .set('Authorization', `Bearer ${token}`)
        .send({ packageId: 'starter' });
      expect(res.status).toBe(422);
    });

    test("another host cannot write to someone else's tenant (404)", async () => {
      const a = await registerHost('ownerA');
      const b = await registerHost('ownerB');
      const res = await request(app)
        .post(`${API}/tenants/${a.tenantId}/gym-profile`)
        .set('Authorization', `Bearer ${b.token}`)
        .send(baseProfile);
      expect(res.status).toBe(404);
    });
  });
});
