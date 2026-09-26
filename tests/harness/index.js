/**
 * GymsEra Backend Test Harness
 *
 * One-stop import for integration tests:
 *   const { setupTestDatabases, resetTestDatabases, teardownTestDatabases, factories, personas, asPersona } = require('../harness');
 */
const testDb = require('./test-db');
const factories = require('./factories');
const personas = require('./personas');

module.exports = {
  ...testDb,
  factories,
  personas,
  setupPersonas: personas.setupPersonas,
  asPersona: personas.asPersona,
};
