/**
 * NEW-195 (found in P9b): GET /tenants/me and the other host tenant answers sent the owner the
 * tenant's encrypted database connection string (`connectionStringEncrypted`) and its database name
 * (`dbName`). No client reads them; the connection string is only safe while its key is, and the
 * database name is what R-79 says nobody should copy from anywhere but the tenants table.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');

beforeAll(async () => {
  const h = await setupTestDatabases();
  await setupPersonas(h);
});

afterAll(async () => {
  await stopTestServer();
  await teardownTestDatabases();
});

describe('NEW-195: a host tenant answer has no database internals', () => {
  test('GET /tenants/me sends no connection string and no database name', async () => {
    const res = await asPersona('owner').get('/tenants/me');
    expect(res.status).toBe(200);
    expect(res.body.data.tenant.id).toBeDefined();
    expect(res.body.data.tenant).not.toHaveProperty('connectionStringEncrypted');
    expect(res.body.data.tenant).not.toHaveProperty('dbName');
  });
});
