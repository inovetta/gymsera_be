const request = require('supertest');
const { Sequelize } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('NEW-31: /discovery/debug-activate-branches route is removed (resolves NEW-01)', () => {
  let dbHarness;
  let app;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    app = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('GET /api/v1/discovery/debug-activate-branches returns 404 and performs zero database writes', async () => {
    const writes = [];
    const originalQuery = Sequelize.prototype.query;
    const spy = jest.spyOn(Sequelize.prototype, 'query').mockImplementation(function (sql) {
      const sqlString = typeof sql === 'string' ? sql : sql?.query || '';
      if (/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP|REPLACE|TRUNCATE)\b/i.test(sqlString)) {
        writes.push(sqlString);
      }
      return originalQuery.apply(this, arguments);
    });

    try {
      const res = await request(app).get('/api/v1/discovery/debug-activate-branches');
      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('POST /api/v1/discovery/debug-activate-branches returns 404 and performs zero database writes', async () => {
    const writes = [];
    const originalQuery = Sequelize.prototype.query;
    const spy = jest.spyOn(Sequelize.prototype, 'query').mockImplementation(function (sql) {
      const sqlString = typeof sql === 'string' ? sql : sql?.query || '';
      if (/^\s*(UPDATE|INSERT|DELETE|ALTER|CREATE|DROP|REPLACE|TRUNCATE)\b/i.test(sqlString)) {
        writes.push(sqlString);
      }
      return originalQuery.apply(this, arguments);
    });

    try {
      const res = await request(app).post('/api/v1/discovery/debug-activate-branches');
      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
