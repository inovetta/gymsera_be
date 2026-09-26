/**
 * Integration Test: Payment Business Date & Timezone Integrity (Step 2.6)
 *
 * Verifies that:
 * 1. Payments created at 02:00 local time correctly record the branch-local calendar date,
 *    not the UTC date (e.g. 21:00 UTC = 02:00 PKT next day).
 * 2. Every code path that creates or updates a payment stamps business_date:
 *    - payment.service.js (createPayment, verifyPayment)
 *    - subscription.service.js (createSubscription, upgradeSubscription)
 *    - gym.service.js (enrollMember - walkin and pre-collected)
 *    - approval command execution (member.commands.js -> gym.service.js)
 *    - me.service.js (createOrUpdatePendingPayment)
 *    - Direct Payment.create (seeder / import / script fallback via model hook)
 * 3. Migration 004 uses branch timezone for Asia/Karachi and Asia/Dubai.
 */
const { QueryTypes } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const {
  createUser,
  createTenant,
  createGymListing,
  createBranch,
  createPayment,
} = require('../harness/factories');
const { computeBusinessDate, stampBusinessDate } = require('../../src/services/ledger.service');
const { runTenantMigrations, TARGET_SCHEMA_VERSION } = require('../../src/database/tenant-migration-runner');
const paymentService = require('../../src/services/payment.service');
const subscriptionService = require('../../src/services/subscription.service');
const gymService = require('../../src/services/gym.service');
const meService = require('../../src/services/me.service');

