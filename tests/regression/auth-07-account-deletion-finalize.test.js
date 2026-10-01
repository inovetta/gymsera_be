/**
 * AUTH-07 (Prompt 1I, spec §14 R-16 / R-28): day 30 of an account deletion — the SWEEP.
 *
 * What it must do: anonymize in place, cancel a deleted tenant's memberships, scrub
 * personal data, and KEEP the financial records and the tenant database.
 * What it must never do: drop a database, touch money, or stop on one broken account.
 */
const { v4: uuidv4 } = require('uuid');
const { QueryTypes } = require('sequelize');
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
  SavedGym,
  PlatformAuditLog,
  UserGymMembership,
  TenantSubscription,
  PlatformInvoice,
} = require('../../src/models/platform');
const accountDeletionService = require('../../src/services/account-deletion.service');
const stripeBilling = require('../../src/services/stripe-billing.service');
const storageService = require('../../src/services/storage.service');
const TenantDbManager = require('../../src/database/TenantDbManager');
const { runDeletionFinalizeSweep, deletedEmail } = require('../../src/services/account-deletion-finalize.service');
const { runKycRetentionSweep } = require('../../src/jobs/kyc-retention.sweep');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'Test@12345';
const AFTER_WINDOW = () => new Date(Date.now() + 31 * DAY);

