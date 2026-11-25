const { Op, fn, col, literal } = require('sequelize');
const { GymListing, City, Area, Tenant, TenantSubscription, GymReview, User, UserGymMembership } = require('../models/platform');
const TenantDbManager = require('../database/TenantDbManager');
const discoveryCache = require('./discovery-cache.service');
const { ENTITLING_STATUSES } = require('./subscription-quota.service');
const { DEFAULT_CURRENCY } = require('../utils/currency.utils');
const { createError, parsePagination, buildPagination } = require('../utils/response.utils');
const branchHours = require('./branch-hours.service');

/**
 * The one rule for "travellers can see this branch": open (ACTIVE), approved for
 * travellers, not suspended by an administrator, not paused by its host
 * (P5b item 2) and not locked for billing (R-83). Every traveller-facing branch read uses it.
 */
const TRAVELLER_VISIBLE_BRANCH = () => ({
  status: 'ACTIVE',
  travelerVisibilityStatus: 'active',
  adminSuspended: { [Op.ne]: true },
  pausedAt: null,
  billingLockedAt: null,
});

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
const _getTravelerVisibleListingIds = async () => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  const listingIds = [];
  await Promise.allSettled(
    tenants.map(async (tenant) => {
      try {
        if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') return;
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { Branch } = tenantDb.models;
        const branches = await Branch.findAll({
          where: TRAVELLER_VISIBLE_BRANCH(),
          attributes: ['id', 'businessId'],
        });
        for (const b of branches) {
          if (b.businessId) listingIds.push(b.businessId);
        }
      } catch (err) {
        // Ignore unreachable DBs
      }
    })
  );
  return [...new Set(listingIds)];
};

// Shared, TTL-cached snapshot of every visible branch (see discovery-cache.service).
// The array and its objects are frozen: copy before sorting or annotating.
// `fresh: true` bypasses the cache for reads that authorize a write.
const _getAllActiveBranches = ({ fresh = false } = {}) =>
  discoveryCache.getSnapshot(_buildAllActiveBranches, { fresh });

/**
 * R-87 (P10, NEW-179): a store test purchase (Apple Sandbox: TestFlight, App Review; Google
 * license tester), stored as environment SANDBOX, entitles the host but never makes a gym live
 * for travellers. Only a staging server sets SANDBOX_PURCHASES_GO_LIVE=true (exactly "true").
 */
const sandboxPurchasesGoLive = () => process.env.SANDBOX_PURCHASES_GO_LIVE === 'true';
/** The environment part of the live rule: PRODUCTION, or none (manual grant, pay later, bank transfer). */
const travellerEnvironmentWhere = () =>
  sandboxPurchasesGoLive() ? {} : { [Op.or]: [{ environment: null }, { environment: 'PRODUCTION' }] };
/** The same rule for one row already read (why-not-live). */
const entitlesTravellers = (row) =>
  ENTITLING_STATUSES.includes(row.status) && (sandboxPurchasesGoLive() || row.environment !== 'SANDBOX');

/**
 * R-77 (Phase 7 D6, BUG-26): a gym is live for travellers only when its tenant is ACTIVE and
 * its subscription entitles it (ENTITLING_STATUSES: ACTIVE = paid, GRACE = pay later or a
 * renewal the store is retrying) with a real purchase (R-87, above). The branch and plan parts
 * of the rule are in the snapshot.
 */
const _liveTenants = async (attributes) => {
  const entitled = await TenantSubscription.findAll({
    where: { status: { [Op.in]: ENTITLING_STATUSES }, ...travellerEnvironmentWhere() },
    attributes: ['organizationId'],
    raw: true,
  });
  const ids = [...new Set(entitled.map((r) => r.organizationId))];
  if (ids.length === 0) return [];
  return Tenant.findAll({ where: { status: 'ACTIVE', id: { [Op.in]: ids } }, attributes });
};

/**
 * NEW-159: is this branch id (or listing id) live for travellers under R-77? Same snapshot,
 * so the same rule, as every discovery list: a gym that is not listed does not open either.
 */
const isLiveForTravellers = async (id, { fresh = false } = {}) => {
  const live = await _getAllActiveBranches({ fresh });
  if (live.some((b) => b.id === id)) return true;
  const listing = await GymListing.findByPk(id, { attributes: ['organizationId', 'status'] });
  return !!listing && listing.status === 'ACTIVE' && live.some((b) => b.organizationId === listing.organizationId);
};

/** NEW-159: a booking (or its quote) is for a branch that is live right now (fresh: it authorizes a write). */
const assertBranchBookable = async (branchId) => {
  const live = await _getAllActiveBranches({ fresh: true });
  if (!live.some((b) => b.id === branchId)) {
    throw createError('This gym is not taking bookings right now.', 409, 'gym_not_bookable');
  }
};

/**
 * BUG-29: the name travellers see. Organization and branch with the same name (ignoring case
 * and spaces) read once ("heist", not "heist - heist"); otherwise "Organization · Branch".
 */
const _sameName = (a, b) => a.replace(/\s+/g, ' ').toLowerCase() === b.replace(/\s+/g, ' ').toLowerCase();
const displayName = (businessName, branchName) => {
  const org = (businessName || '').trim();
  const branch = (branchName || '').trim();
  if (!branch) return org;
  if (!org) return branch;
  return _sameName(org, branch) ? org : `${org} · ${branch}`;
};

const _firstPhoto = (images) => (Array.isArray(images) ? images.find((u) => typeof u === 'string' && u.trim()) : null) || null;