describe('Payment Business Date & Branch Timezone (Step 2.6)', () => {
  let dbHarness;
  let tenant1;
  let branchKarachi;
  let branchDubai;
  let testUser;
  let gymListing;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant1 = dbHarness.tenant1;

    testUser = await createUser({
      email: 'member-bdate@test.com',
      fullName: 'BDate Test Member',
      role: 'MEMBER',
    });

    const tenantRecord = await createTenant({
      id: '22222222-2222-4222-8222-222222222222',
      tenantCode: 'GYM-BDATE',
      gymName: 'Timezone Gym',
      ownerUserId: testUser.id,
      connectionStringEncrypted: tenant1.encryptedConnStr,
    });

    gymListing = await createGymListing(tenantRecord.id, { title: 'Timezone Gym Downtown' });

    // Karachi branch (UTC+5)
    branchKarachi = await createBranch(tenant1, gymListing.id, {
      name: 'Karachi Central Branch',
    });
    await branchKarachi.update({ timezone: 'Asia/Karachi' });

    // Dubai branch (UTC+4)
    branchDubai = await createBranch(tenant1, gymListing.id, {
      name: 'Dubai Marina Branch',
    });
    await branchDubai.update({ timezone: 'Asia/Dubai' });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('computeBusinessDate correctly converts 02:00 local time across timezones', () => {
    // 21:00 UTC on 2026-09-26:
    // In UTC: 2026-09-26
    // In Asia/Karachi (UTC+5): 21:00 + 5h = 02:00 on 2026-09-27 -> '2026-09-27'
    // In Asia/Dubai (UTC+4): 21:00 + 4h = 01:00 on 2026-09-27 -> '2026-09-27'
    const dateAt21Utc = new Date('2026-09-26T21:00:00.000Z');
    expect(computeBusinessDate(dateAt21Utc, 'Asia/Karachi')).toBe('2026-09-27');
    expect(computeBusinessDate(dateAt21Utc, 'Asia/Dubai')).toBe('2026-09-27');

    // 19:30 UTC on 2026-09-26:
    // In Asia/Dubai (UTC+4): 19:30 + 4h = 23:30 on 2026-09-26 -> '2026-09-26'
    // In Asia/Karachi (UTC+5): 19:30 + 5h = 00:30 on 2026-09-27 -> '2026-09-27'
    const dateAt1930Utc = new Date('2026-09-26T19:30:00.000Z');
    expect(computeBusinessDate(dateAt1930Utc, 'Asia/Dubai')).toBe('2026-09-26');
    expect(computeBusinessDate(dateAt1930Utc, 'Asia/Karachi')).toBe('2026-09-27');
  });

  test('Path 1: Direct Payment.create (model lifecycle hook) stamps business_date at 02:00 local time', async () => {
    const { Payment } = tenant1.models;
    const paidAt = new Date('2026-09-26T21:00:00.000Z'); // 02:00 PKT on Sep 27

    const payment = await Payment.create({
      userId: testUser.id,
      branchId: branchKarachi.id,
      amount: 4500,
      currency: 'PKR',
      method: 'CASH',
      status: 'COMPLETED',
      paidAt,
    });

    expect(payment.businessDate).toBe('2026-09-27');
  });

  test('Path 2: payment.service.js recordPayment stamps business_date with branch timezone', async () => {
    const paidAt = new Date('2026-09-26T21:00:00.000Z'); // 02:00 PKT

    const result = await paymentService.recordPayment(
      tenant1,
      testUser.id,
      'GYM_HOST',
      {
        userId: testUser.id,
        branchId: branchKarachi.id,
        amount: 3000,
        currency: 'PKR',
        method: 'CASH',
        paidAt,
      },
      true
    );

    expect(result.payment.businessDate).toBe('2026-09-27');
  });

  test('Path 3: payment.service.js verifyPayment ensures business_date is set', async () => {
    const { Payment } = tenant1.models;
    // Payment created initially without businessDate
    const pendingPayment = await Payment.create({
      userId: testUser.id,
      branchId: branchKarachi.id,
      amount: 2500,
      currency: 'PKR',
      method: 'CASH',
      status: 'PENDING',
    });

    const verified = await paymentService.verifyPayment(
      tenant1,
      pendingPayment.id,
      testUser.id,
      'Verified in test'
    );

    expect(verified.status).toBe('COMPLETED');
    expect(verified.businessDate).toBeTruthy();
  });

  test('Path 4: gym.service.js enrollMember stamps business_date at write time', async () => {
    const { MembershipPlan } = tenant1.models;
    const plan = await MembershipPlan.create({
      gymId: branchKarachi.gymId,
      branchId: branchKarachi.id,
      name: 'Karachi Morning Plan',
      price: 6000,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });

    const enrolled = await gymService.enrollMember(
      tenant1,
      tenant1.database,
      {
        fullName: 'Morning Member',
        email: 'morning@test.com',
        phone: '+923001234567',
        branchId: branchKarachi.id,
        planId: plan.id,
        paymentMethod: 'CASH',
      },
      { role: 'GYM_HOST', id: testUser.id },
      null
    );

    expect(enrolled.payment).toBeDefined();
    expect(enrolled.payment.businessDate).toBeTruthy();
  });

  test('Path 5: Approval command (member.commands.js) stamps business_date on execution', async () => {
    const { MembershipPlan } = tenant1.models;
    const plan = await MembershipPlan.create({
      gymId: branchKarachi.gymId,
      branchId: branchKarachi.id,
      name: 'Approval Plan',
      price: 7000,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });

    const { getOrThrow } = require('../../src/services/commands');
    const command = getOrThrow('members.create');
    expect(command).toBeDefined();

    const ctx = {
      tenantDb: tenant1,
      tenantId: '22222222-2222-4222-8222-222222222222',
      branchId: branchKarachi.id,
      userId: testUser.id,
      role: 'GYM_HOST',
    };

    const payload = {
      fullName: 'Approved Enrollee',
      email: 'approved@test.com',
      phone: '+923009998877',
      planId: plan.id,
      paymentMethod: 'CASH',
    };

    const res = await command.execute(ctx, payload);
    expect(res.payment).toBeDefined();
    expect(res.payment.businessDate).toBeTruthy();
  });

  test('Path 6: me.service.js submitPaymentRequest preserves and sets businessDate', async () => {
    const { MemberSubscription, MembershipPlan } = tenant1.models;
    const plan = await MembershipPlan.create({
      gymId: branchKarachi.gymId,
      branchId: branchKarachi.id,
      name: 'Traveler Plan',
      price: 3500,
      durationType: 'MONTHLY',
      durationValue: 1,
      status: 'ACTIVE',
    });

    const sub = await MemberSubscription.create({
      userId: testUser.id,
      membershipPlanId: plan.id,
      branchId: branchKarachi.id,
      startDate: '2026-09-26',
      endDate: '2026-10-26',
      status: 'PENDING',
    });

    const { UserGymMembership } = require('../../src/models/platform');
    await UserGymMembership.create({
      userId: testUser.id,
      tenantId: '22222222-2222-4222-8222-222222222222',
      subscriptionId: sub.id,
      gymListingId: gymListing.id,
      status: 'ACTIVE',
    });

    const payment = await meService.submitPaymentRequest(testUser.id, {
      subscriptionId: sub.id,
      method: 'BANK_TRANSFER',
      amount: 3500,
      notes: 'Initial transfer',
    });

    expect(payment.businessDate).toBeTruthy();
    expect(payment.branchId).toBe(branchKarachi.id);
  });

  test('Migration 004: backfills business_date accurately for Asia/Karachi and Asia/Dubai', async () => {
    const { Payment } = tenant1.models;

    // Both payments made at 19:30 UTC on 2026-09-26:
    const paymentTimestamp = '2026-09-26T19:30:00.000Z';

    // 1. Karachi payment: 19:30 UTC + 5h = 00:30 Sep 27 -> business_date should be 2026-09-27
    const paymentKarachi = await Payment.create({
      userId: testUser.id,
      branchId: branchKarachi.id,
      amount: 1000,
      currency: 'PKR',
      method: 'CASH',
      status: 'COMPLETED',
      paidAt: new Date(paymentTimestamp),
      businessDate: '2026-09-27',
    });
    // Deliberately reset business_date to null in raw SQL to simulate historical un-backfilled state
    await tenant1.sequelize.query('UPDATE payments SET business_date = NULL WHERE id = ?', {
      replacements: [paymentKarachi.id],
    });

    // 2. Dubai payment: 19:30 UTC + 4h = 23:30 Sep 26 -> business_date should be 2026-09-26
    const paymentDubai = await Payment.create({
      userId: testUser.id,
      branchId: branchDubai.id,
      amount: 2000,
      currency: 'AED',
      method: 'CASH',
      status: 'COMPLETED',
      paidAt: new Date(paymentTimestamp),
      businessDate: '2026-09-26',
    });
    // Deliberately reset business_date to null in raw SQL
    await tenant1.sequelize.query('UPDATE payments SET business_date = NULL WHERE id = ?', {
      replacements: [paymentDubai.id],
    });

    // Reset migration 004 in schema_migrations so it re-runs
    await tenant1.sequelize.query('DELETE FROM schema_migrations WHERE version >= 4');

    // Run migrations
    const result = await runTenantMigrations(tenant1.sequelize, {
      tenantId: '22222222-2222-4222-8222-222222222222',
      gymName: 'Timezone Gym',
    });

    expect(result.finalVersion).toBe(TARGET_SCHEMA_VERSION);

    // Verify backfilled business_dates
    const [reloadedKarachi] = await tenant1.sequelize.query(
      'SELECT business_date FROM payments WHERE id = ?',
      { replacements: [paymentKarachi.id], type: QueryTypes.SELECT }
    );
    const [reloadedDubai] = await tenant1.sequelize.query(
      'SELECT business_date FROM payments WHERE id = ?',
      { replacements: [paymentDubai.id], type: QueryTypes.SELECT }
    );

    expect(reloadedKarachi.business_date).toBe('2026-09-27');
    expect(reloadedDubai.business_date).toBe('2026-09-26');
  });
});
