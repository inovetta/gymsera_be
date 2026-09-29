const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
} = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { Notification, UserGymMembership } = require('../../src/models/platform');
const paymentService = require('../../src/services/payment.service');
const subscriptionService = require('../../src/services/subscription.service');
const { runExpiryCheck } = require('../../src/jobs/subscription-expiry.cron');
const { SubscriptionStatus } = require('../../src/constants/subscription-status');
const { PaymentStatus } = require('../../src/constants/payment-status');
const { v4: uuidv4 } = require('uuid');

describe('Direct Member Notifications (Option B - Redis/Bull removed for member events)', () => {
  let dbHarness;
  let tenant;
  let tenantDb;
  let branch;
  let gymListing;
  let mailFake;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantDb = dbHarness.tenant1;
    tenant = await factories.createTenant({ gymName: 'Iron Fitness' });
    gymListing = await factories.createGymListing(tenant.id, { title: 'Iron Fitness Main' });
    branch = await factories.createBranch(tenantDb, gymListing.id, {
      branchName: 'Downtown Branch',
      timezone: 'Asia/Karachi',
    });
    mailFake = installMailFake();
  });

  afterAll(async () => {
    mailFake.send.mockRestore();
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    mailFake.sent.length = 0;
    await Notification.destroy({ where: {}, truncate: true, cascade: true });
  });

  test('Path 1: markPaymentFailed directly dispatches in-app notification and email to member without Bull/Redis', async () => {
    const member = await factories.createUser({
      fullName: 'John PaymentFail',
      email: 'john.fail@gymseratest.com',
      role: 'MEMBER',
    });

    const payment = await tenantDb.models.Payment.create({
      id: uuidv4(),
      userId: member.id,
      branchId: branch.id,
      amount: 4500.00,
      currency: 'PKR',
      method: 'CASH',
      paymentFor: 'MEMBERSHIP',
      status: PaymentStatus.PENDING,
      businessDate: '2026-09-29',
    });

    await paymentService.markPaymentFailed(tenantDb, payment.id, 'Iron Fitness');

    // 1. Verify in-app notification in MySQL
    const notif = await Notification.findOne({
      where: { userId: member.id },
    });
    expect(notif).toBeTruthy();
    expect(notif.title).toBe('Payment Failed');
    expect(notif.type).toBe('warning');
    expect(notif.message).toContain('4500');
    expect(notif.message).toContain('Iron Fitness');

    // 2. Verify email sent
    const email = mailFake.sent.find((m) => m.to === member.email);
    expect(email).toBeTruthy();
    expect(email.subject).toContain('Payment Failed');
  });

  test('Path 2: renewSubscription directly dispatches in-app notification and email to member without Bull/Redis', async () => {
    const member = await factories.createUser({
      fullName: 'Alice Renewal',
      email: 'alice.renew@gymseratest.com',
      role: 'MEMBER',
    });

    const plan = await tenantDb.models.MembershipPlan.create({
      id: uuidv4(),
      gymId: branch.gymId,
      branchId: branch.id,
      name: 'Gold Monthly',
      durationType: 'MONTHLY',
      durationValue: 1,
      price: 6000.00,
      currency: 'PKR',
      status: 'ACTIVE',
    });

    const sub = await tenantDb.models.MemberSubscription.create({
      id: uuidv4(),
      userId: member.id,
      branchId: branch.id,
      membershipPlanId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      startDate: '2026-08-01',
      endDate: '2026-09-01',
      qrCode: 'GE-OLD-TOKEN-123',
    });

    await UserGymMembership.create({
      id: uuidv4(),
      userId: member.id,
      tenantId: tenant.id,
      branchId: branch.id,
      gymListingId: gymListing.id,
      subscriptionId: sub.id,
      gymName: 'Iron Fitness',
      planName: plan.name,
      status: SubscriptionStatus.ACTIVE,
      startDate: '2026-08-01',
      endDate: '2026-09-01',
    });

    await subscriptionService.renew(member.id, sub.id, null, '2026-09-01');

    // 1. Verify in-app notification in MySQL
    const notif = await Notification.findOne({
      where: { userId: member.id },
    });
    expect(notif).toBeTruthy();
    expect(notif.title).toBe('Subscription Renewed');
    expect(notif.type).toBe('subscription');
    expect(notif.message).toContain('Gold Monthly');
    expect(notif.message).toContain('Iron Fitness');

    // 2. Verify email sent
    const email = mailFake.sent.find((m) => m.to === member.email);
    expect(email).toBeTruthy();
    expect(email.subject).toContain('Subscription Renewed');
  });

  test('Path 3: subscription-expiry cron directly dispatches in-app notification and email to member without Bull/Redis', async () => {
    const member = await factories.createUser({
      fullName: 'Bob ExpirySoon',
      email: 'bob.expiring@gymseratest.com',
      role: 'MEMBER',
    });

    const today = new Date();
    const inTwoDays = new Date(today);
    inTwoDays.setDate(today.getDate() + 2);
    const inTwoDaysStr = inTwoDays.toISOString().split('T')[0];

    const plan = await tenantDb.models.MembershipPlan.create({
      id: uuidv4(),
      gymId: branch.gymId,
      branchId: branch.id,
      name: 'Standard Membership',
      durationType: 'MONTHLY',
      durationValue: 1,
      price: 5000.00,
      currency: 'PKR',
      status: 'ACTIVE',
    });

    const sub = await tenantDb.models.MemberSubscription.create({
      id: uuidv4(),
      userId: member.id,
      branchId: branch.id,
      membershipPlanId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      startDate: '2026-08-29',
      endDate: inTwoDaysStr,
      qrCode: 'GE-EXP-TOKEN-456',
    });

    await UserGymMembership.create({
      id: uuidv4(),
      userId: member.id,
      tenantId: tenant.id,
      branchId: branch.id,
      gymListingId: gymListing.id,
      subscriptionId: sub.id,
      gymName: 'Iron Fitness',
      planName: plan.name,
      status: SubscriptionStatus.ACTIVE,
      startDate: '2026-08-29',
      endDate: inTwoDaysStr,
    });

    await runExpiryCheck();

    // 1. Verify in-app notification in MySQL
    const notif = await Notification.findOne({
      where: { userId: member.id },
    });
    expect(notif).toBeTruthy();
    expect(notif.title).toBe('Plan Expiring Soon');
    expect(notif.type).toBe('expiry');
    expect(notif.message).toContain('Iron Fitness');
    expect(notif.message).toContain(inTwoDaysStr);

    // 2. Verify email sent
    const email = mailFake.sent.find((m) => m.to === member.email);
    expect(email).toBeTruthy();
    expect(email.subject).toContain('expires soon');
  });
});
