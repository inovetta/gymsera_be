/**
 * OBS-05 — billing alerts through the alert helper (spec §12.12): events unprocessed for more
 * than 10 minutes, events that keep failing, and a superseded subscription still billing.
 * IDs and counts only; one alert per code per hour; each code has a runbook entry.
 */
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const { BillingEvent, Notification, City } = require('../../src/models/platform');
const billingEvents = require('../../src/services/billing-event.service');
const alertService = require('../../src/services/alert.service');

const MIN = 60 * 1000;

describe('OBS-05: billing alert sweep', () => {
  let admin;
  let tenantA;
  let tenantB;

  const mk = (over) =>
    BillingEvent.create({
      provider: 'APPLE',
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      rawPayload: '{}',
      status: 'RECEIVED',
      receivedAt: new Date(),
      ...over,
    });
  const alerts = async (code) =>
    (await Notification.findAll({ where: { type: 'PLATFORM_ALERT', userId: admin.id } })).filter(
      (n) => (n.metadataJson || n.metadata || {}).alertCode === code
    );
  const meta = (n) => n.metadataJson || n.metadata;

  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });
  beforeEach(async () => {
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    alertService._resetForTests();
    admin = await factories.createUser({ role: 'PLATFORM_ADMIN' });
    tenantA = await factories.createTenant({ gymName: 'Alpha Fitness' });
    tenantB = await factories.createTenant({ gymName: 'Beta Fitness' });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('BILLING_EVENT_UNPROCESSED', () => {
    test('RECEIVED for more than 10 minutes alerts, with counts, the oldest age and tenant ids', async () => {
      await mk({ tenantId: tenantA.id, receivedAt: new Date(Date.now() - 25 * MIN) });
      await mk({ tenantId: tenantB.id, provider: 'GOOGLE', receivedAt: new Date(Date.now() - 12 * MIN) });
      await mk({ tenantId: null, provider: 'STRIPE', receivedAt: new Date(Date.now() - 11 * MIN) });
      const res = await billingEvents.sweepBillingAlerts();
      expect(res.raised).toContain('BILLING_EVENT_UNPROCESSED');
      const [row] = await alerts('BILLING_EVENT_UNPROCESSED');
      expect(meta(row)).toMatchObject({
        eventCount: 3, tenantCount: 2, unattributedEventCount: 1, appleCount: 1, googleCount: 1, stripeCount: 1,
      });
      expect(meta(row).oldestAgeMinutesCount).toBeGreaterThanOrEqual(25);
      expect([...meta(row).tenantIds].sort()).toEqual([tenantA.id, tenantB.id].sort());
    });

    test('under 10 minutes, or already PROCESSED / IGNORED, does not alert', async () => {
      await mk({ receivedAt: new Date(Date.now() - 9 * MIN) });
      await mk({ status: 'PROCESSED', receivedAt: new Date(Date.now() - 60 * MIN) });
      await mk({ status: 'IGNORED', receivedAt: new Date(Date.now() - 60 * MIN) });
      const res = await billingEvents.sweepBillingAlerts();
      expect(res.raised).toEqual([]);
    });
  });

  describe('BILLING_EVENT_FAILED', () => {
    test('FAILED after the retry threshold alerts; a first or second transient failure does not', async () => {
      await mk({ status: 'FAILED', attempts: 1, tenantId: tenantA.id });
      await mk({ status: 'FAILED', attempts: billingEvents.ALERT_AFTER_ATTEMPTS - 1, tenantId: tenantA.id });
      expect((await billingEvents.sweepBillingAlerts()).raised).toEqual([]);

      await mk({ status: 'FAILED', attempts: billingEvents.ALERT_AFTER_ATTEMPTS, tenantId: tenantA.id, lastError: 'Ali Khan <ali@example.test> bad receipt' });
      await mk({ status: 'FAILED', attempts: 20, tenantId: null, provider: 'STRIPE' });
      const res = await billingEvents.sweepBillingAlerts();
      expect(res.raised).toContain('BILLING_EVENT_FAILED');
      const [row] = await alerts('BILLING_EVENT_FAILED');
      expect(meta(row)).toMatchObject({ eventCount: 2, tenantCount: 1, tenantIds: [tenantA.id], unattributedEventCount: 1, maxAttemptsCount: 20 });
      // the error text of a failed event can hold provider or personal text: never in an alert
      expect(JSON.stringify(row.toJSON())).not.toMatch(/ali@example|Ali Khan|bad receipt/);
    });
  });

  describe('BILLING_DUPLICATE_BILLING', () => {
    test('a tenant with a superseded subscription still billing alerts, once per tenant list', async () => {
      await factories.createTenantSubscription(tenantA.id, { status: 'REVOKED', duplicateBilling: true, platform: 'IOS', externalOriginalTransactionId: 'x1' });
      await factories.createTenantSubscription(tenantB.id, { status: 'ACTIVE', duplicateBilling: false });
      const res = await billingEvents.sweepBillingAlerts();
      expect(res.raised).toContain('BILLING_DUPLICATE_BILLING');
      const [row] = await alerts('BILLING_DUPLICATE_BILLING');
      expect(meta(row)).toMatchObject({ tenantCount: 1, tenantIds: [tenantA.id] });
    });

    test('nothing flagged, nothing raised', async () => {
      await factories.createTenantSubscription(tenantA.id, { status: 'ACTIVE', duplicateBilling: false });
      expect((await billingEvents.sweepBillingAlerts()).raised).toEqual([]);
    });
  });

  test('one aggregated alert per code per hour: sweeping every minute does not repeat it', async () => {
    await mk({ receivedAt: new Date(Date.now() - 30 * MIN) });
    await billingEvents.sweepBillingAlerts();
    await billingEvents.sweepBillingAlerts();
    await billingEvents.sweepBillingAlerts();
    expect(await alerts('BILLING_EVENT_UNPROCESSED')).toHaveLength(1);
  });

  test('a sweep that cannot read the database never throws into the cron', async () => {
    jest.spyOn(BillingEvent, 'findAll').mockRejectedValue(new Error('db gone'));
    await expect(billingEvents.sweepBillingAlerts()).resolves.toMatchObject({ raised: [] });
  });

  test('the codes are registered with a runbook in docs/runbooks/billing-events.md', () => {
    for (const code of ['BILLING_EVENT_UNPROCESSED', 'BILLING_EVENT_FAILED', 'BILLING_DUPLICATE_BILLING']) {
      expect(alertService.ALERTS[code].runbook).toBe(`docs/runbooks/billing-events.md#${code.toLowerCase()}`);
    }
  });

  test('the minute job and the daily cron both run the sweep', () => {
    const fs = require('fs');
    expect(fs.readFileSync(require.resolve('../../server.js'), 'utf8')).toMatch(/sweepBillingAlerts/);
    expect(fs.readFileSync(require.resolve('../../src/jobs/subscription-expiry.cron.js'), 'utf8')).toMatch(/sweepBillingAlerts/);
  });
});
