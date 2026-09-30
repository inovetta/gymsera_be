/**
 * BILL-06 — Android acknowledgement must happen server-side (spec §7.5.1, §12.1).
 *
 * Play auto-refunds a subscription that is not acknowledged within 3 days.
 * The server must acknowledge every valid purchase itself, inside the same
 * verified sync path the app's /sync and the RTDN processor share, and retry
 * until it succeeds. The app's completePurchase is only a backup.
 */
const request = require('supertest');
const { setupTestDatabases, teardownTestDatabases, resetTestDatabases, factories } = require('../harness');
const fakes = require('../harness/billing-fakes');
// supertest calls a server already listening on 127.0.0.1 (TEST-FLAKE-1B).
const { startTestServer } = require('../harness/test-server');

let app;
beforeAll(async () => {
  app = await startTestServer();
});
const { signToken } = require('../../src/utils/jwt.utils');
const { City, BillingEvent } = require('../../src/models/platform');
const billingEvents = require('../../src/services/billing-event.service');

describe('BILL-06: server-side Android acknowledgement', () => {
  let dbHarness;
  let tenant;
  let plan3;
  let token;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestDatabases();
    await City.findOrCreate({ where: { id: 1 }, defaults: { id: 1, name: 'Karachi', isActive: true } });
    tenant = await factories.createTenant({ connectionStringEncrypted: dbHarness.tenant1.encryptedConnStr });
    await factories.createGymListing(tenant.id);
    plan3 = await factories.createBillingPlan({ branchCount: 3, sortOrder: 3 });
    token = signToken({ sub: tenant.ownerUserId, id: tenant.ownerUserId, role: 'GYM_HOST', isVerified: true, tenantId: tenant.id });
  });

  const unacked = (overrides = {}) =>
    fakes.googlePurchase({ productId: plan3.androidProductId, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', ...overrides });

  const sync = (purchaseToken, productId) =>
    request(app).post('/api/v1/billing/android/sync').set('Authorization', `Bearer ${token}`).send({ purchaseToken, productId });

  test('/sync of an unacknowledged purchase: the server acknowledges it before answering, with the product id Google reported', async () => {
    const { ack, truth } = fakes.installGoogleFakes({ 'tok-a': unacked() });

    // The client sends a wrong product id; the server must use Google's.
    const res = await sync('tok-a', 'client-says-something-else');
    expect(res.status).toBe(200);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith('tok-a', plan3.androidProductId);

    // Google now reports it acknowledged: a second sync does not ack again and does not fail.
    truth['tok-a'] = { ...truth['tok-a'], acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
    const again = await sync('tok-a', plan3.androidProductId);
    expect(again.status).toBe(200);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('an RTDN for an unacknowledged purchase acknowledges it too (the app may never come back)', async () => {
    const { ack, truth } = fakes.installGoogleFakes({ 'tok-b': unacked() });
    // Row created by an earlier sync whose ack was done by the client, then a
    // re-subscribe issued a still-unacknowledged state for the same token.
    truth['tok-b'] = { ...unacked(), acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
    await sync('tok-b', plan3.androidProductId);
    expect(ack).not.toHaveBeenCalled();

    truth['tok-b'] = unacked({ latestOrderId: 'GPA.0000-0000-0000-00002' });
    await request(app).post('/api/v1/billing/webhooks/google').set('Authorization', fakes.rtdnAuthHeader()).send(fakes.rtdnBody({
      messageId: 'pubsub-purchased',
      notification: { subscriptionNotification: { notificationType: 4, purchaseToken: 'tok-b', subscriptionId: plan3.androidProductId } },
    }));
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('a failed acknowledge does not fail /sync, and is retried by the sweep until it succeeds', async () => {
    const { ack } = fakes.installGoogleFakes({ 'tok-c': unacked() });
    ack.mockRejectedValueOnce(new Error('Play Developer API 503'));

    const res = await sync('tok-c', plan3.androidProductId);
    expect(res.status).toBe(200);
    expect(ack).toHaveBeenCalledTimes(1);

    const retry = await BillingEvent.findOne({ where: { provider: 'GOOGLE', providerEventId: 'ack:tok-c' } });
    expect(retry).not.toBeNull();
    expect(retry.status).toBe('FAILED');
    expect(retry.lastError).toContain('503');

    await billingEvents.processPendingEvents();
    expect(ack).toHaveBeenCalledTimes(2);
    expect((await retry.reload()).status).toBe('PROCESSED');
  });

  test('a pending (unpaid) purchase is not acknowledged', async () => {
    const { ack } = fakes.installGoogleFakes({ 'tok-d': unacked({ state: 'SUBSCRIPTION_STATE_PENDING' }) });
    await sync('tok-d', plan3.androidProductId);
    expect(ack).not.toHaveBeenCalled();
  });
});
