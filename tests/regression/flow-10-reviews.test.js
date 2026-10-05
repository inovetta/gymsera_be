const request = require('supertest');
const {
  setupTestDatabases,
  teardownTestDatabases,
  setupPersonas,
} = require('../harness');
const { createUser } = require('../harness/factories');
const { signToken } = require('../../src/utils/jwt.utils');
const { startTestServer, stopTestServer } = require('../harness/test-server');

describe('FLOW-10: Review moderation, active/past subscription requirement, and controller argument fixes', () => {
  let dbHarness;
  let personas;
  let tenantId;
  let appServer;
  let branch;
  let gymListing;
  let memberToken;
  let memberUser;
  let plan;

  beforeAll(async () => {
    dbHarness = await setupTestDatabases();
    personas = await setupPersonas(dbHarness);
    tenantId = personas.owner.tenantId;

    const { Branch, MembershipPlan } = dbHarness.tenant1.models;
    const { GymListing } = require('../../src/models/platform');

    branch = await Branch.findOne({ where: { status: 'ACTIVE' } });
    gymListing = await GymListing.findOne({ where: { tenantId } });

    await branch.update({
      travelerVisibilityStatus: 'active',
      gymListingId: gymListing.id,
    });

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
      email: 'reviewer.member@gymsera.test',
      fullName: 'Reviewer Member',
    });
    memberToken = signToken({
      sub: memberUser.id,
      id: memberUser.id,
      email: memberUser.email,
      role: 'MEMBER',
      isVerified: true,
    });

    appServer = await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
    await teardownTestDatabases();
  });

  test('1. Member with only PENDING subscription is rejected with 403', async () => {
    const { MemberSubscription } = dbHarness.tenant1.models;

    // Create a PENDING subscription (never paid)
    await MemberSubscription.create({
      userId: memberUser.id,
      branchId: branch.id,
      membershipPlanId: plan.id,
      startDate: '2026-10-01',
      endDate: '2026-10-31',
      status: 'PENDING',
    });

    const res = await request(appServer)
      .post(`/api/v1/discovery/branches/${branch.id}/reviews`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        rating: 5,
        title: 'Great equipment',
        text: 'Clean and spacious branch.',
      });

    expect(res.status).toBe(403);
    expect(res.body.message || res.body.error?.message).toMatch(/active or past membership/i);
  });

  test('2. POST /discovery/gyms/:id/reviews succeeds without crashing on req.body as branchId', async () => {
    const { MemberSubscription } = dbHarness.tenant1.models;

    // Upgrade subscription to ACTIVE
    await MemberSubscription.update(
      { status: 'ACTIVE' },
      { where: { userId: memberUser.id, branchId: branch.id } }
    );

    const res = await request(appServer)
      .post(`/api/v1/discovery/gyms/${gymListing.id}/reviews`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        branchId: branch.id,
        rating: 4,
        title: 'Very solid workout',
        body: 'Good trainers and atmosphere.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.review).toBeDefined();
  });

  test('3. Submitted review has status PENDING (not auto-APPROVED)', async () => {
    const { GymReview } = require('../../src/models/platform');

    const review = await GymReview.findOne({
      where: { userId: memberUser.id, branchId: branch.id },
    });

    expect(review).toBeDefined();
    expect(review.status).toBe('PENDING');
  });

  test('4. Editing an existing review resets status to PENDING for re-moderation', async () => {
    const { GymReview } = require('../../src/models/platform');

    // Simulate admin approving the review
    const review = await GymReview.findOne({
      where: { userId: memberUser.id, branchId: branch.id },
    });
    await review.update({ status: 'APPROVED' });

    // Member edits the review
    const res = await request(appServer)
      .post(`/api/v1/discovery/branches/${branch.id}/reviews`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({
        rating: 5,
        title: 'Updated title: Even better now',
        text: 'They added brand new squat racks!',
      });

    expect(res.status).toBe(201);

    const reviewAfter = await GymReview.findOne({
      where: { userId: memberUser.id, branchId: branch.id },
    });
    expect(reviewAfter.status).toBe('PENDING');
  });

  test('5. Admin moderation approves review and updates average rating', async () => {
    const { GymReview, GymListing } = require('../../src/models/platform');

    const review = await GymReview.findOne({
      where: { userId: memberUser.id, branchId: branch.id },
    });

    const res = await request(appServer)
      .post(`/api/v1/admin/reviews/${review.id}/moderate`)
      .set('Authorization', `Bearer ${personas.platformAdmin.token}`)
      .send({ action: 'approve', adminNote: 'Verified genuine review' });

    expect(res.status).toBe(200);
    expect(res.body.data.review.status).toBe('APPROVED');

    const listingAfter = await GymListing.findByPk(gymListing.id);
    expect(parseFloat(listingAfter.averageRating)).toBe(5);
  });
});