const _buildAllActiveBranches = async () => {
  let complete = true;
  const [tenants, listings, cities, areas] = await Promise.all([
    _liveTenants(['id', 'connectionStringEncrypted', 'cityId', 'areaId', 'areaStatus']),
    GymListing.findAll({
      where: { status: 'ACTIVE' },
      include: [
        { model: City, as: 'city', attributes: ['id', 'name'] },
        { model: Area, as: 'area', attributes: ['id', 'name', 'cityId'] },
      ]
    }),
    City.findAll({ attributes: ['id', 'name'] }),
    Area.findAll({ attributes: ['id', 'name', 'cityId'] }),
  ]);

  const cityMap = new Map(cities.map(c => [c.id, c]));
  const areaMap = new Map(areas.map(a => [a.id, a]));
  // NEW-265 (A5): branches whose own area request is pending or rejected show no area.
  const waitingBranches = await require('./area-requests.service').waitingBranchKeys();

  // BUG-27: rating and count from approved reviews only.
  const reviewStats = await GymReview.findAll({
    attributes: [
      'branchId',
      [fn('AVG', col('rating')), 'avgRating'],
      [fn('COUNT', col('id')), 'reviewCount'],
    ],
    where: { status: 'APPROVED', branchId: { [Op.ne]: null } },
    group: ['branchId'],
    raw: true,
  });
  const ratingMap = new Map(
    reviewStats.map((r) => [r.branchId, parseFloat(parseFloat(r.avgRating || 0).toFixed(2))])
  );
  const reviewCountMap = new Map(reviewStats.map((r) => [r.branchId, Number(r.reviewCount) || 0]));

  const listingMap = new Map(listings.map(l => [l.id, l]));
  const branchesList = [];

  await Promise.allSettled(
    tenants.map(async (tenant) => {
      try {
        if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') return;
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { Branch, Gym, MembershipPlan } = tenantDb.models;

        const gyms = await Gym.findAll();
        if (gyms.length === 0) return;
        const gymMap = new Map(gyms.map(g => [g.id, g]));

        const [branches, plans] = await Promise.all([
          Branch.findAll({
            where: TRAVELLER_VISIBLE_BRANCH(),
          }),
          MembershipPlan.findAll({
            where: { status: 'ACTIVE', isPublic: true },
            attributes: ['price', 'businessId', 'branchId', 'isFeatured'],
            raw: true,
          })
        ]);

        for (const b of branches) {
          const listing = b.businessId ? listingMap.get(b.businessId) : null;
          const gym = gymMap.get(b.businessId);
          if (!listing || !gym) continue;

          // Compute branch-specific minPrice dynamically based on public plans
          const branchPlans = plans.filter(p => p.businessId === b.businessId && (p.branchId === null || p.branchId === b.id));
          // Only show branches that have at least 1 active public plan
          if (branchPlans.length === 0) continue;

          const featuredPlan = branchPlans.find(p => p.isFeatured);
          let minPrice = 0;
          if (featuredPlan) {
            minPrice = parseFloat(featuredPlan.price);
          } else if (branchPlans.length > 0) {
            minPrice = Math.min(...branchPlans.map(p => parseFloat(p.price)));
          }

          const finalCityId = resolveBranchCityId(b, listing, tenant);
          const finalAreaId = resolveBranchAreaId(b, tenant, finalCityId, areaMap, waitingBranches.has(`${tenant.id}:${b.id}`));

          // Map to unified branch object
          const mappedBranch = {
            id: b.id, // primary unit is branch id!
            organizationId: tenant.id,
            branchId: b.id,
            businessId: gym.id,
            cityId: finalCityId,
            areaId: finalAreaId,
            displayName: displayName(gym.name, b.branchName),
            businessName: gym.name || null,
            branchName: b.branchName || null,
            description: gym.description || b.tagline,
            logoUrl: gym.logoUrl,
            // BUG-28: the branch's first photo, else the organization's cover or first photo, else
            // the listing's cover; null = the client's neutral placeholder.
            coverImageUrl: _firstPhoto(b.imagesJson) || gym.coverImageUrl || _firstPhoto(gym.imagesJson) || (listing && listing.coverImageUrl) || null,
            business: {
              name: gym.name || null,
              description: gym.description || null,
              logoUrl: gym.logoUrl || null,
              coverImageUrl: gym.coverImageUrl || null,
            },
            genderType: gym.genderType,
            averageRating: ratingMap.get(b.id) || 0,
            reviewCount: reviewCountMap.get(b.id) || 0,
            latitude: b.latitude ? parseFloat(b.latitude) : null,
            longitude: b.longitude ? parseFloat(b.longitude) : null,
            isFeatured: listing ? listing.isFeatured : false,
            contactPhone: b.phone || gym.contactPhone,
            website: gym.website,
            facilitiesJson: b.facilitiesJson || [],
            imagesJson: (b.imagesJson && b.imagesJson.length > 0) ? b.imagesJson : (gym.imagesJson && gym.imagesJson.length > 0 ? gym.imagesJson : (gym.coverImageUrl ? [gym.coverImageUrl] : [])),
            category: b.category || gym.category || listing?.category || 'General',
            minPrice,
            // NEW-145: the price is in the branch's currency (GLB-02, BUG-09).
            currency: b.currency || DEFAULT_CURRENCY,
            status: 'ACTIVE',
            createdAt: b.createdAt,
            city: (listing && listing.city) ? listing.city : (cityMap.get(finalCityId) || null),
            // NEW-265 (R-109): the area of the chain above, never the listing's own.
            area: finalAreaId ? (areaMap.get(finalAreaId) || null) : null,
            // R-113 H6: the week and "open now" in the branch's timezone (as of the snapshot, up to the
            // cache time late), plus the old pair as HH:MM.
            openingTime: b.openingTime || null,
            closingTime: b.closingTime || null,
            ...branchHours.readFields(b),
          };
          branchesList.push(mappedBranch);
        }
      } catch (err) {
        // One unreachable tenant must not break the list, but a snapshot that
        // skipped it is never cached.
        complete = false;
      }
    })
  );

  return { branches: branchesList, complete };
};

