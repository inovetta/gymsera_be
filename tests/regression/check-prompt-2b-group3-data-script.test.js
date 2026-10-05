const { QueryTypes } = require('sequelize');
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

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
    tenant1Seq = dbHarness.tenant1.sequelize;
    platformSeq = dbHarness.platform.sequelize;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('checkHistoricalData executes cleanly and produces zero database writes', async () => {
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

    // Run the check script
    const results = await checkHistoricalData({
      platformSeq,
      tenantDbs: [dbHarness.tenant1],
      logger: customLogger,
    });

    expect(results).toBeDefined();
    expect(results.staffInvites).toBeDefined();
    expect(results.reviews).toBeDefined();
    expect(results.attendanceQr).toBeDefined();
    expect(results.ledger).toBeDefined();

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
