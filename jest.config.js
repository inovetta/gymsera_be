module.exports = {
  testEnvironment: 'node',
  testTimeout: 30000,
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.js',
    '<rootDir>/tests/regression/**/*.test.js',
  ],
  verbose: true,
  forceExit: true,
};
