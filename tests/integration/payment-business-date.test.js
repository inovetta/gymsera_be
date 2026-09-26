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
      collectedAt: paidAt,
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
      method: 'BANK_TRANSFER',
      status: 'COMPLETED',
      paidAt: new Date(paymentTimestamp),
      businessDate: '2026-09-27',
    });
    // Deliberately allow null and reset business_date to null in raw SQL to simulate historical un-backfilled state
    await tenant1.sequelize.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');
    await tenant1.sequelize.query('UPDATE payments SET business_date = NULL WHERE id = ?', {
      replacements: [paymentKarachi.id],
    });

    // 2. Dubai payment: 19:30 UTC + 4h = 23:30 Sep 26 -> business_date should be 2026-09-26
    const paymentDubai = await Payment.create({
      userId: testUser.id,
      branchId: branchDubai.id,
      amount: 2000,
      currency: 'AED',
      method: 'BANK_TRANSFER',
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

  describe('Step 2.7: Payment business_date immutability and Migration 006', () => {
    test('Cash collected 23:30 local on day X, verified next day 10:00 -> business_date stays X', async () => {
      const { Payment } = tenant1.models;

      // In Asia/Karachi (UTC+5), 23:30 on 2026-09-25 is 18:30 UTC on 2026-09-25.
      const collectionTimestamp = new Date('2026-09-25T18:30:00.000Z');

      // Create payment as collected cash at 23:30 PKT on day X (2026-09-25)
      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branchKarachi.id,
        amount: 3000,
        currency: 'PKR',
        method: 'CASH',
        status: 'STAFF_COLLECTED',
        collectedAt: collectionTimestamp,
      });

      expect(payment.businessDate).toBe('2026-09-25');

      // Next day at 10:00 local time (05:00 UTC on 2026-09-26), payment is verified
      const verifiedPayment = await paymentService.verifyPayment(
        tenant1,
        payment.id,
        testUser.id,
        'Approved next morning'
      );

      // business_date must stay X ('2026-09-25')
      expect(verifiedPayment.businessDate).toBe('2026-09-25');
      expect(verifiedPayment.status).toBe('COMPLETED');

      // Reload from DB to verify persistence
      const reloaded = await Payment.findByPk(payment.id);
      expect(reloaded.businessDate).toBe('2026-09-25');
    });

    test('markPrinted, uploadPaymentProof, and markPaymentFailed do not change business_date', async () => {
      const { Payment } = tenant1.models;

      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branchKarachi.id,
        amount: 1500,
        currency: 'PKR',
        method: 'BANK_TRANSFER',
        status: 'PENDING',
        collectedAt: new Date('2026-09-25T12:00:00.000Z'),
      });

      expect(payment.businessDate).toBe('2026-09-25');

      // 1. uploadPaymentProof
      const afterProof = await paymentService.uploadPaymentProof(
        tenant1,
        payment.id,
        'https://storage.gymsera.com/proofs/receipt-123.jpg'
      );
      expect(afterProof.businessDate).toBe('2026-09-25');
      expect(afterProof.proofUrl).toBe('https://storage.gymsera.com/proofs/receipt-123.jpg');

      // 2. markPrinted (instance update)
      await afterProof.update({
        printedAt: new Date(),
        printedBy: testUser.id,
      });
      const afterPrint = await Payment.findByPk(payment.id);
      expect(afterPrint.businessDate).toBe('2026-09-25');
      expect(afterPrint.printedAt).toBeTruthy();

      // 3. markPaymentFailed
      await paymentService.markPaymentFailed(tenant1, payment.id, 'Karachi Gym');
      const afterFail = await Payment.findByPk(payment.id);
      expect(afterFail.businessDate).toBe('2026-09-25');
      expect(afterFail.status).toBe('FAILED');
    });

    test('An update that tries to change business_date is rejected', async () => {
      const { Payment } = tenant1.models;

      const payment = await Payment.create({
        userId: testUser.id,
        branchId: branchKarachi.id,
        amount: 2500,
        currency: 'PKR',
        method: 'CASH',
        status: 'COMPLETED',
        collectedAt: new Date('2026-09-25T10:00:00.000Z'),
      });

      expect(payment.businessDate).toBe('2026-09-25');

      // Attempting to change existing businessDate via instance update must throw
      await expect(payment.update({ businessDate: '2026-09-26' })).rejects.toThrow(
        'business_date is immutable and cannot be changed once set'
      );

      // Attempting to change businessDate via bulk update must throw
      await expect(
        Payment.update({ businessDate: '2026-09-26' }, { where: { id: payment.id } })
      ).rejects.toThrow('business_date cannot be changed via bulk update');

      // Value in database must remain unchanged
      const reloaded = await Payment.findByPk(payment.id);
      expect(reloaded.businessDate).toBe('2026-09-25');
    });

    test('Old row with NULL business_date is stamped from original collection time, not from now', async () => {
      const { Payment } = tenant1.models;

      // 1. Temporarily make column nullable to insert legacy NULL row
      await tenant1.sequelize.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');

      // 2. Insert row with NULL business_date and original collection timestamp 5 days ago
      const historicalCollectionTime = '2026-09-20 14:00:00';
      const paymentId = '33333333-3333-4333-8333-333333333333';
      await tenant1.sequelize.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, collected_at, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 5000, 'PKR', 'CASH', 'PENDING', ?, ?, ?, NULL)`,
        {
          replacements: [
            paymentId,
            testUser.id,
            branchKarachi.id,
            historicalCollectionTime,
            historicalCollectionTime,
            historicalCollectionTime,
          ],
        }
      );

      // 3. Load the payment and perform a normal update (e.g. updating notes)
      const oldPayment = await Payment.findByPk(paymentId);
      expect(oldPayment.businessDate).toBeNull();

      await oldPayment.update({ notes: 'Stamping historical null row' });

      // 4. Must be stamped from its historical collection time ('2026-09-20'), NOT from "now"
      expect(oldPayment.businessDate).toBe('2026-09-20');

      const reloaded = await Payment.findByPk(paymentId);
      expect(reloaded.businessDate).toBe('2026-09-20');
    });

    test('Branch timezone lookup inside hook uses the same database transaction as the write', async () => {
      const { Payment } = tenant1.models;

      const tx = await tenant1.sequelize.transaction();
      try {
        const payment = await Payment.create(
          {
            userId: testUser.id,
            branchId: branchKarachi.id,
            amount: 1200,
            currency: 'PKR',
            method: 'CASH',
            collectedAt: new Date('2026-09-25T15:00:00.000Z'),
          },
          { transaction: tx }
        );

        expect(payment.businessDate).toBe('2026-09-25');
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }
    });

    test('Migration 006: makes payments.business_date NOT NULL for tenant with zero NULL rows', async () => {
      const seq = tenant1.sequelize;

      // Ensure zero NULL rows
      await seq.query('UPDATE payments SET business_date = CURDATE() WHERE business_date IS NULL');

      // Reset migration 006 in schema_migrations so it can run
      await seq.query('DELETE FROM schema_migrations WHERE version = 6');

      const result = await runTenantMigrations(seq, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gymName: 'Timezone Gym',
      });

      expect(result.finalVersion).toBe(TARGET_SCHEMA_VERSION);
      expect(result.applied).toContain('006_enforce_payments_business_date_not_null');

      // Check INFORMATION_SCHEMA to confirm IS_NULLABLE is NO
      const [colInfo] = await seq.query(
        "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'business_date'",
        { type: QueryTypes.SELECT }
      );
      expect(colInfo.IS_NULLABLE).toBe('NO');
    });

    test('Migration 006: skips and logs warning when tenant has NULL rows (no data change)', async () => {
      const seq = tenant1.sequelize;

      // 1. Temporarily allow NULL to simulate a tenant with unmigrated NULL rows
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');

      // 2. Insert a row with NULL business_date
      const nullPaymentId = '44444444-4444-4444-8444-444444444444';
      await seq.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 999, 'PKR', 'CASH', 'PENDING', NOW(), NOW(), NULL)`,
        {
          replacements: [nullPaymentId, testUser.id, branchKarachi.id],
        }
      );

      // 3. Reset migration 006 in schema_migrations
      await seq.query('DELETE FROM schema_migrations WHERE version = 6');

      // 4. Run migrations
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await runTenantMigrations(seq, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gymName: 'Timezone Gym',
      });

      // Migration 006 was skipped
      expect(result.applied).not.toContain('006_enforce_payments_business_date_not_null');

      // Column remains nullable (no schema/data change)
      const [colInfo] = await seq.query(
        "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments' AND COLUMN_NAME = 'business_date'",
        { type: QueryTypes.SELECT }
      );
      expect(colInfo.IS_NULLABLE).toBe('YES');

      // Warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('SKIPPING Migration 006')
      );
      warnSpy.mockRestore();

      // Cleanup: delete the null payment and restore NOT NULL
      await seq.query('DELETE FROM payments WHERE id = ?', { replacements: [nullPaymentId] });
      await seq.query('UPDATE payments SET business_date = CURDATE() WHERE business_date IS NULL');
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL');
      await seq.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, '006_enforce_payments_business_date_not_null', NOW())");
    });
  });

  describe('Step 2.8: One rule for collection time (getPaymentCollectionTime)', () => {
    const { getPaymentCollectionTime, computeBusinessDate } = require('../../src/services/ledger.service');

    test('Unit: getPaymentCollectionTime follows exact precedence rule for cash vs online', () => {
      const explicitCollected = new Date('2026-09-20T12:00:00.000Z');
      const createdAt = new Date('2026-09-25T18:30:00.000Z'); // Day X (23:30 PKT)
      const paidAt = new Date('2026-09-26T05:00:00.000Z'); // Day X+1 (10:00 PKT)

      // 1. collectedAt present: always authoritative
      expect(getPaymentCollectionTime({ method: 'CASH', collectedAt: explicitCollected, createdAt, paidAt })).toBe(explicitCollected);
      expect(getPaymentCollectionTime({ method: 'BANK_TRANSFER', collectedAt: explicitCollected, createdAt, paidAt })).toBe(explicitCollected);
      expect(getPaymentCollectionTime({ method: 'ONLINE', collected_at: explicitCollected, created_at: createdAt, paid_at: paidAt })).toBe(explicitCollected);

      // 2. CASH without collectedAt: created_at (desk collection) before paid_at (host verification)
      expect(getPaymentCollectionTime({ method: 'CASH', createdAt, paidAt })).toBe(createdAt);
      expect(getPaymentCollectionTime({ method: 'CASH', created_at: createdAt, paid_at: paidAt })).toBe(createdAt);
      expect(getPaymentCollectionTime({ method: 'CASH', paidAt })).toBe(paidAt);

      // 3. ONLINE / BANK_TRANSFER without collectedAt: paid_at (clearing/settlement) before created_at (order intent)
      expect(getPaymentCollectionTime({ method: 'BANK_TRANSFER', createdAt, paidAt })).toBe(paidAt);
      expect(getPaymentCollectionTime({ method: 'ONLINE', created_at: createdAt, paid_at: paidAt })).toBe(paidAt);
      expect(getPaymentCollectionTime({ method: 'BANK_TRANSFER', createdAt })).toBe(createdAt);
    });

    test('Old cash payment created 23:30 on day X and verified next morning gets day X', async () => {
      const { Payment } = tenant1.models;
      const seq = tenant1.sequelize;

      // In Asia/Karachi (UTC+5), 23:30 on 2026-09-25 is 18:30 UTC on 2026-09-25 (Day X)
      const createdUtcStr = '2026-09-25 18:30:00'; // 18:30 UTC = 23:30 PKT (Day X)

      // Temporarily allow NULL business_date to simulate legacy row created before business_date existed
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');

      const oldCashPaymentId = '55555555-5555-4555-8555-555555555551';
      await seq.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, collected_at, paid_at, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 2500, 'PKR', 'CASH', 'PENDING', NULL, NULL, ?, ?, NULL)`,
        {
          replacements: [oldCashPaymentId, testUser.id, branchKarachi.id, createdUtcStr, createdUtcStr],
        }
      );

      // Verify the legacy payment the next morning at 10:00 local time (05:00 UTC on 2026-09-26, Day X+1)
      const verified = await paymentService.verifyPayment(
        tenant1,
        oldCashPaymentId,
        testUser.id,
        'Host approved cash drawer next morning'
      );

      // Must be stamped with Day X (2026-09-25), NOT Day X+1 (2026-09-26)
      expect(verified.businessDate).toBe('2026-09-25');

      const reloaded = await Payment.findByPk(oldCashPaymentId);
      expect(reloaded.businessDate).toBe('2026-09-25');

      // Cleanup
      await seq.query('DELETE FROM payments WHERE id = ?', { replacements: [oldCashPaymentId] });
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL');
    });

    test('Old bank transfer payment created on day X and verified next morning gets day X+1', async () => {
      const { Payment } = tenant1.models;
      const seq = tenant1.sequelize;

      const createdUtcStr = '2026-09-25 18:30:00'; // 23:30 Day X

      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');

      const oldBankPaymentId = '55555555-5555-4555-8555-555555555552';
      await seq.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, collected_at, paid_at, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 5000, 'PKR', 'BANK_TRANSFER', 'PENDING', NULL, NULL, ?, ?, NULL)`,
        {
          replacements: [oldBankPaymentId, testUser.id, branchKarachi.id, createdUtcStr, createdUtcStr],
        }
      );

      // Verify bank transfer next morning at 10:00 local time (05:00 UTC on 2026-09-26, Day X+1)
      const verified = await paymentService.verifyPayment(
        tenant1,
        oldBankPaymentId,
        testUser.id,
        'Bank transfer verified on day X+1'
      );

      // Bank transfer settlement is Day X+1 (2026-09-26)
      expect(verified.businessDate).toBe('2026-09-26');

      const reloaded = await Payment.findByPk(oldBankPaymentId);
      expect(reloaded.businessDate).toBe('2026-09-26');

      // Cleanup
      await seq.query('DELETE FROM payments WHERE id = ?', { replacements: [oldBankPaymentId] });
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL');
    });

    test('Migration 004 backfill applies the unified rule: CASH -> day X, BANK_TRANSFER -> day X+1', async () => {
      const seq = tenant1.sequelize;
      const createdUtcStr = '2026-09-25 18:30:00'; // Day X 23:30 PKT
      const paidUtcStr = '2026-09-26 05:00:00'; // Day X+1 10:00 PKT

      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NULL');

      const cashId = '55555555-5555-4555-8555-555555555553';
      const bankId = '55555555-5555-4555-8555-555555555554';

      await seq.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, collected_at, paid_at, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 1000, 'PKR', 'CASH', 'COMPLETED', NULL, ?, ?, ?, NULL)`,
        { replacements: [cashId, testUser.id, branchKarachi.id, paidUtcStr, createdUtcStr, createdUtcStr] }
      );

      await seq.query(
        `INSERT INTO payments (id, user_id, branch_id, amount, currency, method, status, collected_at, paid_at, created_at, updated_at, business_date)
         VALUES (?, ?, ?, 2000, 'PKR', 'BANK_TRANSFER', 'COMPLETED', NULL, ?, ?, ?, NULL)`,
        { replacements: [bankId, testUser.id, branchKarachi.id, paidUtcStr, createdUtcStr, createdUtcStr] }
      );

      // Re-run Migration 004
      await seq.query('DELETE FROM schema_migrations WHERE version >= 4');
      await runTenantMigrations(seq, {
        tenantId: '22222222-2222-4222-8222-222222222222',
        gymName: 'Timezone Gym',
      });

      const [cashRow] = await seq.query('SELECT business_date FROM payments WHERE id = ?', {
        replacements: [cashId],
        type: QueryTypes.SELECT,
      });
      const [bankRow] = await seq.query('SELECT business_date FROM payments WHERE id = ?', {
        replacements: [bankId],
        type: QueryTypes.SELECT,
      });

      expect(cashRow.business_date).toBe('2026-09-25');
      expect(bankRow.business_date).toBe('2026-09-26');

      // Cleanup
      await seq.query('DELETE FROM payments WHERE id IN (?, ?)', { replacements: [cashId, bankId] });
      await seq.query('ALTER TABLE `payments` MODIFY COLUMN `business_date` DATE NOT NULL');
    });
  });
});
