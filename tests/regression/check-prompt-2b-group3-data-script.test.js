const { QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { checkHistoricalData } = require('../../src/scripts/check-prompt-2b-group3-data');

describe('Rule 8: Read-only check script against migrated schema asserts zero writes', () => {
  let dbHarness;
  let tenant1Seq;
  let platformSeq;
  let branchId;
  let listingId;
  let tenantId;
  let memberUserId;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    const personas = await setupPersonas(dbHarness);
    tenant1Seq = dbHarness.tenant1.sequelize;
    platformSeq = dbHarness.platform.sequelize;

    const { Branch, GymStaff, MemberSubscription, LedgerDay, MembershipPlan } = dbHarness.tenant1.models;
    const { Tenant, GymListing } = require('../../src/models/platform');

    const branch = await Branch.findOne();
    branchId = branch.id;
    const listing = await GymListing.findOne();
    listingId = listing.id;
    const tenant = await Tenant.findOne({ where: { status: 'ACTIVE' } });
    tenantId = tenant.id;
    memberUserId = personas.member.user.id;

    // 1. Seed legacy staff invite (FLOW-12): pending with null invite_token_hash / token_expires_at
    await GymStaff.create({
      id: uuidv4(),
      branchId,
      email: 'legacy-staff-invite@gymsera.test',
      designation: 'Assistant Trainer',
      employmentStatus: 'ACTIVE',
      status: 'pending',
      inviteTokenHash: null,
      tokenExpiresAt: null,
    });

    // 2. Seed review without valid subscription (FLOW-10): user with no subscription
    const nonMemberUserId = uuidv4();
    await platformSeq.query(
      `INSERT INTO users (id, full_name, email, role, created_at, updated_at)
       VALUES (?, 'Non Member User', 'nonmember@gymsera.test', 'MEMBER', NOW(), NOW())`,
      { replacements: [nonMemberUserId] }
    );
    await platformSeq.query(
      `INSERT INTO gym_reviews (id, gym_listing_id, branch_id, user_id, tenant_id, rating, title, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 5, 'Great Facility', 'Nice place!', 'PENDING', NOW(), NOW())`,
      { replacements: [uuidv4(), listingId, branchId, nonMemberUserId, tenantId] }
    );

    // 3. Seed active subscription on legacy static QR (FLOW-09): qr_code LIKE 'GE-%'
    const plan = await MembershipPlan.create({
      id: uuidv4(),
      gymId: branch.gymId,
      branchId,
      name: 'Standard Monthly',
      durationType: 'MONTHLY',
      durationValue: 1,
      price: '5000.00',
    });
    await MemberSubscription.create({
      id: uuidv4(),
      userId: memberUserId,
      branchId,
      membershipPlanId: plan.id,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'ACTIVE',
      qrCode: 'GE-STATIC-LEGACY-001',
    });

    // 4. Seed missed open ledger day (PAY-06): OPEN with business_date < CURRENT_DATE()
    await LedgerDay.create({
      id: uuidv4(),
      branchId,
      businessDate: '2026-01-01',
      status: 'OPEN',
    });

    // 5. Seed closed ledger day without collector snapshot (PAY-06): CLOSED with null closed_collectors_json
    await LedgerDay.create({
      id: uuidv4(),
      branchId,
      businessDate: '2026-01-02',
      status: 'CLOSED',
      closedExpectedTotal: '1500.00',
      closedVerifiedTotal: '1500.00',
      closedCollectorsJson: null,
    });

    // 6. Seed cash payment without shift (PAY-06): method = 'CASH' and shift is NULL
    await tenant1Seq.query(
      `INSERT INTO payments (id, user_id, branch_id, amount, method, status, shift, created_at, updated_at)
       VALUES (?, ?, ?, 500.00, 'CASH', 'COMPLETED', NULL, NOW(), NOW())`,
      { replacements: [uuidv4(), memberUserId, branchId] }
    );
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('checkHistoricalData executes cleanly, detects all seeded legacy rows, and produces zero database writes', async () => {
    // Snapshot table counts before running check script
    const getCounts = async () => {
      const [pUsers] = await platformSeq.query('SELECT COUNT(*) AS c FROM users', { type: QueryTypes.SELECT });
      const [pTenants] = await platformSeq.query('SELECT COUNT(*) AS c FROM tenants', { type: QueryTypes.SELECT });
      const [pReviews] = await platformSeq.query('SELECT COUNT(*) AS c FROM gym_reviews', { type: QueryTypes.SELECT });
      const [tStaff] = await tenant1Seq.query('SELECT COUNT(*) AS c FROM gym_staff', { type: QueryTypes.SELECT });
      const [tSubs] = await tenant1Seq.query('SELECT COUNT(*) AS c FROM member_subscriptions', { type: QueryTypes.SELECT });
      const [tLedger] = await tenant1Seq.query('SELECT COUNT(*) AS c FROM ledger_days', { type: QueryTypes.SELECT });
      const [tPayments] = await tenant1Seq.query('SELECT COUNT(*) AS c FROM payments', { type: QueryTypes.SELECT });
      const [tMigrations] = await tenant1Seq.query('SELECT COUNT(*) AS c FROM schema_migrations', { type: QueryTypes.SELECT });

      return {
        pUsers: pUsers.c,
        pTenants: pTenants.c,
        pReviews: pReviews.c,
        tStaff: tStaff.c,
        tSubs: tSubs.c,
        tLedger: tLedger.c,
        tPayments: tPayments.c,
        tMigrations: tMigrations.c,
      };
    };

    const countsBefore = await getCounts();

    const logs = [];
    const customLogger = (msg) => logs.push(msg);

    // Run the check script without options.tenantDbs so it performs real tenant discovery via platform DB
    const results = await checkHistoricalData({
      platformSeq,
      logger: customLogger,
    });

    expect(results).toBeDefined();

    // 1. FLOW-12: Legacy staff invites
    expect(results.staffInvites.legacyInvitesCount).toBe(1);

    // 2. FLOW-10: Reviews lacking valid subscription
    expect(results.reviews.invalidSubscriptionCount).toBe(1);

    // 3. FLOW-09: Active subscriptions on legacy static QR
    expect(results.attendanceQr.staticQrSubscriptionsCount).toBe(1);

    // 4. PAY-06: Missed open ledger days
    expect(results.ledger.missedOpenDaysCount).toBe(1);

    // 5. PAY-06: Closed days without collector snapshot
    expect(results.ledger.closedDaysWithoutSnapshotCount).toBe(1);

    // 6. PAY-06: Cash payments without shift
    expect(results.ledger.cashPaymentsWithoutShiftCount).toBe(1);

    const countsAfter = await getCounts();

    // Assert strictly zero writes across all inspected tables
    expect(countsAfter.pUsers).toBe(countsBefore.pUsers);
    expect(countsAfter.pTenants).toBe(countsBefore.pTenants);
    expect(countsAfter.pReviews).toBe(countsBefore.pReviews);
    expect(countsAfter.tStaff).toBe(countsBefore.tStaff);
    expect(countsAfter.tSubs).toBe(countsBefore.tSubs);
    expect(countsAfter.tLedger).toBe(countsBefore.tLedger);
    expect(countsAfter.tPayments).toBe(countsBefore.tPayments);
    expect(countsAfter.tMigrations).toBe(countsBefore.tMigrations);
  });
});