describe('AUTH-07: day-30 deletion sweep', () => {
  let dbHarness;
  let db1; // tenant 1 models: "someone else's gym" that member-only users belong to
  let db2; // tenant 2 models: the gym that gets deleted
  let mail;

  /** A gym in `tenantDb` with one member, one staff assignment, and money. */
  const seedGym = async (tenantDbCtx, tenantOverrides = {}) => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await factories.createTenant({
      ownerUserId: owner.id,
      connectionStringEncrypted: tenantDbCtx.encryptedConnStr,
      email: 'gym-owner-contact@gymseratest.com',
      phone: '+923001112222',
      address: '12 Fitness Road',
      bankTransferRef: 'BANK-REF-123',
      paymentDetailsJson: { iban: 'PK00TEST000000000000' },
      ...tenantOverrides,
    });
    const listing = await factories.createGymListing(tenant.id);
    const branch = await factories.createBranch(tenantDbCtx, listing.id, { name: 'Main' });
    await factories.createTenantSubscription(tenant.id, { platform: 'MANUAL', status: 'ACTIVE' });
    await PlatformInvoice.create({
      tenantId: tenant.id,
      invoiceNo: `INV-${uuidv4().slice(0, 8)}`,
      description: 'Plan',
      subtotal: 1000,
      taxAmount: 0,
      totalAmount: 1000,
      status: 'PAID',
    }).catch(() => null);
    return { owner, tenant, listing, branch, db: tenantDbCtx };
  };

  /** One member's personal rows + money in a gym. */
  const seedMember = async ({ db, tenant, listing, branch }, tag = 'm') => {
    const member = await factories.createUser({ role: 'MEMBER', email: `${tag}_${uuidv4().slice(0, 6)}@gymseratest.com`, phone: '+923009998888' });
    const { models } = db;
    const plan = await models.MembershipPlan.create({ gymId: (await models.Gym.findOne())?.id || uuidv4(), name: 'Monthly', price: 3000 }).catch(async () => {
      const gym = await models.Gym.create({ name: 'G' });
      return models.MembershipPlan.create({ gymId: gym.id, name: 'Monthly', price: 3000 });
    });
    const sub = await models.MemberSubscription.create({
      userId: member.id,
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * DAY),
      status: 'ACTIVE',
      notes: 'prefers mornings; knee injury',
      qrCode: `QR-${uuidv4()}`,
    });
    await models.MemberProfile.create({ userId: member.id, medicalNotes: 'asthma', emergencyContactName: 'Mum', emergencyContactPhone: '+92300000' });
    await models.AttendanceLog.create({ branchId: branch.id, userId: member.id, memberSubscriptionId: sub.id, attendanceType: 'GYM', checkInAt: new Date(), notes: 'came with a friend' }).catch(() => null);
    const payment = await factories.createPayment(db, branch.id, {
      userId: member.id,
      amount: 3000,
      notes: 'paid by Ali Khan, ref 123',
      proofUrl: `https://files.example.test/proofs/${uuidv4()}.jpg`,
      referenceEntityId: sub.id,
    });
    await UserGymMembership.create({
      userId: member.id,
      tenantId: tenant.id,
      gymListingId: listing.id,
      subscriptionId: sub.id,
      gymName: 'Test Gym',
      planName: 'Monthly',
      startDate: sub.startDate,
      endDate: sub.endDate,
      status: 'ACTIVE',
    });
    await RefreshToken.create({ userId: member.id, familyId: uuidv4(), token: `h-${uuidv4()}`, expiresAt: new Date(Date.now() + DAY), isRevoked: false });
    await DeviceToken.create({ userId: member.id, token: `fcm-${uuidv4()}`, platform: 'ios' });
    await SavedGym.create({ userId: member.id, gymListingId: listing.id });
    await Notification.create({ userId: member.id, role: 'traveler', type: 'X', title: 't', message: 'm' });
    return { member, sub, payment, plan };
  };

  const money = async (db) => {
    const payments = await db.models.Payment.findAll({ order: [['id', 'ASC']], raw: true });
    return payments.map((p) => ({ id: p.id, userId: p.userId, amount: String(p.amount), currency: p.currency, status: p.status, method: p.method, businessDate: p.businessDate, paymentFor: p.paymentFor }));
  };

  const request = async (user) => {
    // The request side is proven in auth-07-account-deletion-request.test.js; here it is only the starting point.
    await accountDeletionService.requestDeletion(user.id, { password: PASSWORD });
  };

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
    await startTestServer();
    db1 = dbHarness.tenant1;
    db2 = dbHarness.tenant2;
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

  test('before the 30 days are over NOTHING is touched, even when the sweep runs', async () => {
    const gym = await seedGym(db2);
    const { member } = await seedMember(gym);
    await request(gym.owner);
    const before = await money(db2);

    const res = await runDeletionFinalizeSweep({ now: new Date(Date.now() + 29 * DAY) });

    expect(res.tenants.map((t) => t.id)).not.toContain(gym.tenant.id);
    expect((await Tenant.findByPk(gym.tenant.id)).status).toBe('PENDING_DELETION');
    expect((await User.findByPk(gym.owner.id)).status).toBe('PENDING_DELETION');
    expect(await db2.models.MemberProfile.count({ where: { userId: member.id } })).toBe(1);
    expect(await money(db2)).toEqual(before);
  });

  test('--dry-run lists what is due and writes NOTHING', async () => {
    const gym = await seedGym(db2);
    await seedMember(gym);
    await request(gym.owner);
    const snapshot = async () => JSON.stringify([
      await Tenant.findByPk(gym.tenant.id, { raw: true }),
      await User.findByPk(gym.owner.id, { raw: true }),
      await db2.models.MemberProfile.findAll({ raw: true }),
      await db2.models.Payment.findAll({ order: [['id', 'ASC']], raw: true }),
      await PlatformAuditLog.count(),
    ]);
    const before = await snapshot();

    const res = await runDeletionFinalizeSweep({ dryRun: true, now: AFTER_WINDOW() });

    expect(res.dryRun).toBe(true);
    expect(res.tenants.map((t) => t.id)).toContain(gym.tenant.id);
    expect(res.users.map((u) => u.id)).toContain(gym.owner.id);
    expect(await snapshot()).toEqual(before);
  });

  describe('a deleted gym', () => {
    let gym;
    let m;
    let moneyBefore;
    let platformMoneyBefore;
    let deletedFiles;

    beforeAll(async () => {
      gym = await seedGym(db2);
      m = await seedMember(gym, 'gymmember');
      await factories.createRoleAssignment(db2, { userId: (await factories.createUser({ role: 'BRANCH_MANAGER' })).id, roleKey: 'BRANCH_MANAGER', scopeType: 'BRANCH', scopeId: gym.branch.id, branchIds: [gym.branch.id], tenantId: gym.tenant.id });
      await request(gym.owner);
      moneyBefore = await money(db2);
      platformMoneyBefore = {
        subs: (await TenantSubscription.findAll({ where: { tenantId: gym.tenant.id }, order: [['id', 'ASC']], raw: true })).map((s) => ({ id: s.id, status: s.status, amount: String(s.amount), platform: s.platform })),
        invoices: (await PlatformInvoice.findAll({ where: { tenantId: gym.tenant.id }, order: [['id', 'ASC']], raw: true })).map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, total: String(i.totalAmount), status: i.status })),
      };
      jest.spyOn(storageService, 'deleteImage').mockResolvedValue(undefined);
      await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });
      deletedFiles = storageService.deleteImage.mock.calls.map((c) => c[0]);
    });

    test('tenant is DELETED, keeps its name and database reference, loses contact and bank details', async () => {
      const t = await Tenant.findByPk(gym.tenant.id);
      expect(t.status).toBe('DELETED');
      expect(t.deletedAt).toBeTruthy();
      expect(t.businessName).toBe(gym.tenant.businessName);
      expect(t.connectionStringEncrypted).toBe(gym.tenant.connectionStringEncrypted); // the database is kept (R-28)
      expect([t.phone, t.address, t.bankTransferRef, t.paymentDetailsJson]).toEqual([null, null, null, null]);
      expect(t.email).toMatch(/@deleted\.gymsera\.invalid$/); // NOT NULL column: a placeholder
      // The tenant database is still there, with its tables and rows.
      const [{ n }] = await db2.sequelize.query('SELECT COUNT(*) AS n FROM payments', { type: QueryTypes.SELECT });
      expect(Number(n)).toBeGreaterThan(0);
    });

    test('FINANCIAL RECORDS ARE UNCHANGED: payments, platform subscriptions and invoices (R-16)', async () => {
      expect(await money(db2)).toEqual(moneyBefore);
      const subs = await TenantSubscription.findAll({ where: { tenantId: gym.tenant.id }, order: [['id', 'ASC']], raw: true });
      expect(subs.map((s) => ({ id: s.id, status: s.status, amount: String(s.amount), platform: s.platform }))).toEqual(platformMoneyBefore.subs);
      const invoices = await PlatformInvoice.findAll({ where: { tenantId: gym.tenant.id }, order: [['id', 'ASC']], raw: true });
      expect(invoices.map((i) => ({ id: i.id, invoiceNo: i.invoiceNo, total: String(i.totalAmount), status: i.status }))).toEqual(platformMoneyBefore.invoices);
    });

    test('personal data inside the tenant database is gone; memberships are cancelled; staff access revoked', async () => {
      expect(await db2.models.MemberProfile.count()).toBe(0);
      const sub = await db2.models.MemberSubscription.findByPk(m.sub.id);
      expect(sub.status).toBe('CANCELLED');
      expect(sub.notes).toBeNull();
      expect(sub.qrCode).toBeNull();
      const pay = await db2.models.Payment.findByPk(m.payment.id);
      expect([pay.notes, pay.proofUrl]).toEqual([null, null]);
      expect(Number(pay.amount)).toBe(3000);
      expect(await db2.models.RoleAssignment.count({ where: { status: { [require('sequelize').Op.ne]: 'REVOKED' } } })).toBe(0);
      expect(deletedFiles).toContain(m.payment.proofUrl); // the bank-slip photo is deleted too
    });

    test('the member keeps their OWN account and history; only the gym ended (R-28)', async () => {
      const member = await User.findByPk(m.member.id);
      expect(member.status).toBe('ACTIVE');
      expect(member.email).toBe(m.member.email);
      const membership = await UserGymMembership.findOne({ where: { userId: m.member.id, tenantId: gym.tenant.id } });
      expect(membership.status).toBe('CANCELLED');
      expect(membership.gymName).toBe('Test Gym'); // the gym's name stays on their history
    });

    test('the listing is INACTIVE and its contact details are removed', async () => {
      const l = await GymListing.findByPk(gym.listing.id);
      expect(l.status).toBe('INACTIVE');
      expect(l.contactPhone).toBeNull();
    });

    test('the owner account is anonymized: no name, e-mail, phone, password, provider ids, sessions, devices', async () => {
      const u = await User.findByPk(gym.owner.id);
      expect(u.status).toBe('DELETED');
      expect(u.deletedAt).toBeTruthy();
      expect(u.fullName).toBe('Deleted user');
      expect(u.email).toBe(deletedEmail(gym.owner.id));
      expect([u.phone, u.passwordHash, u.googleId, u.appleId, u.profileImageUrl]).toEqual([null, null, null, null, null]);
      expect(await RefreshToken.count({ where: { userId: gym.owner.id } })).toBe(0);
      expect(await DeviceToken.count({ where: { userId: gym.owner.id } })).toBe(0);
    });

    test('the old e-mail can no longer sign in, and the old token pair is useless', async () => {
      const authService = require('../../src/services/auth.service');
      await expect(authService.login({ email: gym.owner.email, password: PASSWORD }, '127.0.0.1', 'jest')).rejects.toMatchObject({ statusCode: 401 });
    });

    test('both finalizations are audited, with no personal data in the log', async () => {
      const t = await PlatformAuditLog.findAll({ where: { action: 'TENANT_DELETION_FINALIZED', targetId: gym.tenant.id } });
      const u = await PlatformAuditLog.findAll({ where: { action: 'ACCOUNT_DELETION_FINALIZED', targetId: gym.owner.id } });
      expect(t).toHaveLength(1);
      expect(u).toHaveLength(1);
      expect(JSON.stringify([t[0].details, u[0].details])).not.toContain(gym.owner.email);
    });

    test('running the sweep again changes nothing (idempotent)', async () => {
      const before = JSON.stringify([await Tenant.findByPk(gym.tenant.id, { raw: true }), await User.findByPk(gym.owner.id, { raw: true }), await money(db2)]);
      const again = await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });
      expect(again.tenants.map((t) => t.id)).not.toContain(gym.tenant.id);
      expect(JSON.stringify([await Tenant.findByPk(gym.tenant.id, { raw: true }), await User.findByPk(gym.owner.id, { raw: true }), await money(db2)])).toEqual(before);
    });

    test('its KYC documents are purged 90 days after the DELETION finished (R-16), not before', async () => {
      await Tenant.update({ kycDocumentsJson: [{ key: 'kyc/a.pdf', type: 'CNIC' }] }, { where: { id: gym.tenant.id } });
      const early = await runKycRetentionSweep({ dryRun: true, olderThanDays: 90 });
      expect(early.details.map((d) => d.tenantId)).not.toContain(gym.tenant.id);
      await Tenant.update({ deletedAt: new Date(Date.now() - 91 * DAY) }, { where: { id: gym.tenant.id } });
      const late = await runKycRetentionSweep({ dryRun: true, olderThanDays: 90 });
      expect(late.details.map((d) => d.tenantId)).toContain(gym.tenant.id);
    });
  });

  describe('a member-only account (someone else\'s gym stays open)', () => {
    let gym;
    let a;
    let b;
    let moneyBefore;

    /** Production quirk: tenant ids/user ids sit in columns of different collations. */
    const makeMixedCollation = async () => {
      for (const [table, column] of [
        ['payments', 'user_id'], ['member_subscriptions', 'user_id'], ['member_profiles', 'user_id'], ['attendance_logs', 'user_id'],
      ]) {
        const [col] = await db1.sequelize.query(
          'SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          { replacements: [table, column], type: QueryTypes.SELECT }
        );
        await db1.sequelize.query(
          `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${col.type} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci ${col.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`
        );
      }
    };

    beforeAll(async () => {
      await makeMixedCollation();
      gym = await seedGym(db1);
      a = await seedMember(gym, 'leaving');
      b = await seedMember(gym, 'staying');
      await request(a.member);
      moneyBefore = await money(db1);
      jest.spyOn(storageService, 'deleteImage').mockResolvedValue(undefined);
      await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });
    });

    test('works on a tenant database with mixed collations (no join, no "Illegal mix of collations")', async () => {
      const [col] = await db1.sequelize.query(
        "SELECT COLLATION_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'user_id'",
        { type: QueryTypes.SELECT }
      );
      expect(col.c).toBe('utf8mb4_general_ci');
      expect((await User.findByPk(a.member.id)).status).toBe('DELETED');
    });

    test('their personal rows in that gym are scrubbed, the money stays, the gym stays open', async () => {
      expect(await db1.models.MemberProfile.count({ where: { userId: a.member.id } })).toBe(0);
      const sub = await db1.models.MemberSubscription.findByPk(a.sub.id);
      expect([sub.status, sub.notes]).toEqual(['CANCELLED', null]);
      const pay = await db1.models.Payment.findByPk(a.payment.id);
      expect([pay.notes, pay.proofUrl, Number(pay.amount)]).toEqual([null, null, 3000]);
      expect(await money(db1)).toEqual(moneyBefore.map((p) => p));
      expect((await Tenant.findByPk(gym.tenant.id)).status).toBe('ACTIVE');
      expect((await GymListing.findByPk(gym.listing.id)).status).toBe('ACTIVE');
    });

    test('the OTHER member of the same gym is untouched', async () => {
      expect(await db1.models.MemberProfile.count({ where: { userId: b.member.id } })).toBe(1);
      const sub = await db1.models.MemberSubscription.findByPk(b.sub.id);
      expect([sub.status, sub.notes]).toEqual(['ACTIVE', 'prefers mornings; knee injury']);
      const pay = await db1.models.Payment.findByPk(b.payment.id);
      expect(pay.notes).toBe('paid by Ali Khan, ref 123');
      expect((await User.findByPk(b.member.id)).status).toBe('ACTIVE');
    });

    test('platform rows of the person are gone: sessions, devices, saved gyms, notifications, OTPs', async () => {
      const id = a.member.id;
      expect([
        await RefreshToken.count({ where: { userId: id } }),
        await DeviceToken.count({ where: { userId: id } }),
        await SavedGym.count({ where: { userId: id } }),
        await Notification.count({ where: { userId: id } }),
      ]).toEqual([0, 0, 0, 0]);
    });
  });

  describe('one broken account never stops the others, and is retried', () => {
    test('an unreachable tenant database leaves that tenant PENDING_DELETION (and its owner), the rest finish; the next run completes it', async () => {
      const good = await seedGym(db2);
      await request(good.owner);
      const bad = await seedGym(db2);
      await request(bad.owner);

      const real = TenantDbManager.getConnection.bind(TenantDbManager);
      const spy = jest.spyOn(TenantDbManager, 'getConnection').mockImplementation(async (id, conn) => {
        if (id === bad.tenant.id) throw new Error('connect ECONNREFUSED');
        return real(id, conn);
      });

      const first = await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });
      expect(first.failed.map((f) => f.id)).toEqual(expect.arrayContaining([bad.tenant.id, bad.owner.id]));
      expect((await Tenant.findByPk(good.tenant.id)).status).toBe('DELETED');
      expect((await Tenant.findByPk(bad.tenant.id)).status).toBe('PENDING_DELETION');
      expect((await User.findByPk(bad.owner.id)).status).toBe('PENDING_DELETION'); // not final while its tenant is not

      spy.mockRestore();
      const second = await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });
      expect(second.failed).toEqual([]);
      expect((await Tenant.findByPk(bad.tenant.id)).status).toBe('DELETED');
      expect((await User.findByPk(bad.owner.id)).status).toBe('DELETED');
    });

    test('a Stripe subscription whose cancel failed at request time is retried at day 30', async () => {
      const gym = await seedGym(db2);
      await TenantSubscription.create({
        tenantId: gym.tenant.id,
        platform: 'STRIPE',
        status: 'ACTIVE',
        externalOriginalTransactionId: 'sub_retry_me',
        startDate: new Date(),
        endDate: new Date(Date.now() + 30 * DAY),
      }).catch(async () => factories.createTenantSubscription(gym.tenant.id, { platform: 'STRIPE', status: 'ACTIVE', externalOriginalTransactionId: 'sub_retry_me' }));
      const cancel = jest.spyOn(stripeBilling, 'cancelAtPeriodEnd').mockRejectedValueOnce(new Error('stripe down')).mockResolvedValue(undefined);
      await request(gym.owner); // first attempt fails (audited)

      await runDeletionFinalizeSweep({ now: AFTER_WINDOW() });

      expect(cancel).toHaveBeenCalledTimes(2);
      expect((await Tenant.findByPk(gym.tenant.id)).status).toBe('DELETED');
    });
  });

  test('the source never contains a DROP DATABASE / DROP TABLE for this flow', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['services/account-deletion.service.js', 'services/account-deletion-finalize.service.js', 'scripts/run-account-deletion-sweep.js']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src', f), 'utf8');
      expect(src).not.toMatch(/DROP\s+(DATABASE|TABLE|SCHEMA)/i);
      expect(src).not.toMatch(/dropDatabase/);
    }
  });
});
