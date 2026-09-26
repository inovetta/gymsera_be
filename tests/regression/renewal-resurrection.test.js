/**
 * Regression Test: §9.4 renewal resurrection
 * Spec §13 / Mobile Doc §9.4
 *
 * Requirement:
 * Renewal of a superseded row -> stays superseded when another ACTIVE row already exists.
 */
const {
  setupTestDatabases,
  teardownTestDatabases,
  factories,
} = require('../harness');
const { reconcileRenewalStatus } = require('../../src/services/subscription-migration.service');
const { TenantSubscription } = require('../../src/models/platform');
const { sequelize } = require('../../src/database/platform');

describe('Regression §9.4: renewal resurrection', () => {
  let dbHarness;
  let tenant;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    tenant = await factories.createTenant({ gymName: 'Renewal Test Gym' });
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('Renewal of a superseded row stays superseded when another ACTIVE subscription exists', async () => {
    // 1. Authoritative active subscription
    const currentActive = await factories.createTenantSubscription(tenant.id, {
      status: 'ACTIVE',
      platform: 'IOS',
      branchCount: 5,
    });

    // 2. Old superseded subscription (e.g. cancelled/expired previous subscription)
    const oldSuperseded = await factories.createTenantSubscription(tenant.id, {
      status: 'CANCELLED',
      platform: 'ANDROID',
      branchCount: 3,
    });

    // 3. Store notification arrives trying to renew the old superseded row to ACTIVE
    const incomingValues = {
      status: 'ACTIVE',
      lastVerifiedAt: new Date(),
    };

    let result;
    await sequelize.transaction(async (t) => {
      // Lock the row as caller does
      const row = await TenantSubscription.findByPk(oldSuperseded.id, {
        transaction: t,
        lock: true,
      });

      result = await reconcileRenewalStatus(tenant.id, row, incomingValues, {
        transaction: t,
      });
    });

    // The reconciled status must refuse resurrection and preserve CANCELLED
    expect(result.status).toBe('CANCELLED');
    expect(result.statusNote).toContain('superseded by another active GymsEra subscription');
  });

  test('Renewal succeeds if no other ACTIVE subscription exists', async () => {
    // Create a new tenant with only one expired row
    const singleTenant = await factories.createTenant({ gymName: 'Single Sub Gym' });
    const expiredSub = await factories.createTenantSubscription(singleTenant.id, {
      status: 'EXPIRED',
      platform: 'IOS',
    });

    const incomingValues = {
      status: 'ACTIVE',
      lastVerifiedAt: new Date(),
    };

    let result;
    await sequelize.transaction(async (t) => {
      const row = await TenantSubscription.findByPk(expiredSub.id, {
        transaction: t,
        lock: true,
      });

      result = await reconcileRenewalStatus(singleTenant.id, row, incomingValues, {
        transaction: t,
      });
    });

    // With no competing ACTIVE row, renewal legitimately proceeds
    expect(result.status).toBe('ACTIVE');
  });
});
