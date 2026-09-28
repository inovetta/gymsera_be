const request = require('supertest');
const { Sequelize } = require('sequelize');
const {
  setupTestDatabases,
  teardownTestDatabases,
} = require('../harness');
const app = require('../../app');

describe('NEW-04: /debug-sync-db route is removed', () => {
  let dbHarness;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('GET /api/v1/debug-sync-db returns 404 and performs zero database writes', async () => {
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
      const res = await request(app).get('/api/v1/debug-sync-db');
      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('POST /api/v1/debug-sync-db returns 404 and performs zero database writes', async () => {
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
      const res = await request(app).post('/api/v1/debug-sync-db');
      expect(res.status).toBe(404);
      expect(writes).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
