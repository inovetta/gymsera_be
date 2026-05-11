const { Op, fn, col, literal } = require('sequelize');
const { GymListing, City, Area, Tenant, GymReview, User, UserGymMembership } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');

// ── listGyms ──────────────────────────────────────────────────────────────────
/**
 * Public gym directory — filters on Platform DB gym_listings.
 */
const listGyms = async ({ cityId, areaId, genderType, search, featured, page, limit, offset }) => {
  const where = { status: 'ACTIVE' };

  if (cityId) where.cityId = cityId;
  if (areaId) where.areaId = areaId;
  if (genderType) where.genderType = genderType;
  if (featured === 'true' || featured === true) where.isFeatured = true;
  if (search) {
    where.title = { [Op.like]: `%${search}%` };
  }

  const { count, rows } = await GymListing.findAndCountAll({
    where,
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
    order: [
      ['isFeatured', 'DESC'],
      ['averageRating', 'DESC'],
      ['createdAt', 'DESC'],
    ],
    limit,
    offset,
    distinct: true,
  });

  return { gyms: rows, pagination: buildPagination(count, page, limit) };
};

// ── getGym ────────────────────────────────────────────────────────────────────
/**
 * Public gym detail page.
 * Returns gym_listing + city/area + publicly visible membership plans from tenant DB.
 */
