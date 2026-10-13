/**
 * NEW-79: gym-wide ledger reads (no ?branchId) selected Branch.name, a column
 * that does not exist (the column is branch_name), so GET /ledger/today,
 * /ledger/open-days, /ledger/weekly and /ledger/monthly answered 500 for the
 * owner across all branches.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('NEW-79: gym-wide ledger reads', () => {
  let tenantDb;
  beforeAll(async () => {
    const h = await setupTestDatabases();
    await setupPersonas(h);
    tenantDb = h.tenant1;
    await startTestServer();
  });
  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test.each(['/ledger/today', '/ledger/open-days', '/ledger/weekly', '/ledger/monthly'])(
    'owner GET %s without branchId answers 200',
    async (path) => {
      const res = await asPersona('owner').get(path);
      expect(res.status).toBe(200);
    }
  );

  test('weekly gym-wide ledger merges perDay across branches', async () => {
    const res = await asPersona('owner').get('/ledger/weekly');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('totals');
    expect(res.body.data.branches.length).toBeGreaterThan(0);
  });

  test('every branch in the merged ledger carries its branch name', async () => {
    const branch = await tenantDb.models.Branch.findOne({ where: { status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
    const res = await asPersona('owner').get('/ledger/today');
    expect(res.status).toBe(200);
    const rows = res.body.data.branches || [];
    const row = rows.find((r) => r.branchId === branch.id);
    expect(row).toBeDefined();
    expect(row.branchName).toBe(branch.branchName);
  });
});
