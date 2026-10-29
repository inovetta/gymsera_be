/**
 * Phase 7 P7a: booking and payment (BUG-31, BUG-34, BUG-35, NEW-150, NEW-159).
 *
 * BUG-34 / NEW-150 (R-74): the app added a 5% platform fee and took 10% off for the
 * hardcoded code GYMSERA10; the server never charged either. The server price is plan +
 * joining (waived after an earlier membership at the branch) + security, and the app now
 * shows the server's quote (GET /subscriptions/quote) instead of its own sum.
 * BUG-31: the dates were set when the request was sent and kept at approval, so a request
 * approved five days later lost five days. A traveller's request now starts on the day the
 * host approves it.
 * BUG-35: payment details sent whatever JSON the tenant held; a gym with no usable bank or
 * wallet detail now answers null, so the app can say so instead of "Loading" forever.
 * NEW-159: a gym that is not live under R-77 (no entitled subscription, branch hidden)
 * still opened by id and could be booked from a saved link.
 */
const { setupTestDatabases, teardownTestDatabases, setupPersonas, asPersona } = require('../harness');
const { stopTestServer } = require('../harness/test-server');
const { makeBranchLive } = require('../harness/factories');
const cache = require('../../src/services/discovery-cache.service');
const { Tenant, TenantSubscription, UserGymMembership, GymListing } = require('../../src/models/platform');
const subscriptionService = require('../../src/services/subscription.service');
const paymentService = require('../../src/services/payment.service');
const { computeBusinessDate } = require('../../src/services/ledger.service');
const { addPlanDuration, addDays } = require('../../src/utils/business-date.utils');

