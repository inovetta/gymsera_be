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
          where: { status: 'ACTIVE', travelerVisibilityStatus: 'active' },
          attributes: ['id', 'gymListingId'],
        });
        for (const b of branches) {
          if (b.gymListingId) listingIds.push(b.gymListingId);
        }
      } catch (err) {
        // Ignore unreachable DBs
      }
    })
  );
  return [...new Set(listingIds)];
};

const _getAllActiveBranches = async () => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  const listings = await GymListing.findAll({
    where: { status: 'ACTIVE' },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ]
  });

  // Load branch-level average ratings from platform reviews
  const reviewStats = await GymReview.findAll({
    attributes: [
      'branchId',
      [fn('AVG', col('rating')), 'avgRating'],
    ],
    where: { status: 'APPROVED', branchId: { [Op.ne]: null } },
    group: ['branchId'],
    raw: true,
  });
  const ratingMap = new Map(
    reviewStats.map((r) => [r.branchId, parseFloat(parseFloat(r.avgRating || 0).toFixed(2))])
  );

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
            where: { status: 'ACTIVE', travelerVisibilityStatus: 'active' },
          }),
          MembershipPlan.findAll({
            where: { status: 'ACTIVE', isPublic: true },
            attributes: ['price', 'branchId', 'isFeatured'],
            raw: true,
          })
        ]);

        for (const b of branches) {
          const listing = b.gymListingId ? listingMap.get(b.gymListingId) : null;
          const gym = gymMap.get(b.gymId) || gyms[0];

          // Compute branch-specific minPrice dynamically based on public plans
          const branchPlans = plans.filter(p => p.branchId === null || p.branchId === b.id);
          const featuredPlan = branchPlans.find(p => p.isFeatured);
          let minPrice = 0;
          if (featuredPlan) {
            minPrice = parseFloat(featuredPlan.price);
          } else if (branchPlans.length > 0) {
            minPrice = Math.min(...branchPlans.map(p => parseFloat(p.price)));
          }

          // Map to unified branch object
          const mappedBranch = {
            id: b.id, // primary unit is branch id!
            tenantId: tenant.id,
            branchId: b.id,
            gymId: gym.id,
            cityId: b.cityId || (listing ? listing.cityId : null),
            areaId: b.areaId || (listing ? listing.areaId : null),
            title: `${gym.name} - ${b.branchName}`,
            shortDescription: gym.description || b.tagline,
            logoUrl: gym.logoUrl,
            coverImageUrl: (b.imagesJson && b.imagesJson.length > 0) ? b.imagesJson[0] : gym.coverImageUrl,
            genderType: gym.genderType,
            averageRating: ratingMap.get(b.id) || 0,
            latitude: b.latitude ? parseFloat(b.latitude) : null,
            longitude: b.longitude ? parseFloat(b.longitude) : null,
            isFeatured: listing ? listing.isFeatured : false,
            contactPhone: b.phone || gym.contactPhone,
            website: gym.website,
            facilitiesJson: b.facilitiesJson || [],
            imagesJson: b.imagesJson || [],
            category: b.category || gym.category || listing?.category || 'General',
            minPrice,
            gymListingId: b.gymListingId || null,
            status: 'ACTIVE',
            createdAt: b.createdAt,
            city: listing ? listing.city : null,
            area: listing ? listing.area : null,
          };
          branchesList.push(mappedBranch);
        }
      } catch (err) {
        // Ignore errors for individual tenants
      }
    })
  );

  return branchesList;
};

