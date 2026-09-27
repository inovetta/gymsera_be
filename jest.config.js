module.exports = {
  testEnvironment: 'node',
  // No test may reach any remote host — Apple, Google, Stripe, SMTP, anything (R-19).
  setupFiles: ['<rootDir>/tests/harness/no-network.js'],
  testTimeout: 30000,
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.js',
    '<rootDir>/tests/regression/**/*.test.js',
  ],
  verbose: true,
  forceExit: true,
};
