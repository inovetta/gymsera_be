const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { generateAttendanceQrToken, _clearInMemoryNonces } = require('../../src/utils/qr.utils');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('FLOW-09: Attendance QR rotating signed tokens, raw ID rejection & duplicate window', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let branch;
  let memberUser;
  let memberToken;
  let plan;
  let subscription;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;

    const { Branch, MembershipPlan, MemberSubscription } = dbHarness.tenant1.models;
    branch = await Branch.findOne({ where: { status: 'ACTIVE' } });

    plan = await MembershipPlan.create({
      gymId: branch.gymId || branch.id,
      branchId: branch.id,
      name: 'Standard Monthly',
      price: 5000,
      priceMinor: 500000,
      durationType: 'MONTHLY',
      durationValue: 1,
      isPublic: true,
      status: 'ACTIVE',
    });

    memberUser = await createUser({
      role: 'MEMBER',
      email: 'flow09.member@gymsera.test',
      fullName: 'Attendance Member',
    });
    memberToken = signToken({
      sub: memberUser.id,
      id: memberUser.id,
      email: memberUser.email,
      role: 'MEMBER',
      isVerified: true,
    });

    subscription = await MemberSubscription.create({
      userId: memberUser.id,
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      status: 'ACTIVE',
      qrCode: 'GE-STATIC-TOKEN-12345',
    });

    const { UserGymMembership, GymListing } = require('../../src/models/platform');
    const listing = await GymListing.findOne({ where: { tenantId } });
    await UserGymMembership.create({
      userId: memberUser.id,
      tenantId,
      branchId: branch.id,
      gymListingId: listing ? listing.id : branch.id,
      subscriptionId: subscription.id,
      planName: plan.name,
      status: 'ACTIVE',
      startDate: '2026-10-01',
      endDate: '2026-10-31',
    });

    appServer = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  beforeEach(() => {
    _clearInMemoryNonces();
  });

  test('1. Reject raw subscriptionId when scanned as QR code (must reject with 400)', async () => {
    const res = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: subscription.id,
        branchId: branch.id,
      });

    expect(res.status).toBe(400);
    expect(res.body.message || res.body.error?.message).toMatch(/raw subscription or user IDs are not permitted/i);
  });

  test('2. Reject raw userId when scanned as QR code (must reject with 400)', async () => {
    const res = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: memberUser.id,
        branchId: branch.id,
      });

    expect(res.status).toBe(400);
    expect(res.body.message || res.body.error?.message).toMatch(/raw subscription or user IDs are not permitted/i);
  });

  test('3. Valid rotating signed QR token is accepted and records check-in', async () => {
    const validQrToken = generateAttendanceQrToken({
      subscriptionId: subscription.id,
      userId: memberUser.id,
      tenantId,
      branchId: branch.id,
    });

    const res = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: validQrToken,
        branchId: branch.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.log.attendanceType).toBe('CHECK_IN');
    expect(res.body.data.log.userId).toBe(memberUser.id);
  });

  test('4. Replayed QR token (same nonce) is rejected with 409', async () => {
    const reusableQrToken = generateAttendanceQrToken({
      subscriptionId: subscription.id,
      userId: memberUser.id,
      tenantId,
      branchId: branch.id,
    });

    // Clean previous logs to avoid 5-min duplicate check-in collision for this test
    const { AttendanceLog } = dbHarness.tenant1.models;
    await AttendanceLog.destroy({ where: { userId: memberUser.id } });

    // First scan succeeds
    const res1 = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: reusableQrToken,
        branchId: branch.id,
      });
    expect(res1.status).toBe(201);

    // Immediate second scan with identical token (replayed nonce)
    const res2 = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: reusableQrToken,
        branchId: branch.id,
      });

    expect(res2.status).toBe(409);
    expect(res2.body.message || res2.body.error?.message).toMatch(/already been scanned/i);
  });

  test('5. Expired rotating QR token (>60s) is rejected with 401', async () => {
    // Generate a token that expired 10 seconds ago
    const expiredToken = generateAttendanceQrToken(
      {
        subscriptionId: subscription.id,
        userId: memberUser.id,
        tenantId,
        branchId: branch.id,
      },
      -10 // expired
    );

    const res = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({
        qrCode: expiredToken,
        branchId: branch.id,
      });

    expect(res.status).toBe(401);
    expect(res.body.message || res.body.error?.message).toMatch(/expired/i);
  });

  test('6. Duplicate check-in within window is rejected with 409 ALREADY_CHECKED_IN', async () => {
    const { AttendanceLog } = dbHarness.tenant1.models;
    await AttendanceLog.destroy({ where: { userId: memberUser.id } });

    // First check-in with a fresh token
    const token1 = generateAttendanceQrToken({
      subscriptionId: subscription.id,
      userId: memberUser.id,
      tenantId,
      branchId: branch.id,
    });
    const res1 = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({ qrCode: token1, branchId: branch.id });
    expect(res1.status).toBe(201);

    // Second check-in with a DIFFERENT fresh token (new nonce), but within duplicate window
    const token2 = generateAttendanceQrToken({
      subscriptionId: subscription.id,
      userId: memberUser.id,
      tenantId,
      branchId: branch.id,
    });
    const res2 = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({ qrCode: token2, branchId: branch.id });

    expect(res2.status).toBe(409);
    expect(res2.body.message || res2.body.error?.message).toMatch(/already checked in/i);
  });

  test('7. Member endpoints (GET /me/subscriptions/:id and /qr-token) provide valid rotating token', async () => {
    // 1. Fetch subscription detail
    const detailRes = await request(appServer)
      .get(`/api/v1/me/subscriptions/${subscription.id}`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(detailRes.status).toBe(200);
    const fetchedQr = detailRes.body.data.subscription.qrCode;
    expect(fetchedQr).toBeDefined();
    expect(fetchedQr).not.toBe('GE-STATIC-TOKEN-12345');

    // 2. Fetch dedicated qr-token endpoint
    const tokenRes = await request(appServer)
      .get(`/api/v1/me/subscriptions/${subscription.id}/qr-token`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.data.qrToken).toBeDefined();
    expect(tokenRes.body.data.expiresIn).toBe(60);

    // Clean previous logs
    const { AttendanceLog } = dbHarness.tenant1.models;
    await AttendanceLog.destroy({ where: { userId: memberUser.id } });

    // 3. Scan the fetched rotating token
    const scanRes = await request(appServer)
      .post('/api/v1/attendance/qr-scan')
      .set('Authorization', `Bearer ${personas.manager.token}`)
      .send({ qrCode: tokenRes.body.data.qrToken, branchId: branch.id });
    expect(scanRes.status).toBe(201);
    expect(scanRes.body.data.log.attendanceType).toBe('CHECK_IN');
  });
});
