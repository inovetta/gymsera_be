module.exports = {
  testEnvironment: 'node',
  // No test may reach any remote host — Apple, Google, Stripe, SMTP, anything (R-19).
  // A test server may not listen on a random port on every address (TEST-FLAKE-1B).
  // fake-now.js shifts the clock only when TEST_FAKE_NOW is set (NEW-207 date-bomb check).
  setupFiles: [
    '<rootDir>/tests/harness/no-network.js',
    '<rootDir>/tests/harness/loopback-listen.js',
    '<rootDir>/tests/harness/fake-now.js',
    // R-99: payouts on for the existing payout suites (off by default in production).
    '<rootDir>/tests/harness/payouts-enabled.js',
  ],
  // Releases what outlives a test file and keeps its module graph in memory (rate limiter timers, the
  // Redis client); see tests/regression/test-hygiene-rate-limit-stores.test.js.
  setupFilesAfterEnv: ['<rootDir>/tests/harness/release-process-resources.js'],
  testTimeout: 30000,
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.js',
    '<rootDir>/tests/regression/**/*.test.js',
  ],
  verbose: true,
  forceExit: true,
};
