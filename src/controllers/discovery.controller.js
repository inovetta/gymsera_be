const discoveryService = require('../services/discovery.service');
const inboxService = require('../services/inbox.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── GET /discovery/cities ─────────────────────────────────────────────────────
const listCities = async (req, res, next) => {
  try {
    const cities = await discoveryService.listCities();
    return sendSuccess(res, { cities });
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms ───────────────────────────────────────────────────────
const listGyms = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 12, 50);
    const {
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
    } = req.query;

    const result = await discoveryService.listGyms({
      cityId: cityId ? parseInt(cityId) : null,
      areaId: areaId ? parseInt(areaId) : null,
      genderType: genderType || null,
      search: search || null,
      featured: featured || null,
      category: category || null,
      priceMin: priceMin ? parseFloat(priceMin) : null,
      priceMax: priceMax ? parseFloat(priceMax) : null,
      minRating: minRating ? parseFloat(minRating) : null,
      amenities: amenities || null,
      sortBy: sortBy || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { gyms: result.gyms }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/nearby ────────────────────────────────────────────────
const nearbyGyms = async (req, res, next) => {
  try {
    const { lat, lng, radius = 10, page = 1, limit = 20 } = req.query;
    const result = await discoveryService.nearbyGyms({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      radiusKm: parseFloat(radius),
      page: parseInt(page),
      limit: parseInt(limit),
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/map ───────────────────────────────────────────────────
const mapGyms = async (req, res, next) => {
  try {
    const { cityId } = req.query;
    const gyms = await discoveryService.mapGyms({ cityId: cityId || null });
    return sendSuccess(res, { gyms });
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/featured ─────────────────────────────────────────────
const featuredGyms = async (req, res, next) => {
  try {
    const { limit = 12 } = req.query;
    const gyms = await discoveryService.featuredGyms({ limit });
    return sendSuccess(res, { gyms });
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/top-rated ────────────────────────────────────────────
const topRatedGyms = async (req, res, next) => {
  try {
    const { cityId, limit = 12 } = req.query;
    const gyms = await discoveryService.topRatedGyms({ cityId: cityId || null, limit });
    return sendSuccess(res, { gyms });
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/:id ───────────────────────────────────────────────────
const getGym = async (req, res, next) => {
  try {
    const result = await discoveryService.getGym(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/:id/payment-details ───────────────────────────────────
const getPaymentDetails = async (req, res, next) => {
  try {
    const result = await discoveryService.getPaymentDetails(req.params.id);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /discovery/gyms/:id/reviews ──────────────────────────────────────────
const listReviews = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 10, 50);
    const result = await discoveryService.listReviews(req.params.id, { page, limit, offset });
    return sendSuccess(res, { reviews: result.reviews }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── POST /discovery/gyms/:id/reviews ─────────────────────────────────────────
const submitReview = async (req, res, next) => {
  try {
    const review = await discoveryService.submitReview(req.user.sub, req.params.id, req.body);
    return sendSuccess(res, { review }, 'Review submitted and pending approval', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /admin/reviews (admin) ────────────────────────────────────────────────
const adminListReviews = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { gymListingId, status } = req.query;
    const result = await discoveryService.adminListReviews({ gymListingId, status, page, limit, offset });
    return sendSuccess(res, { reviews: result.reviews }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── POST /admin/reviews/:id/moderate ─────────────────────────────────────────
const moderateReview = async (req, res, next) => {
  try {
    const review = await discoveryService.moderateReview(req.params.id, req.body);
    return sendSuccess(res, { review }, 'Review updated');
  } catch (err) {
    next(err);
  }
};

const submitInquiry = async (req, res, next) => {
  try {
    const result = await inboxService.createTravelerInquiry(
      req.user.sub,
      req.params.branchId,
      req.body.message
    );
    return sendSuccess(res, result, 'Inquiry submitted successfully', 201);
  } catch (err) {
    next(err);
  }
};

const getBranchReviewsSummary = async (req, res, next) => {
  try {
    const { branchId } = req.params;
    const listing = await discoveryService.getGymListingByIdentifier(branchId);
    if (!listing) return res.status(404).json({ success: false, message: 'Gym listing not found' });

    const summary = await discoveryService.getReviewsSummary(listing.id, branchId);
    return sendSuccess(res, summary, 'OK');
  } catch (err) {
    next(err);
  }
};

const listBranchReviews = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { sort, filter } = req.query;
    const { branchId } = req.params;

    const listing = await discoveryService.getGymListingByIdentifier(branchId);
    if (!listing) return res.status(404).json({ success: false, message: 'Gym listing not found' });

    const result = await discoveryService.listReviews(listing.id, branchId, { page, limit, offset, sort, filter });
    return sendSuccess(res, { reviews: result.reviews }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

const submitBranchReview = async (req, res, next) => {
  try {
    const { rating, title, text } = req.body;
    const { branchId } = req.params;

    const listing = await discoveryService.getGymListingByIdentifier(branchId);
    if (!listing) return res.status(404).json({ success: false, message: 'Gym listing not found' });

    const review = await discoveryService.submitReview(req.user.sub, listing.id, branchId, {
      rating,
      title,
      body: text,
    });
    return sendSuccess(res, { review }, 'Review submitted and approved', 201);
  } catch (err) {
    next(err);
  }
};

const listOrganizations = async (req, res, next) => {
  try {
    const { featured, page, limit } = req.query;
    const result = await discoveryService.listOrganizations({
      featured: featured === 'true' || featured === true,
      page: parseInt(page || '1'),
      limit: parseInt(limit || '12'),
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

const listOrganizationBranches = async (req, res, next) => {
  try {
    const result = await discoveryService.listOrganizationBranches(req.params.gymId);
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

const getTopHosts = async (req, res, next) => {
  try {
    const result = await discoveryService.listTopHosts();
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listCities,
  listGyms,
  nearbyGyms,
  mapGyms,
  featuredGyms,
  topRatedGyms,
  getGym,
  getPaymentDetails,
  listReviews,
  submitReview,
  adminListReviews,
  moderateReview,
  submitInquiry,
  getBranchReviewsSummary,
  listBranchReviews,
  submitBranchReview,
  listOrganizations,
  listOrganizationBranches,
  getTopHosts,
};
