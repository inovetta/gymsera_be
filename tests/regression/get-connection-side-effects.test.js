/**
 * Regression Test: §9.6 getConnection side effects
 * Spec §13 / Mobile Doc §9.6 / NEW-10
 *
 * Requirement:
 * `getConnection` on a cold cache performs zero UPDATEs (query spy).
 *
 * NOTE: As documented in AGENT_HANDOFF.md and Spec §12.13.11 (NEW-10), this test
 * is EXPECTED TO FAIL in Prompt 1 because TenantDbManager.getConnection still runs
 * backfills on every cache miss. Prompt 1 requires: "If one of them FAILS, do not
 * fix it here — record it in §13 as a regression and report it."
 */
const { Sequelize } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
} = require('../harness');
const TenantDbManager = require('../../src/database/TenantDbManager');

describe('Regression §9.6: getConnection side effects (NEW-10)', () => {
  let dbHarness;
  let tenant;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant = await factories.createTenant({ gymName: 'Connection Spy Gym' });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('getConnection on a cold cache performs zero UPDATEs', async () => {
    // Evict from connection cache to force cold cache path
    TenantDbManager.pool.clear();

    const executedUpdateQueries = [];
    const originalQuery = Sequelize.prototype.query;

    const querySpy = jest.spyOn(Sequelize.prototype, 'query').mockImplementation(function (sql, options) {
      const sqlString = typeof sql === 'string' ? sql : sql?.query || '';
      if (/^\s*UPDATE\b/i.test(sqlString)) {
        executedUpdateQueries.push(sqlString);
      }
      return originalQuery.apply(this, arguments);
    });

    try {
      await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);

      // §9.6 invariant: opening a DB connection to read from it must NEVER perform UPDATE side-effects
      expect(executedUpdateQueries).toHaveLength(0);
    } finally {
      querySpy.mockRestore();
    }
  });
});