describe('Phase 7 P7a: booking and payment', () => {
  let personas; let ctx; let plan;

  const book = (persona, body) => asPersona(persona).post('/subscriptions', body);
  const quote = (persona, q) => asPersona(persona).get(
    `/subscriptions/quote?planId=${q.planId}&gymListingId=${q.gymListingId}&branchId=${q.branchId}`
  );

  beforeAll(async () => {
    const h = await setupTestDatabases();
    personas = await setupPersonas(h);
    ctx = require('../harness/personas').personaManager.context;
    await makeBranchLive(ctx.tenant1Db, ctx.branch1.id);
    plan = await ctx.tenant1Db.models.MembershipPlan.create({
      gymId: ctx.branch1.gymId, branchId: ctx.branch1.id, name: 'P7a Monthly',
      price: '5000.00', joiningFee: '700.00', securityFee: '300.00',
      durationType: 'MONTHLY', durationValue: 1, status: 'ACTIVE', isPublic: true,
    });
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => cache._resetForTests());

  const body = () => ({ planId: plan.id, gymListingId: ctx.listing1.id, branchId: ctx.branch1.id });

  describe('BUG-34 / NEW-150: the total is the server price, no fee, no promo', () => {
    test('quote = plan + joining + security, in the branch currency; booking charges exactly that', async () => {
      const q = await quote('member', body());
      expect(q.status).toBe(200);
      expect(q.body.data).toMatchObject({
        price: 5000, joiningFee: 700, securityFee: 300, totalPrice: 6000, currency: 'PKR',
      });
      expect(Object.keys(q.body.data)).not.toEqual(expect.arrayContaining(['platformFee']));
      expect(Object.keys(q.body.data)).not.toEqual(expect.arrayContaining(['discount']));

      const res = await book('member', body());
      expect(res.status).toBe(201);
      expect(Number(res.body.data.payment.amount)).toBe(6000);
      expect(Number(res.body.data.invoice.totalAmount)).toBe(6000);
      expect(Number(res.body.data.invoice.discountAmount)).toBe(0);
      expect(Number(res.body.data.invoice.taxAmount)).toBe(0);

      // The amount a client sends with the payment request is never stored (5% fee, promo).
      const subId = res.body.data.subscription.id;
      const pr = await asPersona('member').post('/me/payment-request', { subscriptionId: subId, method: 'BANK_TRANSFER', amount: 5985 });
      expect(pr.status).toBeLessThan(300);
      const payment = await ctx.tenant1Db.models.Payment.findByPk(res.body.data.payment.id);
      expect(Number(payment.amount)).toBe(6000);

      // After an earlier membership at this branch the joining fee is waived, in the quote too.
      await ctx.tenant1Db.models.MemberSubscription.update({ status: 'EXPIRED' }, { where: { id: subId } });
      const again = await quote('member', body());
      expect(again.body.data).toMatchObject({ joiningFee: 0, totalPrice: 5300 });
      const second = await book('member', body());
      expect(Number(second.body.data.payment.amount)).toBe(again.body.data.totalPrice);
    });

    test('personas: any signed-in traveller gets the same quote; no sign-in is 401', async () => {
      for (const p of ['owner', 'manager', 'frontDesk', 'otherTenantOwner']) {
        const res = await quote(p, body());
        expect(res.status).toBe(200);
        expect(res.body.data.price).toBe(5000);
      }
      const anon = await require('supertest')(require('../harness/personas').personaManager.server)
        .get(`/api/v1/subscriptions/quote?planId=${plan.id}&gymListingId=${ctx.listing1.id}&branchId=${ctx.branch1.id}`);
      expect(anon.status).toBe(401);
    });

    test('a quote for an unknown plan is 404, a bad id 422', async () => {
      const unknown = await quote('member', { ...body(), planId: '00000000-0000-4000-8000-000000000000' });
      expect(unknown.status).toBe(404);
      const bad = await quote('member', { ...body(), planId: 'nope' });
      expect(bad.status).toBe(422);
    });
  });

  describe('BUG-31: a request starts on the day the host approves it', () => {
    const backdate = async (subscriptionId, days) => {
      const { MemberSubscription } = ctx.tenant1Db.models;
      const start = addDays(computeBusinessDate(new Date(), ctx.branch1.timezone), -days);
      const end = addPlanDuration(start, 'MONTHLY', 1);
      await MemberSubscription.update({ startDate: start, endDate: end }, { where: { id: subscriptionId } });
      await UserGymMembership.update({ startDate: start, endDate: end }, { where: { subscriptionId } });
    };
    const today = () => computeBusinessDate(new Date(), ctx.branch1.timezone);

    test('verified payment: start = approval day, end = start + plan; the index matches', async () => {
      const { createUser } = require('../harness/factories');
      const traveller = await createUser({ role: 'MEMBER', email: 'p7a.t1@gymsera.test', fullName: 'P7a One' });
      const { subscription, payment } = await subscriptionService.subscribe(traveller.id, body());
      await backdate(subscription.id, 5);

      await paymentService.verifyPayment(ctx.tenant1Db, payment.id, personas.owner.user.id, null);

      const sub = await ctx.tenant1Db.models.MemberSubscription.findByPk(subscription.id);
      expect(sub.status).toBe('ACTIVE');
      expect(sub.startDate).toBe(today());
      expect(sub.endDate).toBe(addPlanDuration(today(), 'MONTHLY', 1));
      const index = await UserGymMembership.findOne({ where: { subscriptionId: subscription.id } });
      expect(index.status).toBe('ACTIVE');
      expect(index.startDate).toBe(today());
      expect(index.endDate).toBe(sub.endDate);
    });

    test('staff "activate without payment": same rule', async () => {
      const { createUser } = require('../harness/factories');
      const traveller = await createUser({ role: 'MEMBER', email: 'p7a.t2@gymsera.test', fullName: 'P7a Two' });
      const { subscription } = await subscriptionService.subscribe(traveller.id, body());
      await backdate(subscription.id, 3);

      const sub = await subscriptionService.activateSubscription(ctx.tenant1Db, subscription.id);
      expect(sub.startDate).toBe(today());
      expect(sub.endDate).toBe(addPlanDuration(today(), 'MONTHLY', 1));
      const index = await UserGymMembership.findOne({ where: { subscriptionId: subscription.id } });
      expect(index.startDate).toBe(today());
    });

    test('a membership staff entered with a chosen start date keeps it', async () => {
      const { createUser } = require('../harness/factories');
      const walkIn = await createUser({ role: 'MEMBER', email: 'p7a.t3@gymsera.test', fullName: 'P7a Three' });
      const chosen = addDays(today(), 10);
      const staffSub = await ctx.tenant1Db.models.MemberSubscription.create({
        userId: walkIn.id, branchId: ctx.branch1.id, membershipPlanId: plan.id,
        startDate: chosen, endDate: addPlanDuration(chosen, 'MONTHLY', 1), status: 'PENDING',
        subscribedAt: new Date(), sourceChannel: 'WALK_IN', createdBy: personas.frontDesk.user.id, createdByRole: 'STAFF',
      });
      const sub = await subscriptionService.activateSubscription(ctx.tenant1Db, staffSub.id);
      expect(sub.startDate).toBe(chosen);
    });
  });

  describe('BUG-35: bank details are real or null', () => {
    const details = async () => {
      const res = await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}/payment-details`);
      expect(res.status).toBe(200);
      return res.body.data.paymentDetails;
    };
    const store = (json) => Tenant.update({ paymentDetailsJson: json }, { where: { id: ctx.tenant1.id } });

    test('nothing usable (null, empty object, blank values, unknown keys only) is null', async () => {
      for (const json of [null, {}, { bankName: '  ', accountNumber: '' }, { note: 'x' }]) {
        await store(json);
        expect(await details()).toBeNull();
      }
    });

    test('only the traveller fields, trimmed; blanks dropped', async () => {
      await store({ bankName: ' Test Bank ', accountTitle: 'Alpha Fitness', accountNumber: '0001234567', iban: '', jazzCashNumber: '03001234567', internalNote: 'do not show' });
      expect(await details()).toEqual({
        bankName: 'Test Bank', accountTitle: 'Alpha Fitness', accountNumber: '0001234567', jazzCashNumber: '03001234567',
      });
    });
  });

  describe('NEW-159: a gym that is not live cannot be opened or booked', () => {
    afterEach(async () => {
      await TenantSubscription.update({ status: 'ACTIVE' }, { where: { tenantId: ctx.tenant1.id } });
      await ctx.tenant1Db.models.Branch.update({ travelerVisibilityStatus: 'active' }, { where: { id: ctx.branch1.id } });
    });

    const detail = (id) => asPersona('member').get(`/discovery/gyms/${id}`);

    test('live: detail opens by branch id and by listing id', async () => {
      expect((await detail(ctx.branch1.id)).status).toBe(200);
      expect((await detail(ctx.listing1.id)).status).toBe(200);
    });

    test('no entitled subscription: detail 404, payment details 404, quote and booking 409 gym_not_bookable', async () => {
      await TenantSubscription.update({ status: 'EXPIRED' }, { where: { tenantId: ctx.tenant1.id } });
      const gone = await detail(ctx.branch1.id);
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('gym_not_available');
      expect((await detail(ctx.listing1.id)).status).toBe(404);
      expect((await asPersona('member').get(`/discovery/gyms/${ctx.branch1.id}/payment-details`)).status).toBe(404);

      const q = await quote('member', body());
      expect(q.status).toBe(409);
      expect(q.body.code || q.body.error?.code).toBe('gym_not_bookable');
      const { createUser } = require('../harness/factories');
      const t = await createUser({ role: 'MEMBER', email: 'p7a.t4@gymsera.test', fullName: 'P7a Four' });
      await expect(subscriptionService.subscribe(t.id, body())).rejects.toMatchObject({ statusCode: 409, code: 'gym_not_bookable' });
    });

    test('branch hidden from travellers: detail 404, booking 409', async () => {
      await ctx.tenant1Db.models.Branch.update({ travelerVisibilityStatus: 'deactivated' }, { where: { id: ctx.branch1.id } });
      expect((await detail(ctx.branch1.id)).status).toBe(404);
      const res = await book('member', body());
      expect(res.status).toBe(409);
    });

    test('the listing of another tenant stays open while this one is not live', async () => {
      await makeBranchLive(ctx.tenant2Db, ctx.branch2.id);
      await TenantSubscription.update({ status: 'EXPIRED' }, { where: { tenantId: ctx.tenant1.id } });
      expect((await detail(ctx.branch2.id)).status).toBe(200);
      const listing2 = await GymListing.findByPk(ctx.listing2.id);
      expect(listing2.status).toBe('ACTIVE');
    });
  });
});
