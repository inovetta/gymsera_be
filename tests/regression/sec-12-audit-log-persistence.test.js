'use strict';

/**
 * Regression test for SEC-12: Audit log persistence on Platform DB.
 *
 * Requirements:
 * - Runs with Redis DISABLED (DISABLE_REDIS=true).
 * - Must persist audit log to MySQL platform database.
 * - Proves that on current code, AuditLog model is undefined and fails with:
 *   "Cannot read properties of undefined (reading 'create')".
 */

process.env.DISABLE_REDIS = 'true';
process.env.AUDIT_LOG_PERSIST = 'true';

const { setupTestDatabases, teardownTestDatabases } = require('../harness');
const { sequelize } = require('../../src/database/platform');
const auditLog = require('../../src/middleware/auditLog');

describe('SEC-12: Platform DB Audit Log Persistence', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });

  afterAll(async () => {
    delete process.env.AUDIT_LOG_PERSIST;
    await teardownTestDatabases();
  });

  test('audit log entry persists to Platform DB audit_logs table on mutating requests', async () => {
    // 1. AuditLog model must exist and be defined on platform models
    const platformModels = require('../../src/models/platform');
    expect(platformModels.AuditLog).toBeDefined();

    // 2. Invoking auditLog middleware on a mutating request must persist to DB
    const req = {
      method: 'POST',
      originalUrl: '/api/v1/test-mutation',
      user: { id: '00000000-0000-0000-0000-000000000001', tenantId: null },
      ip: '127.0.0.1',
      get: (header) => (header === 'user-agent' ? 'Jest-Test-Agent' : null),
    };

    let writtenJson = null;
    let auditPromise = null;
    const res = {
      statusCode: 201,
      json: function (body) {
        writtenJson = body;
        return body;
      },
    };

    const next = jest.fn();

    // Run middleware
    auditLog(req, res, next);
    expect(next).toHaveBeenCalled();

    // Trigger json response
    res.json({ success: true, message: 'created' });

    // Wait for async persistence to complete
    await new Promise((r) => setTimeout(r, 200));

    // 3. Query audit_logs table to verify record persisted
    const [rows] = await sequelize.query(
      "SELECT * FROM audit_logs WHERE path = '/api/v1/test-mutation' ORDER BY created_at DESC LIMIT 1"
    );

    expect(rows.length).toBe(1);
    expect(rows[0].method).toBe('POST');
    expect(rows[0].status_code).toBe(201);
    expect(rows[0].ip_address).toBe('127.0.0.1');
    expect(rows[0].user_agent).toBe('Jest-Test-Agent');
  });
});
