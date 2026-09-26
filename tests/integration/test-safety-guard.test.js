/**
 * Test Safety Guard Unit / Integration Tests (spec §14 Rule R-19)
 *
 * Verifies that the test harness refuses to start unless:
 * 1. NODE_ENV === 'test'
 * 2. Host is localhost / 127.0.0.1 / ::1 or CI service container ('mysql')
 * 3. Every database name starts with 'gymsera_test_'
 */
const { assertTestEnvironmentSafety } = require('../harness');

describe('Backend Test Safety Guard (spec §14 Rule R-19)', () => {
  const validConfig = {
    nodeEnv: 'test',
    hosts: ['localhost', '127.0.0.1'],
    databases: ['gymsera_test_platform', 'gymsera_test_tenant_1', 'gymsera_test_tenant_2'],
  };

  test('passes with valid test environment settings', () => {
    expect(() => assertTestEnvironmentSafety(validConfig)).not.toThrow();
  });

  test('passes with CI service container host "mysql"', () => {
    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        hosts: ['mysql'],
      })
    ).not.toThrow();
  });

  test('refuses to start when NODE_ENV is production', () => {
    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        nodeEnv: 'production',
      })
    ).toThrow(/NODE_ENV must be 'test'/);
  });

  test('refuses to start when NODE_ENV is development', () => {
    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        nodeEnv: 'development',
      })
    ).toThrow(/NODE_ENV must be 'test'/);
  });

  test('refuses to start when host is a remote / non-local host', () => {
    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        hosts: ['production-rds.amazonaws.com'],
      })
    ).toThrow(/is not localhost or CI container/);

    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        hosts: ['apistaging.gymsera.com'],
      })
    ).toThrow(/is not localhost or CI container/);

    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        hosts: ['192.168.1.100'],
      })
    ).toThrow(/is not localhost or CI container/);
  });

  test('refuses to start when database name does not start with gymsera_test_', () => {
    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        databases: ['gymsera_production'],
      })
    ).toThrow(/does not start with 'gymsera_test_'/);

    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        databases: ['gymsera_platform'],
      })
    ).toThrow(/does not start with 'gymsera_test_'/);

    expect(() =>
      assertTestEnvironmentSafety({
        ...validConfig,
        databases: ['test_platform'],
      })
    ).toThrow(/does not start with 'gymsera_test_'/);
  });
});