const getGym = async (gymListingId) => {
  const listing = await GymListing.findByPk(gymListingId, {
    where: { status: 'ACTIVE' },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
  });

  if (!listing || listing.status !== 'ACTIVE') throw createError('Gym not found', 404);

  // Fetch public membership plans from tenant DB
  let membershipPlans = [];
  try {
    const tenant = await Tenant.findOne({
      where: { id: listing.tenantId, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    if (tenant && tenant.connectionStringEncrypted) {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { MembershipPlan } = tenantDb.models;

      membershipPlans = await MembershipPlan.findAll({
        where: { status: 'ACTIVE' },
        attributes: ['id', 'name', 'description', 'durationType', 'durationValue', 'price', 'joiningFee', 'isTrial'],
        order: [['price', 'ASC']],
      });
    }
  } catch {
    // Non-fatal — return gym listing without plans if tenant DB is unreachable
    membershipPlans = [];
  }

  return { gym: listing, membershipPlans };
};

// ── listCities ────────────────────────────────────────────────────────────────
/**
 * Returns active cities with total active gym counts — for home page city picker.
 */
const listCities = async () => {
  const cities = await City.findAll({
    where: { isActive: true },
    attributes: [
      'id',
      'name',
      [fn('COUNT', col('gymListings.id')), 'gymCount'],
    ],
    include: [
      {
        model: GymListing,
        as: 'gymListings',
        attributes: [],
        where: { status: 'ACTIVE' },
        required: false,
      },
    ],
    group: ['City.id'],
    order: [[fn('COUNT', col('gymListings.id')), 'DESC']],
  });

  return cities;
};

// ── nearbyGyms ────────────────────────────────────────────────────────────────
/**
 * Haversine formula in SQL to find gyms within `radiusKm` of (lat, lng).
 * Returns gyms sorted by distance ascending.
 */
const nearbyGyms = async ({ lat, lng, radiusKm = 10, limit = 20, page = 1 }) => {
  const offset = (page - 1) * limit;

  // Haversine in MySQL:
  // 6371 * acos(cos(radians(lat)) * cos(radians(g_lat)) * cos(radians(g_lng) - radians(lng)) + sin(radians(lat)) * sin(radians(g_lat)))
  const distanceExpr = literal(
    `(6371 * ACOS(
       COS(RADIANS(${parseFloat(lat)})) * COS(RADIANS(\`GymListing\`.\`latitude\`))
       * COS(RADIANS(\`GymListing\`.\`longitude\`) - RADIANS(${parseFloat(lng)}))
       + SIN(RADIANS(${parseFloat(lat)})) * SIN(RADIANS(\`GymListing\`.\`latitude\`))
     ))`
  );

  const rows = await GymListing.findAll({
    attributes: {
      include: [[distanceExpr, 'distanceKm']],
    },
    where: {
      status: 'ACTIVE',
      latitude:  { [Op.not]: null },
      longitude: { [Op.not]: null },
    },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
    having: literal(`distanceKm <= ${parseFloat(radiusKm)}`),
    order: [[literal('distanceKm'), 'ASC']],
    limit: parseInt(limit),
    offset,
  });

  return { gyms: rows };
};

// ── mapGyms ───────────────────────────────────────────────────────────────────
/**
 * Returns lightweight gym pin data (id, title, lat, lng, rating, logo) for map view.
 * Optionally filtered by cityId.
 */
const mapGyms = async ({ cityId } = {}) => {
  const where = {
    status: 'ACTIVE',
    latitude:  { [Op.not]: null },
    longitude: { [Op.not]: null },
  };
  if (cityId) where.cityId = parseInt(cityId);

  const gyms = await GymListing.findAll({
    where,
    attributes: [
      'id', 'title', 'latitude', 'longitude',
      'averageRating', 'logoUrl', 'genderType',
    ],
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
    ],
    order: [['averageRating', 'DESC']],
  });

  return gyms;
};

// ── featuredGyms ──────────────────────────────────────────────────────────────
const featuredGyms = async ({ limit = 12 } = {}) => {
  const gyms = await GymListing.findAll({
    where: { status: 'ACTIVE', isFeatured: true },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
    order: [['averageRating', 'DESC']],
    limit: parseInt(limit),
  });

  return gyms;
};

// ── topRatedGyms ──────────────────────────────────────────────────────────────
const topRatedGyms = async ({ cityId, limit = 12 } = {}) => {
  const where = { status: 'ACTIVE', averageRating: { [Op.gt]: 0 } };
  if (cityId) where.cityId = parseInt(cityId);

  const gyms = await GymListing.findAll({
    where,
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
    order: [['averageRating', 'DESC']],
    limit: parseInt(limit),
  });

  return gyms;
};

// ── submitReview ──────────────────────────────────────────────────────────────
/**
 * Authenticated members who hold (or held) an active/expired subscription
 * at this gym may leave one review. Review starts as PENDING until admin approves.
 */
const submitReview = async (userId, gymListingId, { rating, title, body }) => {
  const listing = await GymListing.findByPk(gymListingId);
  if (!listing || listing.status !== 'ACTIVE') throw createError('Gym not found', 404);

  // Verify the user is/was a member of this gym
  const membership = await UserGymMembership.findOne({
    where: { userId, gymListingId },
  });
  if (!membership) {
    throw createError('You must be a member of this gym to leave a review', 403);
  }

  // One review per user per gym (unique index handles duplicate at DB level)
  const existing = await GymReview.findOne({ where: { userId, gymListingId } });
  if (existing) {
    // Allow updating a PENDING or REJECTED review
    if (existing.status === 'APPROVED') {
      throw createError('You have already reviewed this gym', 409);
    }
    await existing.update({ rating, title: title || null, body: body || null, status: 'PENDING', adminNote: null });
    return existing;
  }

  const review = await GymReview.create({
    gymListingId,
    userId,
    tenantId: listing.tenantId,
    rating,
    title: title || null,
    body: body || null,
    status: 'PENDING',
  });

  return review;
};

// ── listReviews (public) ──────────────────────────────────────────────────────
const listReviews = async (gymListingId, { page, limit, offset }) => {
  const { count, rows } = await GymReview.findAndCountAll({
    where: { gymListingId, status: 'APPROVED' },
    include: [
      { model: User, as: 'reviewer', attributes: ['id', 'fullName', 'profileImageUrl'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return { reviews: rows, pagination: buildPagination(count, page, limit) };
};

// ── adminListReviews ──────────────────────────────────────────────────────────
const adminListReviews = async ({ gymListingId, status, page, limit, offset }) => {
  const where = {};
  if (gymListingId) where.gymListingId = gymListingId;
  if (status)       where.status = status;

  const { count, rows } = await GymReview.findAndCountAll({
    where,
    include: [
      { model: User,       as: 'reviewer', attributes: ['id', 'fullName', 'email'] },
      { model: GymListing, as: 'gym',      attributes: ['id', 'title'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return { reviews: rows, pagination: buildPagination(count, page, limit) };
};

// ── moderateReview ────────────────────────────────────────────────────────────
/**
 * Admin approves or rejects a review.
 * When approved, recalculates the gym's averageRating.
 */
const moderateReview = async (reviewId, { action, adminNote }) => {
  if (!['approve', 'reject'].includes(action)) {
    throw createError('action must be approve or reject', 400);
  }

  const review = await GymReview.findByPk(reviewId);
  if (!review) throw createError('Review not found', 404);

  const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
  await review.update({ status: newStatus, adminNote: adminNote || null });

  // Recalculate average rating for the gym listing
  const { avg } = await GymReview.findOne({
    attributes: [[fn('AVG', col('rating')), 'avg']],
    where: { gymListingId: review.gymListingId, status: 'APPROVED' },
    raw: true,
  });

  await GymListing.update(
    { averageRating: avg ? parseFloat(avg).toFixed(2) : 0 },
    { where: { id: review.gymListingId } }
  );

  return review;
};

module.exports = {
  listGyms,
  getGym,
  listCities,
  nearbyGyms,
  mapGyms,
  featuredGyms,
  topRatedGyms,
  submitReview,
  listReviews,
  adminListReviews,
  moderateReview,
};
