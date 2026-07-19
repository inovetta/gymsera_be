require('dotenv').config();
const { Tenant, GymListing, City, Area } = require('./src/models/platform');
const registerTenantModels = require('./src/models/tenant');
const TenantDbManager = require('./src/database/TenantDbManager');
const { decrypt } = require('./src/utils/crypto.utils');
const { Sequelize } = require('sequelize');

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

  const listingMap = new Map(listings.map(l => [l.id, l]));
  const branchesList = [];

  for (const tenant of tenants) {
    if (!tenant.connectionStringEncrypted || tenant.connectionStringEncrypted === 'PENDING_PROVISIONING') continue;
    const connUrl = decrypt(tenant.connectionStringEncrypted);
    const tenantSeq = new Sequelize(connUrl, {
      dialect: 'mysql',
      logging: false,
    });
    try {
      await tenantSeq.authenticate();
      const models = registerTenantModels(tenantSeq);
      const { Branch, Gym } = models;

      const gym = await Gym.findOne();
      if (!gym) continue;

      const branches = await Branch.findAll({
        where: { status: 'ACTIVE', travelerVisibilityStatus: 'active' },
      });

      for (const b of branches) {
        const listing = b.gymListingId ? listingMap.get(b.gymListingId) : null;
        
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
          averageRating: listing ? parseFloat(listing.averageRating || 0) : 0,
          latitude: b.latitude ? parseFloat(b.latitude) : null,
          longitude: b.longitude ? parseFloat(b.longitude) : null,
          isFeatured: listing ? listing.isFeatured : false,
          contactPhone: b.phone || gym.contactPhone,
          website: gym.website,
          facilitiesJson: b.facilitiesJson || [],
          imagesJson: b.imagesJson || [],
          category: b.category || gym.category || listing?.category || 'General',
          minPrice: listing ? parseFloat(listing.minPrice || 0) : 0,
          status: 'ACTIVE',
          createdAt: b.createdAt,
          city: listing ? listing.city : null,
          area: listing ? listing.area : null,
        };
        branchesList.push(mappedBranch);
      }
    } catch (err) {
      console.error(`Error on tenant ${tenant.tenantCode}: ${err.message}`);
    } finally {
      await tenantSeq.close();
    }
  }

  return branchesList;
};

async function main() {
  const branches = await _getAllActiveBranches();
  console.log(`Total active branches loaded: ${branches.length}`);

  const cityId = 10;
  console.log(`\nFiltering by cityId = ${cityId}:`);

  for (const b of branches) {
    const matchCity = b.cityId === parseInt(cityId);
    console.log(`Branch: ${b.title} (ID: ${b.id})`);
    console.log(`  - b.cityId: ${b.cityId} (type: ${typeof b.cityId})`);
    console.log(`  - matchCity: ${matchCity}`);
  }
}

main().catch(console.error);