const filterBranches = (branches, {
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
}) => {
  let filtered = [...branches];

  if (cityId) filtered = filtered.filter(b => b.cityId === parseInt(cityId));
  if (areaId) filtered = filtered.filter(b => b.areaId === parseInt(areaId));
  if (genderType) filtered = filtered.filter(b => b.genderType?.toLowerCase() === genderType.toLowerCase());
  if (featured === 'true' || featured === true) filtered = filtered.filter(b => b.isFeatured === true);
  if (category && category !== 'All') {
    const cats = typeof category === 'string' && category.includes(',')
      ? category.split(',').map((c) => c.trim().toLowerCase())
      : [category.toLowerCase()];
    filtered = filtered.filter(b => cats.includes(b.category?.toLowerCase()));
  }
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(b => b.title?.toLowerCase().includes(s));
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

  return { gyms: paginated, branches: paginated, pagination: buildPagination(sorted.length, page, limit) };
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

  let branchRecord = null;
  if (!listing) {
    // It might be a branchId. Let's find the branch in tenant databases.
    const tenants = await Tenant.findAll({
      where: { status: 'ACTIVE' },
      attributes: ['id', 'connectionStringEncrypted'],
    });

    for (const tenant of tenants) {
      try {
        if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
        const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
        const { Branch } = tenantDb.models;
        const branch = await Branch.findByPk(id);
        if (branch) {
          branchRecord = branch;
          if (branch.gymListingId) {
            listing = await GymListing.findByPk(branch.gymListingId, {
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
          }
          break;
        }
      } catch (err) {
        // Ignore
      }
    }
  }

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
      const { MembershipPlan, Branch, Gym } = tenantDb.models;

      let gymIdToUse = null;
      let resolvedBranch = branchRecord || null;
      if (branchRecord) {
        gymIdToUse = branchRecord.gymId;
      } else if (listing && listing.branchId) {
        const primaryBranch = await Branch.findByPk(listing.branchId);
        if (primaryBranch) {
          gymIdToUse = primaryBranch.gymId;
          resolvedBranch = primaryBranch;
        }
      }

      if (!gymIdToUse) {
        const fallbackBranch = await Branch.findOne({ where: { status: 'ACTIVE' } });
        if (fallbackBranch) {
          gymIdToUse = fallbackBranch.gymId;
          resolvedBranch = fallbackBranch;
        }
      }

      branchRecord = resolvedBranch;

      const gym = gymIdToUse
        ? await Gym.findByPk(gymIdToUse)
        : await Gym.findOne();

      [membershipPlans, branches] = await Promise.all([
        MembershipPlan.findAll({
          where: { status: 'ACTIVE', isPublic: true },
          attributes: ['id', 'name', 'description', 'durationType', 'durationValue', 'price', 'joiningFee', 'securityFee', 'isTrial', 'branchId', 'freezeLimitDays', 'visitLimit', 'isFeatured'],
          order: [['price', 'ASC']],
        }),
        Branch.findAll({
          where: {
            status: 'ACTIVE',
            travelerVisibilityStatus: 'active',
            ...(gymIdToUse ? { gymId: gymIdToUse } : {}),
          },
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

      // If we found by branchRecord, let's override title and other branch specific fields in the listing
      if (branchRecord && gym) {
        listing = listing.get({ plain: true });
        listing.id = branchRecord.id; // Override gymListingId with branchId so client matches
        listing.title = `${gym.name} - ${branchRecord.branchName}`;
        listing.shortDescription = gym.description || branchRecord.tagline;
        listing.coverImageUrl = (branchRecord.imagesJson && branchRecord.imagesJson.length > 0) ? branchRecord.imagesJson[0] : gym.coverImageUrl;
        listing.latitude = branchRecord.latitude ? parseFloat(branchRecord.latitude) : listing.latitude;
        listing.longitude = branchRecord.longitude ? parseFloat(branchRecord.longitude) : listing.longitude;
        listing.contactPhone = branchRecord.phone || gym.contactPhone;
        listing.facilitiesJson = branchRecord.facilitiesJson || listing.facilitiesJson;
        listing.imagesJson = branchRecord.imagesJson || listing.imagesJson;

        // Fetch branch-specific average rating
        const branchReviewStats = await GymReview.findOne({
          attributes: [[fn('AVG', col('rating')), 'avg']],
          where: { branchId: branchRecord.id, status: 'APPROVED' },
          raw: true,
        });
        listing.averageRating = branchReviewStats && branchReviewStats.avg ? parseFloat(parseFloat(branchReviewStats.avg).toFixed(2)) : 0;

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
    }
  } catch (error) {
    console.error('Error fetching tenant details in getGym:', error);
    membershipPlans = [];
    branches = [];
  }

  const normalizedGym = _normalizeFacilities(listing);
  return { gym: { ...normalizedGym, branches }, membershipPlans };
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
    attributes: ['id', 'name'],
  });

  return cities.map(c => {
    const plain = c.get({ plain: true });
    plain.gymCount = cityCounts[c.id] || 0;
    return plain;
  }).sort((a, b) => b.gymCount - a.gymCount);
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
const nearbyGyms = async ({ lat, lng, radiusKm = 10, limit = 20, page = 1 }) => {
  const branches = await _getAllActiveBranches();
  const uLat = parseFloat(lat);
  const uLng = parseFloat(lng);

  const inRange = [];
  for (const b of branches) {
    if (b.latitude == null || b.longitude == null) continue;
    const dist = haversineKm(uLat, uLng, b.latitude, b.longitude);
    if (dist <= radiusKm) {
      b.distanceKm = Math.round(dist * 10) / 10;
      inRange.push(b);
    }
  }

  const sorted = inRange.sort((a, b) => a.distanceKm - b.distanceKm);
  const offset = (page - 1) * limit;
  const paginated = sorted.slice(offset, offset + parseInt(limit));

  return { gyms: paginated, branches: paginated };
};

// ── mapGyms ───────────────────────────────────────────────────────────────────
const mapGyms = async ({ cityId } = {}) => {
  const branches = await _getAllActiveBranches();
  let filtered = branches.filter(b => b.latitude != null && b.longitude != null);
  if (cityId) {
    filtered = filtered.filter(b => b.cityId === parseInt(cityId));
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
  let filtered = branches;
  if (cityId) {
    filtered = filtered.filter(b => b.cityId === parseInt(cityId));
  }
  const sorted = filtered.sort((a, b) => b.averageRating - a.averageRating);
  return sorted.slice(0, parseInt(limit));
};

// ── listOrganizations ─────────────────────────────────────────────────────────
const listOrganizations = async ({ featured, page = 1, limit = 12 }) => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  const listings = await GymListing.findAll({
    where: { status: 'ACTIVE' },
  });
  const listingMap = new Map(listings.map(l => [l.id, l]));

  const orgs = [];

  for (const tenant of tenants) {
    try {
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Gym, Branch } = tenantDb.models;
      const gyms = await Gym.findAll();
      if (gyms.length === 0) continue;

      const otherGymIds = gyms.slice(1).map(g => g.id);

      for (const gym of gyms) {
        const isPrimaryGym = gym.id === gyms[0].id;
        const visibleBranches = await Branch.findAll({
          where: {
            status: 'ACTIVE',
            travelerVisibilityStatus: 'active',
            ...(isPrimaryGym
              ? {
                  [Op.or]: [
                    { gymId: gym.id },
                    { gymId: null },
                    { gymId: '' },
                    ...(otherGymIds.length > 0 ? [{ gymId: { [Op.notIn]: otherGymIds } }] : [])
                  ]
                }
              : { gymId: gym.id }
            )
          },
        });

        if (visibleBranches.length === 0) continue;

        // Calculate aggregate stats
        let totalRating = 0;
        let ratedBranchesCount = 0;
        for (const b of visibleBranches) {
          const listing = b.gymListingId ? listingMap.get(b.gymListingId) : null;
          if (listing) {
            totalRating += parseFloat(listing.averageRating || 0);
            ratedBranchesCount++;
          }
        }
        const avgRating = ratedBranchesCount > 0 ? (totalRating / ratedBranchesCount) : 0.0;

        orgs.push({
          id: gym.id,
          gymId: gym.id,
          tenantId: tenant.id,
          name: gym.name,
          description: gym.description,
          logoUrl: gym.logoUrl,
          coverImageUrl: gym.coverImageUrl,
          branchCount: visibleBranches.length,
          averageRating: Math.round(avgRating * 10) / 10,
          tagline: gym.description ? gym.description.slice(0, 60) : 'Premium Gym Network',
        });
      }
    } catch (err) {
      console.error(`[listOrganizations] Error processing tenant ${tenant.id}:`, err);
    }
  }

  // Paginate orgs
  const offset = (page - 1) * limit;
  const paginated = orgs.slice(offset, offset + parseInt(limit));

  return {
    organizations: paginated,
    pagination: buildPagination(orgs.length, page, limit),
  };
};

// ── listOrganizationBranches ──────────────────────────────────────────────────
const listOrganizationBranches = async (gymId) => {
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  const listings = await GymListing.findAll({
    where: { status: 'ACTIVE' },
    include: [
      { model: City, as: 'city', attributes: ['id', 'name'] },
      { model: Area, as: 'area', attributes: ['id', 'name'] },
    ]
  });
  const listingMap = new Map(listings.map(l => [l.id, l]));

  // Load branch-level average ratings from platform reviews
  const reviewStats = await GymReview.findAll({
    attributes: [
      'branchId',
      [fn('AVG', col('rating')), 'avgRating'],
    ],
    where: { status: 'APPROVED', branchId: { [Op.ne]: null } },
    group: ['branchId'],
    raw: true,
  });
  const ratingMap = new Map(
    reviewStats.map((r) => [r.branchId, parseFloat(parseFloat(r.avgRating || 0).toFixed(2))])
  );

  for (const tenant of tenants) {
    try {
      if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
      const tenantDb = await TenantDbManager.getConnection(tenant.id, tenant.connectionStringEncrypted);
      const { Branch, Gym, MembershipPlan } = tenantDb.models;

      const gyms = await Gym.findAll();
      const gym = gyms.find(g => g.id === gymId);
      if (!gym) continue;

      const otherGymIds = gyms.filter(g => g.id !== gym.id).map(g => g.id);
      const isPrimaryGym = gym.id === gyms[0].id;
      const [branches, plans] = await Promise.all([
        Branch.findAll({
          where: {
            status: 'ACTIVE',
            travelerVisibilityStatus: 'active',
            ...(isPrimaryGym
              ? {
                  [Op.or]: [
                    { gymId: gym.id },
                    { gymId: null },
                    { gymId: '' },
                    ...(otherGymIds.length > 0 ? [{ gymId: { [Op.notIn]: otherGymIds } }] : [])
                  ]
                }
              : { gymId: gym.id }
            )
          },
        }),
        MembershipPlan.findAll({
          where: { status: 'ACTIVE', isPublic: true },
          attributes: ['price', 'branchId', 'isFeatured'],
          raw: true,
        })
      ]);

      const mappedBranches = branches.map(b => {
        const listing = b.gymListingId ? listingMap.get(b.gymListingId) : null;

        // Compute branch-specific minPrice dynamically based on public plans
        const branchPlans = plans.filter(p => p.branchId === null || p.branchId === b.id);
        const featuredPlan = branchPlans.find(p => p.isFeatured);
        let minPrice = 0;
        if (featuredPlan) {
          minPrice = parseFloat(featuredPlan.price);
        } else if (branchPlans.length > 0) {
          minPrice = Math.min(...branchPlans.map(p => parseFloat(p.price)));
        }

        return {
          id: b.id,
          tenantId: tenant.id,
          branchId: b.id,
          gymId: gym.id,
          cityId: b.cityId || (listing ? listing.cityId : null),
          areaId: b.areaId || (listing ? listing.areaId : null),
          title: `${gym.name} - ${b.branchName}`,
          shortDescription: gym.description || b.tagline,
          logoUrl: gym.logoUrl,
          coverImageUrl: (b.imagesJson && b.imagesJson.length > 0) ? b.imagesJson[0] : gym.coverImageUrl,
          genderType: gym.genderType,
          averageRating: ratingMap.get(b.id) || 0,
          latitude: b.latitude ? parseFloat(b.latitude) : null,
          longitude: b.longitude ? parseFloat(b.longitude) : null,
          isFeatured: listing ? listing.isFeatured : false,
          contactPhone: b.phone || gym.contactPhone,
          website: gym.website,
          facilitiesJson: b.facilitiesJson || [],
          imagesJson: b.imagesJson || [],
          category: b.category || gym.category || listing?.category || 'General',
          minPrice,
          status: 'ACTIVE',
          createdAt: b.createdAt,
          city: listing ? listing.city : null,
          area: listing ? listing.area : null,
        };
      });

      return { gyms: mappedBranches, branches: mappedBranches };
    } catch (err) {
      // Ignore
    }
  }

  throw createError('Organization not found', 404);
};

// ── getGymListingByIdentifier (helper) ────────────────────────────────────────
const getGymListingByIdentifier = async (identifier) => {
  // 1. Direct platform listing lookup
  let listing = await GymListing.findByPk(identifier);
  if (listing) return listing;

  // 2. Branch ID → gymListingId lookup
  const branches = await _getAllActiveBranches();
  const matched = branches.find(b => b.id === identifier || b.branchId === identifier);
  if (matched && matched.gymListingId) {
    listing = await GymListing.findByPk(matched.gymListingId);
    if (listing) return listing;
  }

  // 3. If no listing found but branch exists, return a synthetic listing-like object
  //    so reviews summary/list don't 404 (they'll just return empty data)
  if (matched) {
    return {
      id: matched.gymListingId || matched.id,
      tenantId: matched.tenantId,
      title: matched.title,
      averageRating: matched.averageRating || 0,
      _isSynthetic: true,
    };
  }

  return null;
};

// ── _recalculateAverageRating (helper) ────────────────────────────────────────
// Recalculates averageRating on GymListing based on all approved reviews for that branch.
const _recalculateAverageRating = async (gymListingId, branchId) => {
  const where = { gymListingId, status: 'APPROVED' };
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
    { where: { id: gymListingId } }
  );
};

// ── getReviewsSummary ─────────────────────────────────────────────────────────
/**
 * Branch-level review summary.
 * branchId is required to scope reviews to a specific branch.
 * If no GymListing is found (synthetic), we still return the branch-scoped summary.
 */
const getReviewsSummary = async (gymListingId, branchId) => {
  const where = { status: 'APPROVED' };
  if (branchId) {
    where.branchId = branchId;
  } else if (gymListingId) {
    where.gymListingId = gymListingId;
  }

  // Try to get stored average from listing for display
  const listing = await GymListing.findByPk(gymListingId).catch(() => null);
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

  const preview = await GymReview.findOne({
    where,
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

const submitReview = async (userId, gymListingId, branchId, { rating, title, body }) => {
  if (!branchId) throw createError('branchId is required to submit a review', 400);

  // Find the tenantId of this branch
  const branches = await _getAllActiveBranches();
  const matched = branches.find(b => b.id === branchId || b.branchId === branchId);
  if (!matched) throw createError('Branch not found', 404);

  const tenantId = matched.tenantId;

  // Retrieve the tenant DB connection to query its source-of-truth subscriptions table
  const tenant = await Tenant.findOne({
    where: { id: tenantId, status: 'ACTIVE' },
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

  // Verify that the user has a subscription to this specific branch
  const subscription = await MemberSubscription.findOne({
    where: { userId, branchId },
  });
  if (!subscription) {
    throw createError('You must be a member of this specific branch to leave a review', 403);
  }

  // One review per user per branch
  const existing = await GymReview.findOne({ where: { userId, branchId } });
  if (existing) {
    await existing.update({
      rating,
      title: title || null,
      body: body || null,
      status: 'APPROVED',
      adminNote: null,
    });
    await _recalculateAverageRating(gymListingId, branchId);
    return existing;
  }

  const review = await GymReview.create({
    gymListingId: gymListingId || null,
    branchId,
    userId,
    tenantId,
    rating,
    title: title || null,
    body: body || null,
    status: 'APPROVED',
  });

  await _recalculateAverageRating(gymListingId, branchId);
  return review;
};

// ── listReviews (public) ──────────────────────────────────────────────────────
/**
 * Branch-scoped review listing.
 * If branchId is provided, only returns reviews for that specific branch.
 */
const listReviews = async (gymListingId, branchId, { page, limit, offset, sort = 'recent', filter = 'all' }) => {
  const where = { status: 'APPROVED' };

  // Scope to branch if provided, else fall back to listing-level
  if (branchId) {
    where.branchId = branchId;
  } else if (gymListingId) {
    where.gymListingId = gymListingId;
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
const adminListReviews = async ({ gymListingId, status, page, limit, offset }) => {
  const where = {};
  if (gymListingId) where.gymListingId = gymListingId;
  if (status) where.status = status;

  const { count, rows } = await GymReview.findAndCountAll({
    where,
    include: [
      { model: User, as: 'reviewer', attributes: ['id', 'fullName', 'email'] },
      { model: GymListing, as: 'gym', attributes: ['id', 'title'] },
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

  await _recalculateAverageRating(review.gymListingId);

  return review;
};


const _resolveTenantId = async (id) => {
  const listing = await GymListing.findByPk(id, { attributes: ['tenantId'] });
  if (listing) return listing.tenantId;

  // Search by branch ID
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    attributes: ['id', 'connectionStringEncrypted'],
  });

  for (const tenant of tenants) {
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

const getPaymentDetails = async (gymListingId) => {
  const tenantId = await _resolveTenantId(gymListingId);
  if (!tenantId) throw createError('Gym not found', 404);

  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['paymentDetailsJson'],
  });

  return {
    paymentDetails: tenant ? tenant.paymentDetailsJson : null,
  };
};

const listTopHosts = async () => {
  const branches = await _getAllActiveBranches();

  // Group branches by tenantId
  const tenantBranchesMap = {};
  for (const b of branches) {
    if (!tenantBranchesMap[b.tenantId]) {
      tenantBranchesMap[b.tenantId] = [];
    }
    tenantBranchesMap[b.tenantId].push(b);
  }

  // Get active tenants with owners
  const tenants = await Tenant.findAll({
    where: { status: 'ACTIVE' },
    include: [
      {
        model: User,
        as: 'owner',
        attributes: ['id', 'fullName', 'profileImageUrl'],
      },
    ],
  });

  // Fetch approved review stats for tenants
  const reviewStats = await GymReview.findAll({
    attributes: [
      'tenantId',
      [fn('AVG', col('rating')), 'avgRating'],
    ],
    where: { status: 'APPROVED' },
    group: ['tenantId'],
    raw: true,
  });

  const ratingMap = new Map(
    reviewStats.map((r) => [r.tenantId, parseFloat(parseFloat(r.avgRating || 0).toFixed(2))])
  );

  const topHosts = tenants
    .map((tenant) => {
      const tenantBranches = tenantBranchesMap[tenant.id] || [];
      const averageRating = ratingMap.get(tenant.id) || 0.0;

      // Use first branch cover or owner avatar as fallback
      const coverImageUrl = tenantBranches.length > 0 ? tenantBranches[0].coverImageUrl : null;
      const logoUrl = tenant.owner ? tenant.owner.profileImageUrl : null;

      return {
        id: tenant.id,
        tenantId: tenant.id,
        businessName: tenant.businessName,
        ownerName: tenant.owner ? tenant.owner.fullName : 'Premium Host',
        logoUrl,
        coverImageUrl,
        averageRating,
        branchesCount: tenantBranches.length,
        branches: tenantBranches,
      };
    })
    .filter((host) => host.branchesCount > 0) // Only hosts with active branches
    .sort((a, b) => b.averageRating - a.averageRating); // Sort by average rating descending

  return topHosts;
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
  getReviewsSummary,
  getGymListingByIdentifier,
  listTopHosts,
  listOrganizations,
  listOrganizationBranches,
};