const filterBranches = (branches, {
  cityId,
  areaId,
  genderType,
  audience,
  search,
  featured,
  category,
  priceMin,
  priceMax,
  minRating,
  amenities,
}) => {
  let filtered = [...branches];

  if (cityId) filtered = filtered.filter(b => b.cityId === parseInt(cityId));
  if (areaId) filtered = filtered.filter(b => b.areaId === parseInt(areaId));
  if (genderType) filtered = filtered.filter(b => b.genderType?.toLowerCase() === genderType.toLowerCase());
  if (audience) filtered = filtered.filter(b => branchHours.matchesAudience(b, audience));
  if (featured === 'true' || featured === true) filtered = filtered.filter(b => b.isFeatured === true);
  if (category && category !== 'All') {
    const cats = typeof category === 'string' && category.includes(',')
      ? category.split(',').map((c) => c.trim().toLowerCase())
      : [category.toLowerCase()];
    filtered = filtered.filter(b => cats.includes(b.category?.toLowerCase()));
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(b => b.displayName?.toLowerCase().includes(s));
  }
  if (priceMin !== undefined && priceMin !== null && priceMin !== '') filtered = filtered.filter(b => b.minPrice >= parseFloat(priceMin));
  if (priceMax !== undefined && priceMax !== null && priceMax !== '') filtered = filtered.filter(b => b.minPrice <= parseFloat(priceMax));
  if (minRating !== undefined && minRating !== null && minRating !== '') filtered = filtered.filter(b => b.averageRating >= parseFloat(minRating));

  if (amenities) {
    const list = Array.isArray(amenities) ? amenities : amenities.split(',').map(a => a.trim().toLowerCase());
    filtered = filtered.filter(b => {
      const branchAmenities = Array.isArray(b.facilitiesJson)
        ? b.facilitiesJson.map(x => x.toLowerCase())
        : typeof b.facilitiesJson === 'object'
          ? Object.entries(b.facilitiesJson).filter(([_, enabled]) => enabled === true).map(([key]) => key.toLowerCase())
          : [];
      return list.every(a => branchAmenities.includes(a));
    });
  }

  return filtered;
};

const sortBranches = (branches, sortBy, lat, lng) => {
  const sorted = [...branches];
  if (!sortBy) {
    // default sort
    return sorted.sort((a, b) => {
      if (a.isFeatured !== b.isFeatured) return b.isFeatured ? 1 : -1;
      if (a.averageRating !== b.averageRating) return b.averageRating - a.averageRating;
      return b.createdAt - a.createdAt;
    });
  }

  const s = sortBy.toLowerCase();
  if (s === 'toprated' || s === 'top-rated') {
    return sorted.sort((a, b) => b.averageRating - a.averageRating);
  } else if (s === 'pricelow' || s === 'price: low' || s === 'price_low') {
    return sorted.sort((a, b) => a.minPrice - b.minPrice);
  } else if (s === 'pricehigh' || s === 'price: high' || s === 'price_high') {
    return sorted.sort((a, b) => b.minPrice - a.minPrice);
  } else if (s === 'nearest' && lat && lng) {
    const uLat = parseFloat(lat);
    const uLng = parseFloat(lng);
    return sorted.sort((a, b) => {
      const distA = haversineKm(uLat, uLng, a.latitude, a.longitude);
      const distB = haversineKm(uLat, uLng, b.latitude, b.longitude);
      return distA - distB;
    });
  }
  return sorted;
};

// ── listGyms ──────────────────────────────────────────────────────────────────
const listGyms = async ({
  cityId,
  areaId,
  genderType,
  audience,
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
}) => {
  const branches = await _getAllActiveBranches();
  const filtered = filterBranches(branches, {
    cityId,
    areaId,
    genderType,
    audience,
    search,
    featured,
    category,
    priceMin,
    priceMax,
    minRating,
    amenities,
  });

  const sorted = sortBranches(filtered, sortBy, lat, lng);
  const offset = (page - 1) * limit;
  const paginated = sorted.slice(offset, offset + limit);

  return { branches: paginated, pagination: buildPagination(sorted.length, page, limit) };
};

/**
 * Detail lookups by branch id walked every tenant in turn. The snapshot already
 * knows which tenant owns a visible branch, so try that tenant first; the full
 * walk stays as the fallback (hidden branches are not in the snapshot).
 */
const _tenantsBranchOwnerFirst = async (tenants, branchId) => {
  try {
    const snapshot = await _getAllActiveBranches();
    const hit = snapshot.find((b) => b.id === branchId || b.branchId === branchId);
    if (!hit) return tenants;
    return [...tenants.filter((t) => t.id === hit.organizationId), ...tenants.filter((t) => t.id !== hit.organizationId)];
  } catch (_) {
    return tenants;
  }
};

