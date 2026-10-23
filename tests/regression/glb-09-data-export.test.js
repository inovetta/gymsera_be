/**
 * GLB-09 (spec §14 R-44): GET /me/data-export — a person's own data as JSON.
 *
 * It must hold what AUTH-07 would later erase or anonymize (account, devices, saved gyms, reviews,
 * notifications, chat, and in each gym: health profile, memberships, payments, check-ins, staff
 * rows), and it must never hold secrets (password hash, session or push tokens, QR codes) or anyone
 * else's data. A gym that cannot be read is named in the file; the file never claims to be complete
 * when it is not.
 */
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, factories, setupPersonas } = require('../harness');
const { startTestServer } = require('../harness/test-server');
const {
  User,
  RefreshToken,
  DeviceToken,
  SavedGym,
  Notification,
  Conversation,
  Message,
  GymReview,
  PlatformAuditLog,
  UserGymMembership,
} = require('../../src/models/platform');
const { signToken } = require('../../src/utils/jwt.utils');
const { settingsFor } = require('../../src/middleware/rateLimiters');

const DAY = 24 * 60 * 60 * 1000;

describe('GLB-09: GET /me/data-export', () => {
  let dbHarness;
  let server;
  let db;

  const api = (path, user) => {
    const req = request(server).get(`/api/v1${path}`).set('Accept', 'application/json');
    if (user) req.set('Authorization', `Bearer ${signToken({ sub: user.id, id: user.id, email: user.email, role: user.role, isVerified: true })}`);
    return req;
  };

  const seedGym = async (connectionStringEncrypted) => {
    const owner = await factories.createUser({ role: 'GYM_HOST' });
    const tenant = await factories.createTenant({ ownerUserId: owner.id, connectionStringEncrypted });
    const listing = await factories.createGymListing(tenant.id);
    const branch = await factories.createBranch(db, listing.id, { name: 'Main' });
    return { owner, tenant, listing, branch };
  };

  /** One member with personal rows in a gym; `tag` makes every secret/note unique to this person. */
  const seedMember = async (gym, tag) => {
    const member = await factories.createUser({ role: 'MEMBER', email: `${tag}@gymseratest.com`, phone: '+923001234567' });
    const { models } = db;
    const mkGym = (await models.Gym.findOne()) || (await models.Gym.create({ name: 'G' }));
    const plan = await models.MembershipPlan.create({ gymId: mkGym.id, name: `Monthly-${tag}`, price: 3000 });
    const sub = await models.MemberSubscription.create({
      userId: member.id,
      branchId: gym.branch.id,
      membershipPlanId: plan.id,
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * DAY),
      status: 'ACTIVE',
      notes: `notes-${tag}`,
      qrCode: `QR-SECRET-${tag}`,
    });
    await models.MemberProfile.create({ userId: member.id, medicalNotes: `asthma-${tag}`, emergencyContactName: `Mum-${tag}`, emergencyContactPhone: '+92300000' });
    await models.AttendanceLog.create({ branchId: gym.branch.id, userId: member.id, memberSubscriptionId: sub.id, attendanceType: 'CHECK_IN', entryMethod: 'MANUAL', checkInAt: new Date(), notes: `checkin-${tag}` });
    await factories.createPayment(db, gym.branch.id, { userId: member.id, amount: 3000, notes: `paynote-${tag}`, proofUrl: `https://files.example.test/proofs/${tag}.jpg`, referenceEntityId: sub.id });
    await UserGymMembership.create({ userId: member.id, tenantId: gym.tenant.id, gymListingId: gym.listing.id, subscriptionId: sub.id, gymName: 'Test Gym', planName: 'Monthly', startDate: sub.startDate, endDate: sub.endDate, status: 'ACTIVE' });
    await RefreshToken.create({ userId: member.id, familyId: uuidv4(), token: `refresh-secret-${tag}`, expiresAt: new Date(Date.now() + DAY), isRevoked: false });
    await DeviceToken.create({ userId: member.id, token: `fcm-secret-${tag}`, platform: 'ios', appVersion: '1.2.3', locale: 'en', timezone: 'Asia/Karachi' });
    await SavedGym.create({ userId: member.id, gymListingId: gym.listing.id });
    await Notification.create({ userId: member.id, role: 'traveler', type: 'X', title: `title-${tag}`, message: `message-${tag}` });
    await GymReview.create({ gymListingId: gym.listing.id, userId: member.id, tenantId: gym.tenant.id, rating: 4, title: `review-title-${tag}`, body: `review-body-${tag}` });
    const convo = await Conversation.create({ tenantId: gym.tenant.id, branchId: gym.branch.id, userId: member.id, type: 'MEMBER', lastMessageText: `chat-${tag}` });
    await Message.create({ conversationId: convo.id, senderId: member.id, senderType: 'USER', text: `chat-${tag}` });
    return { member, sub };
  };

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    await setupPersonas(dbHarness);
    server = await startTestServer();
    db = dbHarness.tenant1;
  });

  afterAll(async () => {
    await teardownTestDatabases();
  });

  test('needs a signed-in user', async () => {
    const res = await api('/me/data-export');
    expect(res.status).toBe(401);
  });

  test('a member gets everything held about them, as a no-store download', async () => {
    const gym = await seedGym(db.encryptedConnStr);
    const { member } = await seedMember(gym, 'alice');

    const res = await api('/me/data-export', member);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="gymsera-my-data-\d{4}-\d{2}-\d{2}\.json"/);
    const data = res.body.data;
    expect(data.complete).toBe(true);
    expect(data.unavailable).toEqual([]);
    expect(data.account).toMatchObject({ id: member.id, email: 'alice@gymseratest.com', phone: '+923001234567' });

    const all = JSON.stringify(data);
    for (const needle of [
      'notes-alice', 'asthma-alice', 'Mum-alice', 'checkin-alice', 'paynote-alice', 'proofs/alice.jpg',
      'title-alice', 'message-alice', 'review-title-alice', 'review-body-alice', 'chat-alice', 'Asia/Karachi',
    ]) {
      expect(all).toContain(needle);
    }
    expect(data.savedGyms).toHaveLength(1);
    expect(data.gyms).toHaveLength(1);
    expect(data.gyms[0]).toMatchObject({ tenantId: gym.tenant.id });
    expect(data.gyms[0].memberProfile.medicalNotes).toBe('asthma-alice');
    expect(data.gyms[0].subscriptions).toHaveLength(1);
    expect(data.gyms[0].payments).toHaveLength(1);
    expect(data.gyms[0].attendance).toHaveLength(1);
  });

  test('never contains secrets', async () => {
    const gym = await seedGym(db.encryptedConnStr);
    const { member } = await seedMember(gym, 'bob');
    const user = await User.findByPk(member.id);

    const all = JSON.stringify((await api('/me/data-export', member)).body);

    for (const secret of ['refresh-secret-bob', 'fcm-secret-bob', 'QR-SECRET-bob', user.passwordHash, 'passwordHash', 'tokenHash', 'connectionString']) {
      if (secret) expect(all).not.toContain(secret);
    }
  });

  test('never contains another person\'s data, even in the same gym', async () => {
    const gym = await seedGym(db.encryptedConnStr);
    const { member: carol } = await seedMember(gym, 'carol');
    await seedMember(gym, 'dave');

    const all = JSON.stringify((await api('/me/data-export', carol)).body);

    expect(all).toContain('notes-carol');
    expect(all).not.toContain('dave');
  });

  test('a gym that cannot be read is named, and the file says it is incomplete', async () => {
    const gym = await seedGym(db.encryptedConnStr);
    const { member } = await seedMember(gym, 'erin');
    const broken = await seedGym('PENDING_PROVISIONING-not-a-real-connection');
    await UserGymMembership.create({ userId: member.id, tenantId: broken.tenant.id, gymListingId: broken.listing.id, subscriptionId: uuidv4(), gymName: 'Broken Gym', planName: 'X', startDate: new Date(), endDate: new Date(Date.now() + DAY), status: 'ACTIVE' });

    const data = (await api('/me/data-export', member)).body.data;

    expect(data.complete).toBe(false);
    expect(data.unavailable.map((u) => u.tenantId)).toEqual([broken.tenant.id]);
    expect(data.gyms.map((g) => g.tenantId)).toContain(gym.tenant.id);
  });

  test('a gym owner also gets their business record, without credentials', async () => {
    const gym = await seedGym(db.encryptedConnStr);

    const data = (await api('/me/data-export', gym.owner)).body.data;

    expect(data.ownedBusinesses).toHaveLength(1);
    expect(data.ownedBusinesses[0]).toMatchObject({ id: gym.tenant.id });
    expect(JSON.stringify(data)).not.toContain('connectionStringEncrypted');
  });

  test('every export is recorded in the audit log, without its contents', async () => {
    const gym = await seedGym(db.encryptedConnStr);
    const { member } = await seedMember(gym, 'fay');

    await api('/me/data-export', member);

    const row = await PlatformAuditLog.findOne({ where: { action: 'USER_DATA_EXPORT', targetId: member.id } });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row.details)).not.toContain('notes-fay');
  });

  test('is rate limited per user (a few a day, not a scraping route)', () => {
    const { max, windowMs } = settingsFor('DATA_EXPORT_USER');
    expect(windowMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(max).toBeLessThanOrEqual(100000); // test env lifts it; the production default is asserted below
    const { DEFAULTS } = require('../../src/middleware/rateLimiters');
    expect(DEFAULTS.DATA_EXPORT_USER[1]).toBeLessThanOrEqual(10);
  });
});
