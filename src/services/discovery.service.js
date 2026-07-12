const { Op, fn, col, literal } = require('sequelize');
const { GymListing, City, Area, Tenant, GymReview, User, UserGymMembership } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');

const _normalizeFacilities = (listing) => {
  if (!listing) return listing;
  const json = listing.toJSON ? listing.toJSON() : { ...listing };
  if (json.facilitiesJson) {
    if (Array.isArray(json.facilitiesJson)) {
      // Already array
    } else if (typeof json.facilitiesJson === 'object') {
      json.facilitiesJson = Object.entries(json.facilitiesJson)
        .filter(([_, enabled]) => enabled === true || enabled === 'true')
        .map(([key]) => key);
    }
  } else {
    json.facilitiesJson = [];
  }
  return json;
};

// ── listGyms ──────────────────────────────────────────────────────────────────
/**
 * Public gym directory — filters on Platform DB gym_listings.
 */
const listGyms = async ({
  cityId,
  areaId,
  genderType,
  search,
  featured,
  category,
  priceMin,
  priceMax,
  minRating,
  amenities,
  sortBy,
  lat,
  lng,
  page,
  limit,
  offset,
}) => {
  const where = { status: 'ACTIVE' };

  if (cityId) where.cityId = cityId;
  if (areaId) where.areaId = areaId;
  if (genderType) where.genderType = genderType;
  if (featured === 'true' || featured === true) where.isFeatured = true;
  if (category && category !== 'All') {
    const cats = typeof category === 'string' && category.includes(',')
      ? category.split(',').map((c) => c.trim())
      : [category];
    where.category = { [Op.in]: cats };
  }

  if (search) {
    where.title = { [Op.like]: `%${search}%` };
  }

  if (priceMin || priceMax) {
    const minVal = priceMin ? parseFloat(priceMin) : 0;
    const maxVal = priceMax ? parseFloat(priceMax) : 99999999;
    where.minPrice = { [Op.between]: [minVal, maxVal] };
  }

  if (minRating) {
    where.averageRating = { [Op.gte]: parseFloat(minRating) };
  }

  if (amenities) {
    const list = Array.isArray(amenities) ? amenities : amenities.split(',');
    where[Op.and] = where[Op.and] || [];
    list.forEach((amenity) => {
      const key = amenity.trim().toLowerCase();
      where[Op.and].push(
        literal(`(
          JSON_EXTRACT(facilities_json, '$.${key}') = true 
          OR JSON_EXTRACT(facilities_json, '$.${amenity.trim()}') = true
          OR JSON_CONTAINS(LOWER(facilities_json), '"${key}"')
        )`)
      );
    });
  }

  let order = [
    ['isFeatured', 'DESC'],
    ['averageRating', 'DESC'],
    ['createdAt', 'DESC'],
  ];

  if (sortBy) {
    const s = sortBy.toLowerCase();
    if (s === 'toprated' || s === 'top-rated') {
      order = [
        ['averageRating', 'DESC'],
        ['createdAt', 'DESC'],
      ];
    } else if (s === 'pricelow' || s === 'price: low' || s === 'price_low') {
      order = [
        ['minPrice', 'ASC'],
        ['createdAt', 'DESC'],
      ];
    } else if (s === 'pricehigh' || s === 'price: high' || s === 'price_high') {
      order = [
        ['minPrice', 'DESC'],
        ['createdAt', 'DESC'],
      ];
    } else if (s === 'nearest' && lat && lng) {
      order = [
        [
          literal(
            `(6371 * acos(cos(radians(${parseFloat(lat)})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${parseFloat(lng)})) + sin(radians(${parseFloat(lat)})) * sin(radians(latitude))))`
          ),
          'ASC',
        ],
      ];
    }
  }

  const { count, rows } = await GymListing.findAndCountAll({
    where,
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
    order,
    limit,
    offset,
    distinct: true,
  });

  const normalizedRows = rows.map((listing) => _normalizeFacilities(listing));

  return { gyms: normalizedRows, pagination: buildPagination(count, page, limit) };
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
      {
        model: Tenant,
        as: 'tenant',
        attributes: ['id', 'businessName', 'email', 'phone'],
        include: [
          {
            model: User,
            as: 'owner',
            attributes: ['id', 'fullName', 'profileImageUrl', 'createdAt'],
          },
        ],
      },
    ],
  });

  if (!listing || listing.status !== 'ACTIVE') throw createError('Gym not found', 404);

  // Fetch public membership plans + branches from tenant DB
  let membershipPlans = [];
  let branches = [];
  try {
    const tenant = await Tenant.findOne({
      where: { id: listing.tenantId, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    if (tenant && tenant.connectionStringEncrypted) {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { MembershipPlan, Branch } = tenantDb.models;

      [membershipPlans, branches] = await Promise.all([
        MembershipPlan.findAll({
          where: { status: 'ACTIVE' },
          attributes: ['id', 'name', 'description', 'durationType', 'durationValue', 'price', 'joiningFee', 'securityFee', 'isTrial', 'branchId', 'freezeLimitDays', 'visitLimit'],
          order: [['price', 'ASC']],
        }),
        Branch.findAll({
          where: { status: 'ACTIVE' },
          attributes: ['id', 'branchName', 'address', 'phone', 'openingTime', 'closingTime', 'facilitiesJson', 'imagesJson', 'latitude', 'longitude', 'cityId', 'areaId'],
          order: [['createdAt', 'ASC']],
        }),
      ]);

      // Resolve branchId -> gymListingId mapping
      const tenantListings = await GymListing.findAll({
        where: { tenantId: listing.tenantId, status: 'ACTIVE' },
        attributes: ['id', 'branchId'],
      });

      const branchToListingMap = {};
      for (const tl of tenantListings) {
        if (tl.branchId) {
          branchToListingMap[tl.branchId] = tl.id;
        }
      }

      branches = branches.map(b => {
        const plainBranch = b.get({ plain: true });
        plainBranch.gymListingId = branchToListingMap[plainBranch.id] || null;
        return plainBranch;
      });
    }
  } catch (error) {
    console.error('Error fetching tenant details in getGym:', error);
    // Non-fatal — return gym listing without plans/branches if tenant DB is unreachable
    membershipPlans = [];
    branches = [];
  }

  const normalizedGym = _normalizeFacilities(listing);
  return { gym: { ...normalizedGym, branches }, membershipPlans };
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

// ── haversineKm ───────────────────────────────────────────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ── nearbyGyms ────────────────────────────────────────────────────────────────
/**
 * Finds gyms within `radiusKm` of (lat, lng).
 * Searches both the gym's primary lat/lng (platform DB) AND each branch's
 * lat/lng (tenant DBs) so that a gym appears even if only a branch is nearby.
 * Results are sorted by distance to the nearest location (gym or branch).
 */
const nearbyGyms = async ({ lat, lng, radiusKm = 10, limit = 20, page = 1 }) => {
  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  // Step 1: find all active gyms that have a primary lat/lng set
  const allActiveGyms = await GymListing.findAll({
    where: { status: 'ACTIVE' },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ],
  });

  // Step 2: collect tenant IDs for gyms that don't already match by primary location
  // so we can scan their branches
  const gymsByPrimary = new Map();
  const gymsWithoutPrimary = [];

  for (const gym of allActiveGyms) {
    const gLat = parseFloat(gym.latitude);
    const gLng = parseFloat(gym.longitude);
    if (!isNaN(gLat) && !isNaN(gLng) && gLat !== 0 && gLng !== 0) {
      const dist = haversineKm(userLat, userLng, gLat, gLng);
      if (dist <= radiusKm) {
        gymsByPrimary.set(gym.id, { gym, distanceKm: dist });
      } else {
        // Primary location is out of range — still check branches
        gymsWithoutPrimary.push(gym);
      }
    } else {
      // No primary location — rely entirely on branches
      gymsWithoutPrimary.push(gym);
    }
  }

  // Step 3: scan tenant DBs for branch locations of gyms not already matched
  if (gymsWithoutPrimary.length > 0) {
    const tenantIds = [...new Set(gymsWithoutPrimary.map((g) => g.tenantId).filter(Boolean))];

    const tenants = await Tenant.findAll({
      where: { id: tenantIds, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    // Build a map from tenantId → gym
    const tenantToGym = new Map(gymsWithoutPrimary.map((g) => [g.tenantId, g]));

    await Promise.allSettled(
      tenants.map(async (tenant) => {
        try {
          const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
          const { Branch } = tenantDb.models;
          const branches = await Branch.findAll({
            where: { status: 'ACTIVE' },
            attributes: ['id', 'latitude', 'longitude'],
          });

          for (const branch of branches) {
            const bLat = parseFloat(branch.latitude);
            const bLng = parseFloat(branch.longitude);
            if (isNaN(bLat) || isNaN(bLng) || bLat === 0 || bLng === 0) continue;

            const dist = haversineKm(userLat, userLng, bLat, bLng);
            if (dist <= radiusKm) {
              const gym = tenantToGym.get(tenant.id);
              if (gym && !gymsByPrimary.has(gym.id)) {
                gymsByPrimary.set(gym.id, { gym, distanceKm: dist });
              } else if (gym && gymsByPrimary.has(gym.id)) {
                // Keep the shorter distance
                const existing = gymsByPrimary.get(gym.id);
                if (dist < existing.distanceKm) {
                  gymsByPrimary.set(gym.id, { gym, distanceKm: dist });
                }
              }
            }
          }
        } catch {
          // Non-fatal: skip tenant if its DB is unreachable
        }
      })
    );
  }

  // Step 4: sort by distance, paginate, and shape the response
  const sorted = Array.from(gymsByPrimary.values())
    .sort((a, b) => a.distanceKm - b.distanceKm);

  const offset = (page - 1) * limit;
  const paginated = sorted.slice(offset, offset + parseInt(limit));

  const gyms = paginated.map(({ gym, distanceKm }) => {
    const norm = _normalizeFacilities(gym);
    norm.distanceKm = Math.round(distanceKm * 10) / 10;
    return norm;
  });

  return { gyms };
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

  return gyms.map((gym) => _normalizeFacilities(gym));
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

  return gyms.map((gym) => _normalizeFacilities(gym));
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

const getPaymentDetails = async (gymListingId) => {
  const listing = await GymListing.findByPk(gymListingId);
  if (!listing) throw createError('Gym not found', 404);

  const tenant = await Tenant.findByPk(listing.tenantId, {
    attributes: ['paymentDetailsJson'],
  });

  return {
    paymentDetails: tenant ? tenant.paymentDetailsJson : null,
  };
};

module.exports = {
  listGyms,
  getGym,
  getPaymentDetails,
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