// ── getGym ────────────────────────────────────────────────────────────────────
const getGym = async (id) => {
  let listing = await GymListing.findByPk(id, {
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
      {
        model: Tenant,
        as: 'tenant',
        attributes: ['id', 'organizationName', 'email', 'phone'],
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

  let branchRecord = null;
  if (!listing) {
    // It might be a branchId. Let's find the branch in tenant databases.
    const tenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    for (const tenant of await _tenantsBranchOwnerFirst(tenants, id)) {
      try {
        if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { Branch } = tenantDb.models;
        const branch = await Branch.findByPk(id);
        if (branch) {
          branchRecord = branch;
          if (branch.businessId) {
            listing = await GymListing.findByPk(branch.businessId, {
              include: [
                { model: City, as: 'city', attributes: ['id', 'name'] },
                { model: Area, as: 'area', attributes: ['id', 'name'] },
                {
                  model: Tenant,
                  as: 'tenant',
                  attributes: ['id', 'organizationName', 'email', 'phone'],
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
          }
          break;
        }
      } catch (err) {
        // Ignore
      }
    }
  }

  if (!listing || listing.status !== 'ACTIVE') throw createError('Gym not found', 404);
  if (!(await isLiveForTravellers(id))) throw createError('This gym is not available right now.', 404, 'gym_not_available');

  // Fetch public membership plans + branches from tenant DB
  let membershipPlans = [];
  let branches = [];
  try {
    const tenant = await Tenant.findOne({
      where: { id: listing.organizationId, status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    if (tenant && tenant.connectionStringEncrypted) {
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { MembershipPlan, Branch, Gym } = tenantDb.models;

      const gymIdToUse = listing.id;
      let resolvedBranch = branchRecord || null;
      if (!branchRecord && listing.primaryBranchId) {
        const primaryBranch = await Branch.findOne({ where: { id: listing.primaryBranchId, businessId: listing.id, status: 'ACTIVE' } });
        if (primaryBranch) {
          resolvedBranch = primaryBranch;
        }
      }

      if (!resolvedBranch) {
        resolvedBranch = await Branch.findOne({
          where: { businessId: listing.id, status: 'ACTIVE' },
          order: [['createdAt', 'ASC'], ['id', 'ASC']],
        });
      }

      const gym = await Gym.findByPk(gymIdToUse);

      [membershipPlans, branches] = await Promise.all([
        MembershipPlan.findAll({
          where: { businessId: listing.id, status: 'ACTIVE', isPublic: true },
          attributes: ['id', 'businessId', 'name', 'description', 'durationType', 'durationValue', 'price', 'joiningFee', 'securityFee', 'isTrial', 'branchId', 'freezeLimitDays', 'visitLimit', 'isFeatured'],
          order: [['price', 'ASC']],
        }),
        Branch.findAll({
          where: {
            ...TRAVELLER_VISIBLE_BRANCH(),
            businessId: gymIdToUse,
          },
          // R-113 H6: hoursJson and timezone for the week and "open now" (Branch#toJSON).
          attributes: ['id', 'businessId', 'branchName', 'address', 'phone', 'openingTime', 'closingTime', 'hoursJson', 'timezone', 'facilitiesJson', 'imagesJson', 'latitude', 'longitude', 'cityId', 'areaId'],
          order: [['createdAt', 'ASC']],
        }),
      ]);

      branches = branches.map(b => {
        // R-113 H6: the same branch object as everywhere else (Branch#toJSON adds the week and "open now").
        const plainBranch = b.toJSON();
        return plainBranch;
      });

      // If we found by branchRecord, let's override title and other branch specific fields in the listing
      if (branchRecord && gym) {
        listing = listing.get({ plain: true });
        listing.id = branchRecord.id; // Override businessId with branchId so client matches
        listing.title = displayName(gym.name, branchRecord.branchName); // card label; becomes displayName with the discovery rows (group 3)
        listing.businessName = gym.name || null;
        listing.branchName = branchRecord.branchName || null;
        listing.shortDescription = gym.description || branchRecord.tagline; // becomes description with the discovery rows (group 3)
        listing.coverImageUrl = _firstPhoto(branchRecord.imagesJson) || gym.coverImageUrl || _firstPhoto(gym.imagesJson) || listing.coverImageUrl || null;
        listing.latitude = branchRecord.latitude ? parseFloat(branchRecord.latitude) : listing.latitude;
        listing.longitude = branchRecord.longitude ? parseFloat(branchRecord.longitude) : listing.longitude;
        listing.contactPhone = branchRecord.phone || gym.contactPhone;
        listing.facilitiesJson = (branchRecord.facilitiesJson && branchRecord.facilitiesJson.length > 0) ? branchRecord.facilitiesJson : listing.facilitiesJson;
        listing.imagesJson = (branchRecord.imagesJson && branchRecord.imagesJson.length > 0) ? branchRecord.imagesJson : (listing.imagesJson && listing.imagesJson.length > 0 ? listing.imagesJson : (listing.coverImageUrl ? [listing.coverImageUrl] : []));

        // Branch rating and count from approved reviews (BUG-27)
        const branchReviewStats = await GymReview.findOne({
          attributes: [[fn('AVG', col('rating')), 'avg'], [fn('COUNT', col('id')), 'count']],
          where: { branchId: branchRecord.id, status: 'APPROVED' },
          raw: true,
        });
        listing.averageRating = branchReviewStats && branchReviewStats.avg ? parseFloat(parseFloat(branchReviewStats.avg).toFixed(2)) : 0;
        listing.reviewCount = branchReviewStats ? Number(branchReviewStats.count) || 0 : 0;

        // Filter plans for this specific branch
        membershipPlans = membershipPlans.filter(p => p.branchId === null || p.branchId === branchRecord.id);

        // Compute starting price dynamically for this branch
        const featuredPlan = membershipPlans.find(p => p.isFeatured);
        let minPrice = 0;
        if (featuredPlan) {
          minPrice = parseFloat(featuredPlan.price);
        } else if (membershipPlans.length > 0) {
          minPrice = Math.min(...membershipPlans.map(p => parseFloat(p.price)));
        }
        listing.minPrice = minPrice;
      }
      if (typeof listing.get === 'function') listing = listing.get({ plain: true });
      // NEW-145: the detail's price is in the branch's currency.
      listing.currency = (resolvedBranch && resolvedBranch.currency) || DEFAULT_CURRENCY;
      if (listing.reviewCount === undefined) {
        listing.reviewCount = await GymReview.count({ where: { businessId: listing.id, status: 'APPROVED' } });
      }
      // BUG-09: each plan says which currency it is sold in.
      await require('./membership-plan.service').withCurrency(tenantDb, membershipPlans, resolvedBranch ? resolvedBranch.id : null);
    }
  } catch (error) {
    console.error('Error fetching tenant details in getGym:', error);
    membershipPlans = [];
    branches = [];
  }

  const normalizedGym = _normalizeFacilities(listing);
  // NEW-283: the brand is the account's (R-112). With two or more live organisations it would show the
  // first brand's name under another brand's gyms, so it is sent only for exactly one live organisation.
  if (normalizedGym.tenant && normalizedGym.organizationId) {
    const liveBrands = await GymListing.count({ where: { organizationId: normalizedGym.organizationId, status: 'ACTIVE' } });
    if (liveBrands !== 1) normalizedGym.tenant = { ...normalizedGym.tenant, organizationName: null };
  }
  return { gym: { ...normalizedGym, branches }, membershipPlans };
};

// ── getBusinessPublic / getBranchDetail (API contract v2 §3: BusinessPublic, BranchDetail) ───────────────────────
// One id, one meaning (rule 4): `/discovery/businesses/:businessId` takes a business id, `/discovery/branches/:branchId` a branch id.
// Both are built from getGym (which also decides "live for travellers"), reshaped to the contract keys. The organization's
// name, its `tenant` object and its review fields are never sent (D3).
const BUSINESS_PUBLIC_KEYS = [
  'id', 'organizationId', 'primaryBranchId', 'cityId', 'areaId', 'name', 'description', 'logoUrl', 'coverImageUrl',
  'genderType', 'averageRating', 'reviewCount', 'latitude', 'longitude', 'isFeatured', 'contactPhone', 'website',
  'facilitiesJson', 'imagesJson', 'category', 'establishedYear', 'floorArea', 'postalCode', 'country', 'minPrice',
  'currency', 'city', 'area',
];
const _toBusinessPublic = (gym) => {
  const out = {};
  for (const k of BUSINESS_PUBLIC_KEYS) out[k] = gym[k] === undefined ? null : gym[k];
  const owner = gym.tenant && gym.tenant.owner;
  out.host = owner ? { id: owner.id, fullName: owner.fullName, profileImageUrl: owner.profileImageUrl, createdAt: owner.createdAt } : null;
  out.branches = gym.branches || [];
  return out;
};

const getBusinessPublic = async (businessId) => {
  const listing = await GymListing.findByPk(businessId, { attributes: ['id'] });
  if (!listing) throw createError('Business not found', 404);
  const { gym, membershipPlans } = await getGym(businessId);
  return { business: _toBusinessPublic(gym), membershipPlans };
};

const getBranchDetail = async (branchId) => {
  const cards = await _getAllActiveBranches();
  const card = cards.find((b) => b.id === branchId);
  if (!card) throw createError('This gym is not available right now.', 404, 'gym_not_available');
  const currencyOf = new Map(cards.map((b) => [b.id, b.currency]));
  const { business, membershipPlans } = await getBusinessPublic(card.businessId);
  const { branches: _branches, ...businessOnly } = business;
  return {
    branch: card,
    business: businessOnly,
    // BUG-09: a plan says which currency it is sold in: its own branch's, and at this branch a business-wide plan is sold in this branch's currency.
    membershipPlans: membershipPlans
      .filter((p) => p.branchId == null || p.branchId === branchId)
      .map((p) => {
        const plain = typeof p.toJSON === 'function' ? p.toJSON() : { ...p };
        return { ...plain, currency: (plain.branchId && currencyOf.get(plain.branchId)) || card.currency };
      }),
  };
};

// ── listCities ────────────────────────────────────────────────────────────────
const listCities = async () => {
  const branches = await _getAllActiveBranches();
  const cityCounts = {};
  for (const b of branches) {
    if (b.cityId) {
      cityCounts[b.cityId] = (cityCounts[b.cityId] || 0) + 1;
    }
  }

  const cities = await City.findAll({
    where: { isActive: true },
    attributes: ['id', 'name', 'latitude', 'longitude'],
  });

  // BUG-26: only cities with at least one live gym (R-77). Every active city, for a host
  // registering a gym, is GET /cities.
  return cities.map(c => {
    const plain = c.get({ plain: true });
    plain.gymCount = cityCounts[c.id] || 0;
    // Phase 7 P3: the city's centre from Google (null until picked once), for "Near You" without GPS.
    plain.latitude = plain.latitude === null ? null : Number(plain.latitude);
    plain.longitude = plain.longitude === null ? null : Number(plain.longitude);
    return plain;
  }).filter((c) => c.gymCount > 0)
    .sort((a, b) => b.gymCount - a.gymCount || a.name.localeCompare(b.name));
};

/**
 * R-78 (BUG-07): the host intro's numbers, all counted, none typed in: gyms live for travellers
 * (the R-77 snapshot every list uses), cities with a live gym, and active accounts (platform
 * administrators and closed accounts excluded).
 */
const platformStats = async () => {
  const branches = await _getAllActiveBranches();
  const cities = new Set(branches.map((b) => b.cityId).filter(Boolean));
  const activeUsers = await User.count({ where: { status: 'ACTIVE', role: { [Op.ne]: 'PLATFORM_ADMIN' } } });
  return { liveGyms: branches.length, cities: cities.size, activeUsers };
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
const nearbyGyms = async ({ lat, lng, radiusKm = 10, limit = 20, page = 1, audience = null }) => {
  const branches = await _getAllActiveBranches();
  const uLat = parseFloat(lat);
  const uLng = parseFloat(lng);

  const inRange = [];
  for (const b of branches) {
    if (audience && !branchHours.matchesAudience(b, audience)) continue;
    if (b.latitude == null || b.longitude == null) continue;
    const dist = haversineKm(uLat, uLng, b.latitude, b.longitude);
    if (dist <= radiusKm) {
      inRange.push({ ...b, distanceKm: Math.round(dist * 10) / 10 });
    }
  }

  const sorted = inRange.sort((a, b) => a.distanceKm - b.distanceKm);
  const offset = (page - 1) * limit;
  const paginated = sorted.slice(offset, offset + parseInt(limit));

  return { branches: paginated };
};

// ── mapGyms ───────────────────────────────────────────────────────────────────
const mapGyms = async ({ cityId, audience = null } = {}) => {
  const branches = await _getAllActiveBranches();
  let filtered = branches.filter(b => b.latitude != null && b.longitude != null);
  if (cityId) {
    filtered = filtered.filter(b => b.cityId === parseInt(cityId));
  }
  if (audience) {
    filtered = filtered.filter(b => branchHours.matchesAudience(b, audience));
  }
  return filtered;
};

// ── featuredGyms ──────────────────────────────────────────────────────────────
const featuredGyms = async ({ limit = 12 } = {}) => {
  const branches = await _getAllActiveBranches();
  const featured = branches.filter(b => b.isFeatured === true);
  const sorted = featured.sort((a, b) => b.averageRating - a.averageRating);
  return sorted.slice(0, parseInt(limit));
};

// ── topRatedGyms ──────────────────────────────────────────────────────────────
const topRatedGyms = async ({ cityId, limit = 12 } = {}) => {
  const branches = await _getAllActiveBranches();
  let filtered = [...branches];
  if (cityId) {
    filtered = filtered.filter(b => b.cityId === parseInt(cityId));
  }
  const sorted = filtered.sort((a, b) => b.averageRating - a.averageRating);
  return sorted.slice(0, parseInt(limit));
};

// ── listOrganizations ─────────────────────────────────────────────────────────
// Built from the live-branch snapshot (R-77, BUG-26), so an organization is listed only
// with at least one live branch, and shares the snapshot's cache and invalidation.
// `featured` is accepted and, as before, not applied.
const listOrganizations = async ({ featured, page = 1, limit = 12 }) => {
  const branches = await _getAllActiveBranches();
  const byGym = new Map();
  for (const b of branches) {
    const key = `${b.organizationId}:${b.businessId}`;
    if (!byGym.has(key)) byGym.set(key, []);
    byGym.get(key).push(b);
  }

  const orgs = [...byGym.values()].map((list) => {
    const first = list[0];
    const org = first.business || {};
    const reviewCount = list.reduce((n, b) => n + (b.reviewCount || 0), 0);
    // Weighted by each branch's approved reviews (BUG-27); 0 with none.
    const ratingSum = list.reduce((n, b) => n + (b.averageRating || 0) * (b.reviewCount || 0), 0);
    const averageRating = reviewCount > 0 ? Math.round((ratingSum / reviewCount) * 10) / 10 : 0;
    return {
      id: first.businessId,
      businessId: first.businessId,
      organizationId: first.organizationId,
      name: org.name,
      description: org.description,
      logoUrl: org.logoUrl,
      // BUG-28: the organization's own cover, else its first branch photo.
      coverImageUrl: org.coverImageUrl || list.map((b) => b.coverImageUrl).find(Boolean) || null,
      branchCount: list.length,
      averageRating,
      reviewCount,
      tagline: org.description ? org.description.slice(0, 60) : null,
    };
  }).sort((a, b) => b.averageRating - a.averageRating || (a.name || '').localeCompare(b.name || ''));

  const offset = (page - 1) * limit;
  return {
    businesses: orgs.slice(offset, offset + parseInt(limit)),
    pagination: buildPagination(orgs.length, page, limit),
  };
};

// ── listOrganizationBranches ──────────────────────────────────────────────────
const listOrganizationBranches = async (businessId) => {
  const branches = (await _getAllActiveBranches())
    .filter((b) => b.businessId === businessId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (branches.length === 0) throw createError('Organization not found', 404);
  return { branches };
};

// ── getGymListingByIdentifier (helper) ────────────────────────────────────────
const getGymListingByIdentifier = async (identifier) => {
  // 1. Direct platform listing lookup
  let listing = await GymListing.findByPk(identifier);
  if (listing) return listing;

  // 2. Branch ID → businessId lookup
  const branches = await _getAllActiveBranches();
  const matched = branches.find(b => b.id === identifier || b.branchId === identifier);
  if (matched && matched.businessId) {
    listing = await GymListing.findByPk(matched.businessId);
    if (listing) return listing;
  }

  // 3. If no listing found but branch exists, return a synthetic listing-like object
  //    so reviews summary/list don't 404 (they'll just return empty data)
  if (matched) {
    return {
      id: matched.businessId || matched.id,
      organizationId: matched.organizationId,
      title: matched.displayName,
      averageRating: matched.averageRating || 0,
      _isSynthetic: true,
    };
  }

  return null;
};

// ── _recalculateAverageRating (helper) ────────────────────────────────────────
// Recalculates averageRating on GymListing based on all approved reviews for that branch.
const _recalculateAverageRating = async (businessId, branchId) => {
  const where = { businessId, status: 'APPROVED' };
  if (branchId) where.branchId = branchId;

  const result = await GymReview.findOne({
    attributes: [[fn('AVG', col('rating')), 'avg']],
    where,
    raw: true,
  });

  const avg = result && result.avg ? parseFloat(result.avg) : 0;
  // Update listing-level average (reflects the overall gym, not per-branch)
  await GymListing.update(
    { averageRating: parseFloat(avg.toFixed(2)) },
    { where: { id: businessId } }
  );
};

// ── getReviewsSummary ─────────────────────────────────────────────────────────
/**
 * Branch-level review summary.
 * branchId is required to scope reviews to a specific branch.
 * If no GymListing is found (synthetic), we still return the branch-scoped summary.
 */
const getReviewsSummary = async (businessId, branchId, { viewerUserId = null } = {}) => {
  const where = { status: 'APPROVED' };
  if (branchId) {
    where.branchId = branchId;
  } else if (businessId) {
    where.businessId = businessId;
  }

  // Try to get stored average from listing for display
  const listing = await GymListing.findByPk(businessId).catch(() => null);
  if (!listing && !branchId) {
    return {
      averageRating: 0,
      totalReviews: 0,
      ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
      previewReview: null,
    };
  }

  const reviews = await GymReview.findAll({
    where,
    attributes: ['rating'],
    raw: true,
  });

  const totalReviews = reviews.length;
  const ratingBreakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;

  for (const r of reviews) {
    if (ratingBreakdown[r.rating] !== undefined) {
      ratingBreakdown[r.rating]++;
    }
    sum += r.rating;
  }

  const averageRating = totalReviews > 0 ? parseFloat((sum / totalReviews).toFixed(2)) : 0;

  // NEW-256: the preview is never a review the viewer reported (the totals are unchanged).
  const hiddenIds = await require('./content-report.service').hiddenReviewIdsFor(viewerUserId);
  const preview = await GymReview.findOne({
    where: hiddenIds.length ? { ...where, id: { [Op.notIn]: hiddenIds } } : where,
    include: [
      { model: User, as: 'reviewer', attributes: ['id', 'fullName', 'profileImageUrl'] },
    ],
    order: [['createdAt', 'DESC']],
  });

  return {
    averageRating,
    totalReviews,
    ratingBreakdown,
    previewReview: preview || null,
  };
};

const submitReview = async (userId, businessId, branchId, { rating, title, body }) => {
  if (!branchId) throw createError('branchId is required to submit a review', 400);
  // NEW-256: the word filter runs before anything else is looked up or stored.
  await require('./moderation-words.service').assertClean(title, body);

  // Find the organizationId of this branch (fresh: this read authorizes a write)
  const branches = await _getAllActiveBranches({ fresh: true });
  const matched = branches.find(b => b.id === branchId || b.branchId === branchId);
  if (!matched) throw createError('Branch not found', 404);

  const organizationId = matched.organizationId;

  // Retrieve the tenant DB connection to query its source-of-truth subscriptions table
  const tenant = await Tenant.findOne({
    where: { id: organizationId, status: 'ACTIVE' },
  });
  if (!tenant || !tenant.connectionStringEncrypted) {
    throw createError('Gym organization database is not active', 403);
  }

  // Check if the user is the owner/host of the gym/tenant
  if (tenant.ownerUserId === userId) {
    throw createError('you are an owner of the gym you dont have permission to review', 403);
  }

  const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
  const { MemberSubscription } = tenantDb.models;
  const { SubscriptionStatus } = require('../constants/subscription-status');

  // Verify that the user has an active or past subscription to this specific branch
  const subscription = await MemberSubscription.findOne({
    where: {
      userId,
      branchId,
      status: {
        [Op.in]: [
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.EXPIRED,
          SubscriptionStatus.FROZEN,
        ],
      },
    },
  });
  if (!subscription) {
    throw createError('You must have an active or past membership at this gym to leave a review', 403);
  }

  let review = null;
  // One review per user per branch
  const existing = await GymReview.findOne({ where: { userId, branchId } });
  if (existing) {
    await existing.update({
      rating,
      title: title || null,
      body: body || null,
      status: 'PENDING',
      adminNote: null,
    });
    await _recalculateAverageRating(businessId, branchId);
  } else {
    review = await GymReview.create({
      businessId: businessId || null,
      branchId,
      userId,
      organizationId,
      rating,
      title: title || null,
      body: body || null,
      status: 'PENDING',
    });
  }

  const finalReview = existing || review;

  // Create unified Host notification
  try {
    const { User: PlatformUser } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const travelerUser = await PlatformUser.findByPk(userId);
    const travelerName = travelerUser ? travelerUser.fullName : 'Traveler';
    const branchName = matched ? (matched.branchName || matched.name || 'Branch') : 'Branch';

    if (tenant && tenant.ownerUserId) {
      await notificationsService.createNotification({
        userId: tenant.ownerUserId,
        role: 'host',
        type: 'review_submitted',
        title: 'New Review Submitted',
        message: `New review submitted for ${branchName} by ${travelerName}: ${rating} stars.`,
        deepLink: '/host/listings',
        metadataJson: { branchId, reviewId: finalReview.id },
      });
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create review submission notification:', notifErr.message);
  }

  return finalReview;
};

// ── listReviews (public) ──────────────────────────────────────────────────────
/**
 * Branch-scoped review listing.
 * If branchId is provided, only returns reviews for that specific branch.
 */
const listReviews = async (businessId, branchId, { page, limit, offset, sort = 'recent', filter = 'all', viewerUserId = null }) => {
  const where = { status: 'APPROVED' };

  // NEW-256: a review the viewer reported is hidden from them at once.
  const hiddenIds = await require('./content-report.service').hiddenReviewIdsFor(viewerUserId);
  if (hiddenIds.length) where.id = { [Op.notIn]: hiddenIds };

  // Scope to branch if provided, else fall back to listing-level
  if (branchId) {
    where.branchId = branchId;
  } else if (businessId) {
    where.businessId = businessId;
  }

  if (filter && filter !== 'all' && filter !== 'All') {
    const starStr = filter.replace('star', '');
    const starVal = parseInt(starStr);
    if (!isNaN(starVal)) {
      where.rating = starVal;
    }
  }

  let order = [['createdAt', 'DESC']];
  if (sort === 'highest') {
    order = [['rating', 'DESC'], ['createdAt', 'DESC']];
  } else if (sort === 'lowest') {
    order = [['rating', 'ASC'], ['createdAt', 'DESC']];
  }

  const { count, rows } = await GymReview.findAndCountAll({
    where,
    include: [
      { model: User, as: 'reviewer', attributes: ['id', 'fullName', 'profileImageUrl'] },
    ],
    order,
    limit,
    offset,
    distinct: true,
  });

  return { reviews: rows, pagination: buildPagination(count, page, limit) };
};

// ── adminListReviews ──────────────────────────────────────────────────────────
const adminListReviews = async ({ businessId, status, page, limit, offset }) => {
  const where = {};
  if (businessId) where.businessId = businessId;
  if (status) where.status = status;

  const { count, rows } = await GymReview.findAndCountAll({
    where,
    include: [
      { model: User, as: 'reviewer', attributes: ['id', 'fullName', 'email'] },
      { model: GymListing, as: 'gym', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  // P9b (BUG-29 on CMS lists): a review is for a branch; name the gym by the traveller rule
  // (displayName: the name once when organization and branch match, else "Organization · Branch").
  // A branch travellers cannot see is not in the snapshot: the organization's title is used.
  let titles = new Map();
  try {
    titles = new Map((await _getAllActiveBranches()).map((b) => [b.branchId, b.displayName]));
  } catch (err) {
    console.warn('[adminListReviews] branch titles unavailable:', err.message);
  }
  const reviews = rows.map((r) => {
    const json = typeof r.toJSON === 'function' ? r.toJSON() : { ...r };
    json.gymTitle = (r.branchId && titles.get(r.branchId)) || (json.gym && json.gym.name) || null;
    return json;
  });

  return { reviews, pagination: buildPagination(count, page, limit) };
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

  await _recalculateAverageRating(review.businessId);

  // Create unified Traveler and Host notifications
  try {
    const { Tenant, GymListing } = require('../models/platform');
    const notificationsService = require('./notifications.service');
    const listing = await GymListing.findByPk(review.businessId);
    const branchName = listing ? listing.name : 'Gym';
    const tenant = await Tenant.findByPk(review.organizationId);

    if (action === 'approve') {
      await notificationsService.createNotification({
        userId: review.userId,
        role: 'traveler',
        type: 'review_approved',
        title: 'Review Approved',
        message: `Your review for ${branchName} has been approved.`,
        deepLink: '/traveler/inbox',
        metadataJson: { reviewId: review.id },
      });
    } else {
      // Flagged/Rejected
      await notificationsService.createNotification({
        userId: review.userId,
        role: 'traveler',
        type: 'review_rejected',
        title: 'Review Flagged',
        message: `Your review for ${branchName} was flagged and hidden by admin. Reason: ${adminNote || 'None'}.`,
        deepLink: '/traveler/inbox',
        metadataJson: { reviewId: review.id },
      });

      if (tenant && tenant.ownerUserId) {
        await notificationsService.createNotification({
          userId: tenant.ownerUserId,
          role: 'host',
          type: 'review_rejected',
          title: 'Review Flagged by Admin',
          message: `A review for ${branchName} was hidden by admin. Reason: ${adminNote || 'None'}.`,
          deepLink: '/host/listings',
          metadataJson: { reviewId: review.id },
        });
      }
    }
  } catch (notifErr) {
    console.warn('[Notification Error] Failed to create review moderation notifications:', notifErr.message);
  }

  return review;
};


const _resolveTenantId = async (id) => {
  const listing = await GymListing.findByPk(id, { attributes: ['organizationId'] });
  if (listing) return listing.organizationId;

  // Search by branch ID
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  for (const tenant of await _tenantsBranchOwnerFirst(tenants, id)) {
    try {
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Branch } = tenantDb.models;
      const branch = await Branch.findByPk(id);
      if (branch) {
        return tenant.id;
      }
    } catch (err) {
      // Ignore
    }
  }
  return null;
};

/**
 * The city a branch is listed under: its own, else its organization's, else the
 * tenant's. Null when none is known (NEW-113): it used to fall back to city id 1, so a
 * branch with no city showed up under whichever city happened to be first.
 */
const resolveBranchCityId = (branch, listing, tenant) =>
  branch.cityId || (listing ? listing.cityId : null) || (tenant ? tenant.cityId : null) || null;

/**
 * NEW-265 (A5, R-109 points 3 and 4): the area a traveller sees for a branch. (1) The branch's own area;
 * a branch waiting on its own request (pending or rejected) has none, and the chain stops. (2) Else the
 * tenant's first-branch default area (R-111), only when it is in the branch's city and not pending / rejected. The listing's area is
 * not a step (before: `branch || listing || tenant`, whatever the cities).
 */
const resolveBranchAreaId = (branch, tenant, branchCityId, areaMap, branchWaiting) => {
  if (branch.areaId) return branch.areaId;
  if (branchWaiting) return null;
  if (!tenant || !tenant.areaId || tenant.areaStatus) return null;
  const area = areaMap.get(tenant.areaId);
  if (!area || !branchCityId || Number(area.cityId) !== Number(branchCityId)) return null;
  return tenant.areaId;
};

// BUG-35: the payment details a traveller is shown. Blank values are dropped; null when
// nothing is left, so the app can say the gym has not added them instead of "Loading".
const TRAVELLER_PAYMENT_FIELDS = [
  'bankName', 'accountTitle', 'accountNumber', 'iban', 'branchCode',
  'jazzCashNumber', 'easyPaisaNumber', 'additionalInstructions',
];
const travellerPaymentDetails = (json) => {
  if (!json || typeof json !== 'object') return null;
  const details = {};
  for (const key of TRAVELLER_PAYMENT_FIELDS) {
    const value = json[key];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
      details[key] = String(value).trim();
    }
  }
  return Object.keys(details).length > 0 ? details : null;
};

const getPaymentDetails = async (businessId) => {
  const organizationId = await _resolveTenantId(businessId);
  if (!organizationId || !(await isLiveForTravellers(businessId))) throw createError('This gym is not available right now.', 404, 'gym_not_available');

  // P7b (R-94): the payout account of this organization (or of the branch's organization), else
  // the tenant default. `id` is an organization (gym listing) id or a branch id.
  const payoutAccountService = require('./payout-account.service');
  const listing = await GymListing.findByPk(businessId, { attributes: ['id', 'organizationId'] });
  const account = listing && listing.organizationId === organizationId
    ? await payoutAccountService.resolve({ organizationId, businessId: listing.id })
    : await payoutAccountService.resolveForBranch(
      await TenantDbManager.getConnection(organizationId, (await Tenant.findByPk(organizationId, { attributes: ['connectionStringEncrypted'] })).connectionStringEncrypted),
      organizationId,
      businessId
    );

  return {
    paymentDetails: travellerPaymentDetails(account ? account.details : null),
  };
};

const listTopBusinesses = async () => {
  const cards = await _getAllActiveBranches();
  const byBusiness = new Map();
  for (const b of cards) {
    if (!byBusiness.has(b.businessId)) byBusiness.set(b.businessId, []);
    byBusiness.get(b.businessId).push(b);
  }
  // API contract v2 §3 TopBusiness: one row per business (was one per organization with the owner's name).
  return [...byBusiness.values()]
    .map((list) => {
      const first = list[0];
      const reviewCount = list.reduce((n, b) => n + (b.reviewCount || 0), 0);
      const ratingSum = list.reduce((n, b) => n + (b.averageRating || 0) * (b.reviewCount || 0), 0);
      const biz = first.business || {};
      return {
        id: first.businessId,
        businessId: first.businessId,
        organizationId: first.organizationId,
        businessName: first.businessName || biz.name || null,
        logoUrl: biz.logoUrl || null,
        coverImageUrl: biz.coverImageUrl || list.map((b) => b.coverImageUrl).find(Boolean) || null,
        averageRating: reviewCount > 0 ? Math.round((ratingSum / reviewCount) * 100) / 100 : 0,
        reviewCount, // BUG-27: approved reviews; 0 = "New"
        branchCount: list.length,
        branches: list,
      };
    })
    .sort((a, b) => b.averageRating - a.averageRating || b.reviewCount - a.reviewCount);
};

module.exports = {
  resolveBranchCityId,
  resolveBranchAreaId,
  displayName,
  listGyms,
  getGym,
  getBusinessPublic,
  getBranchDetail,
  BUSINESS_PUBLIC_KEYS,
  getPaymentDetails,
  isLiveForTravellers,
  entitlesTravellers,
  platformStats,
  assertBranchBookable,
  listCities,
  nearbyGyms,
  mapGyms,
  featuredGyms,
  topRatedGyms,
  submitReview,
  listReviews,
  adminListReviews,
  moderateReview,
  getReviewsSummary,
  getGymListingByIdentifier,
  listTopBusinesses,
  listOrganizations,
  listOrganizationBranches,
};
