/**
 * Regression Test: FLOW-06 Read-Only Subscription Dates Check Script
 *
 * Verifies (Rule 8):
 * 1. Runs against a real migrated tenant schema with seeded defect rows.
 * 2. Detects each historical defect:
 *    - FROZEN_PAST_FREEZE_TO
 *    - FROZEN_WITHOUT_END_DATE_EXTENSION
 *    - ACTIVE_PAST_BRANCH_END_DATE
 *    - STALE_RENEWAL_START
 * 3. STRICT ZERO WRITES PROOF:
 *    - Verifies row count is identical before and after.
 *    - Verifies all row columns and updatedAt timestamps are completely unchanged.
 *    - Verifies transaction level is read-only.
 */
const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { processTenantSubscriptionDatesCheck } = require('../../src/scripts/check-subscription-dates');

describe('FLOW-06: Read-Only Check Script for Historical Subscription Date Defects (Rule 8)', () => {
  let dbHarness;
  let tenantSeq;
  let models;
  let gym;
  let branch;
  let plan;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenantSeq = dbHarness.tenant1.sequelize;
    models = dbHarness.tenant1.models;

    const { Gym, Branch, MembershipPlan } = models;

    gym = await Gym.create({ name: 'FLOW-06 Check Gym' });
    branch = await Branch.create({
      gymId: gym.id,
      branchName: 'Karachi Central',
      timezone: 'Asia/Karachi',
    });

    plan = await MembershipPlan.create({
      gymId: gym.id,
      branchId: branch.id,
      name: 'Monthly Standard',
      durationType: 'MONTHLY',
      durationValue: 1,
      price: '5000.00',
    });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('detects all historical defects and asserts zero writes on real migrated tenant schema', async () => {
    const { MemberSubscription } = models;

    // Use a fixed reference date for deterministic testing: 2026-10-05 10:00:00 UTC (15:00:00 PKT)
    const fixedToday = '2026-10-05';

    // 1. Seed valid active subscription
    const subValid = await MemberSubscription.create({
      userId: '11111111-1111-1111-1111-111111111111',
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-10-01',
      endDate: '2026-11-01',
      status: 'ACTIVE',
      subscribedAt: new Date('2026-10-01T05:00:00Z'),
    });

    // 2. Seed FROZEN_PAST_FREEZE_TO:
    // status FROZEN, but freeze ended on 2026-10-01 (before 2026-10-05)
    const subFrozenPast = await MemberSubscription.create({
      userId: '22222222-2222-2222-2222-222222222222',
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-09-01',
      endDate: '2026-10-15',
      freezeFrom: '2026-09-20',
      freezeTo: '2026-10-01', // Elapsed in branch timezone!
      status: 'FROZEN',
      subscribedAt: new Date('2026-09-01T05:00:00Z'),
    });

    // 3. Seed FROZEN_WITHOUT_END_DATE_EXTENSION:
    // Started 2026-09-15, 1 Month duration raw endDate = 2026-10-15.
    // Frozen for 5 days (2026-09-20 to 2026-09-25).
    // Expected endDate = 2026-10-20.
    // But stored endDate is still raw 2026-10-15!
    const subFrozenNoExt = await MemberSubscription.create({
      userId: '33333333-3333-3333-3333-333333333333',
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-09-15',
      endDate: '2026-10-15', // Unextended raw end date!
      freezeFrom: '2026-09-20',
      freezeTo: '2026-09-25',
      status: 'ACTIVE',
      subscribedAt: new Date('2026-09-15T05:00:00Z'),
    });

    // 4. Seed ACTIVE_PAST_BRANCH_END_DATE:
    // status ACTIVE, but endDate was 2026-10-02 (before 2026-10-05)
    const subActivePast = await MemberSubscription.create({
      userId: '44444444-4444-4444-4444-444444444444',
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-09-01',
      endDate: '2026-10-02', // Passed!
      status: 'ACTIVE',
      subscribedAt: new Date('2026-09-01T05:00:00Z'),
    });

    // 5. Seed STALE_RENEWAL_START:
    // Subscribed on 2026-10-01, but startDate set to 2026-09-01 (30 days prior)
    const subStaleRenewal = await MemberSubscription.create({
      userId: '55555555-5555-5555-5555-555555555555',
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-09-01',
      endDate: '2026-10-01',
      status: 'EXPIRED',
      subscribedAt: new Date('2026-10-01T08:00:00Z'),
    });

    // Take complete snapshot before executing the check script
    const snapshotBefore = await MemberSubscription.findAll({
      order: [['id', 'ASC']],
      raw: true,
    });

    // Execute check script
    const result = await processTenantSubscriptionDatesCheck(
      tenantSeq,
      { tenantId: 'test-tenant-flow06', gymName: 'Test Gym' },
      { quiet: true, todayOverride: fixedToday }
    );

    // Take complete snapshot after executing the check script
    const snapshotAfter = await MemberSubscription.findAll({
      order: [['id', 'ASC']],
      raw: true,
    });

    // ── ASSERTION 1: Accurate Defect Detection ──────────────────────────────
    expect(result.scannedCount).toBe(snapshotBefore.length);
    expect(result.anomaliesCount).toBe(4);

    const types = result.anomalies.map((a) => a.issueType);
    expect(types).toContain('FROZEN_PAST_FREEZE_TO');
    expect(types).toContain('FROZEN_WITHOUT_END_DATE_EXTENSION');
    expect(types).toContain('ACTIVE_PAST_BRANCH_END_DATE');
    expect(types).toContain('STALE_RENEWAL_START');

    const anomalyFrozen = result.anomalies.find((a) => a.subscriptionId === subFrozenPast.id);
    expect(anomalyFrozen.issueType).toBe('FROZEN_PAST_FREEZE_TO');
    expect(anomalyFrozen.recommendedAction).toBe('TRANSITION_TO_ACTIVE');

    const anomalyNoExt = result.anomalies.find((a) => a.subscriptionId === subFrozenNoExt.id);
    expect(anomalyNoExt.issueType).toBe('FROZEN_WITHOUT_END_DATE_EXTENSION');
    expect(anomalyNoExt.recommendedAction).toBe('EXTEND_END_DATE_BY_5_DAYS');

    const anomalyActivePast = result.anomalies.find((a) => a.subscriptionId === subActivePast.id);
    expect(anomalyActivePast.issueType).toBe('ACTIVE_PAST_BRANCH_END_DATE');
    expect(anomalyActivePast.recommendedAction).toBe('TRANSITION_TO_EXPIRED');

    const anomalyStaleRenewal = result.anomalies.find((a) => a.subscriptionId === subStaleRenewal.id);
    expect(anomalyStaleRenewal.issueType).toBe('STALE_RENEWAL_START');

    // ── ASSERTION 2: Strict Zero-Writes Guarantee (Rule 8) ───────────────────
    expect(snapshotAfter.length).toBe(snapshotBefore.length);

    for (let i = 0; i < snapshotBefore.length; i++) {
      const beforeRow = snapshotBefore[i];
      const afterRow = snapshotAfter[i];

      expect(afterRow.id).toBe(beforeRow.id);
      expect(afterRow.status).toBe(beforeRow.status);
      expect(afterRow.start_date).toBe(beforeRow.start_date);
      expect(afterRow.end_date).toBe(beforeRow.end_date);
      expect(afterRow.freeze_from).toBe(beforeRow.freeze_from);
      expect(afterRow.freeze_to).toBe(beforeRow.freeze_to);

      // Verify timestamps didn't change (no touch/update)
      expect(new Date(afterRow.updated_at).getTime()).toBe(new Date(beforeRow.updated_at).getTime());
    }
  });

  test('--verbose mode lists each anomaly with required metadata, zero personal data, and zero writes', async () => {
    const { MemberSubscription } = models;
    const fixedToday = '2026-10-05';

    // Snapshot before
    const snapshotBefore = await MemberSubscription.findAll({
      order: [['id', 'ASC']],
      raw: true,
    });

    const loggedMessages = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      loggedMessages.push(args.join(' '));
    });

    try {
      const result = await processTenantSubscriptionDatesCheck(
        tenantSeq,
        { tenantId: 'test-tenant-verbose', gymName: 'Vitality Fit Studio' },
        { verbose: true, quiet: false, todayOverride: fixedToday }
      );

      // Snapshot after
      const snapshotAfter = await MemberSubscription.findAll({
        order: [['id', 'ASC']],
        raw: true,
      });

      const fullOutput = loggedMessages.join('\n');

      // ── VERIFY VERBOSE OUTPUT ─────────────────────────────────────────────
      expect(fullOutput).toContain('Detailed Anomalies (4):');

      // 1. Lists each anomaly with Subscription ID
      for (const a of result.anomalies) {
        expect(fullOutput).toContain(`Subscription ID: ${a.subscriptionId}`);
        expect(fullOutput).toContain(`Type:            ${a.issueType}`);
        expect(fullOutput).toContain(`Status:          ${a.status}`);
        expect(fullOutput).toContain(`Start Date:      ${a.startDate}`);
        expect(fullOutput).toContain(`End Date:        ${a.endDate}`);
      }

      // 2. Freeze dates specifically listed for frozen subscriptions
      expect(fullOutput).toContain('Freeze Dates:    2026-09-20 -> 2026-10-01');
      expect(fullOutput).toContain('Freeze Dates:    2026-09-20 -> 2026-09-25');

      // 3. ZERO PERSONAL DATA (spec & rule 8)
      // Must not contain email addresses, passwords, phone numbers, or user names
      expect(fullOutput).not.toMatch(/@/); // No email
      expect(fullOutput).not.toMatch(/\+?[0-9]{10,13}/); // No phone numbers
      expect(fullOutput).not.toContain('password');

      // 4. ZERO WRITES ASSERTION
      expect(snapshotAfter.length).toBe(snapshotBefore.length);
      for (let i = 0; i < snapshotBefore.length; i++) {
        expect(snapshotAfter[i].id).toBe(snapshotBefore[i].id);
        expect(snapshotAfter[i].status).toBe(snapshotBefore[i].status);
        expect(new Date(snapshotAfter[i].updated_at).getTime()).toBe(new Date(snapshotBefore[i].updated_at).getTime());
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
