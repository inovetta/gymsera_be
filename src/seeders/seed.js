/**
 * GymsEra — Full Platform Seeder
 *
 * Seeds:
 *   1. Cities + Areas
 *   2. Platform packages (Starter / Professional / Enterprise)
 *   3. Platform admin user + 3 gym-host users + 5 member users
 *   4. Tenants (2 approved gyms) with full GymListing (lat/long, featured, rating)
 *   5. UserGymMembership cross-reference records (members linked to gyms)
 *   6. GymReviews (approved) so discovery endpoints return real data
 *
 * Run with: node src/seeders/seed.js
 * Safe to run multiple times — uses findOrCreate / upsert where possible.
 *
 * ⚠️  Tenant DB seeding (plans, branches, subscriptions, payments) is done
 *     via a separate script per tenant because each has its own DB.
 *     See: node src/seeders/seed-tenant.js <tenantCode>
 */
require('dotenv').config();

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { connect } = require('../database/platform');
const {
  City, Area, PlatformPackage,
  User, Tenant, GymListing, TenantSubscription,
  UserGymMembership, GymReview,
} = require('../models/platform');

// ─────────────────────────────────────────────────────────────────────────────
// 1. CITIES + AREAS
// ─────────────────────────────────────────────────────────────────────────────

const CITIES = [
  {
    name: 'Karachi',
    areas: ['Clifton', 'DHA', 'Gulshan-e-Iqbal', 'North Nazimabad', 'Korangi', 'Saddar', 'Malir', 'Lyari'],
  },
  {
    name: 'Lahore',
    areas: ['DHA', 'Gulberg', 'Model Town', 'Johar Town', 'Bahria Town', 'Wapda Town', 'Cantt', 'Iqbal Town'],
  },
  {
    name: 'Islamabad',
    areas: ['F-6', 'F-7', 'F-8', 'F-10', 'G-9', 'G-10', 'G-11', 'Blue Area', 'Bahria Town'],
  },
  {
    name: 'Rawalpindi',
    areas: ['Saddar', 'Bahria Town', 'DHA', 'Gulshanabad', 'Chaklala Scheme'],
  },
  {
    name: 'Faisalabad',
    areas: ['Peoples Colony', 'Madina Town', 'Jinnah Colony', 'Gulshan-e-Iqbal'],
  },
  {
    name: 'Multan',
    areas: ['Gulgasht Colony', 'New Multan', 'Cantt', 'Qasim Bela'],
  },
  {
    name: 'Peshawar',
    areas: ['Hayatabad', 'University Town', 'Saddar', 'Cantt'],
  },
  {
    name: 'Quetta',
    areas: ['Satellite Town', 'Cantt', 'Jinnah Road'],
  },
  {
    name: 'Sialkot',
    areas: ['Cantt', 'Paris Road', 'Iqbal Town'],
  },
  {
    name: 'Gujranwala',
    areas: ['Model Town', 'Gulshan Colony', 'Satellite Town'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. PACKAGES
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGES = [
  {
    name: 'Starter',
    description: 'Perfect for a single-branch gym just getting started. Core membership and attendance management.',
    price: 4999.00,
    billingCycle: 'MONTHLY',
    maxBranches: 1,
    maxTrainers: 5,
    maxMembers: 150,
    featureFlagsJson: {
      attendance: true, memberships: true, payments: true, trainers: false,
      advancedReports: false, qrCheckin: true, smsNotifications: false,
    },
    status: 'ACTIVE',
  },
  {
    name: 'Professional',
    description: 'For growing gyms. Multi-branch support, trainer management, and advanced analytics.',
    price: 9999.00,
    billingCycle: 'MONTHLY',
    maxBranches: 3,
    maxTrainers: 20,
    maxMembers: 500,
    featureFlagsJson: {
      attendance: true, memberships: true, payments: true, trainers: true,
      advancedReports: true, qrCheckin: true, smsNotifications: true,
    },
    status: 'ACTIVE',
  },
  {
    name: 'Enterprise',
    description: 'For large gym chains. Unlimited branches, full feature set, priority support.',
    price: 24999.00,
    billingCycle: 'MONTHLY',
    maxBranches: 10,
    maxTrainers: 100,
    maxMembers: 5000,
    featureFlagsJson: {
      attendance: true, memberships: true, payments: true, trainers: true,
      advancedReports: true, qrCheckin: true, smsNotifications: true,
      prioritySupport: true, customBranding: true, apiAccess: true,
    },
    status: 'ACTIVE',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. USERS
// ─────────────────────────────────────────────────────────────────────────────

const SEED_USERS = [
  // Platform admin
  {
    _key: 'admin',
    fullName: 'GymsEra Admin',
    email: 'admin@gymsera.com',
    password: 'Admin@1234!',
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    isVerified: true,
  },
  // Gym hosts (own tenants)
  {
    _key: 'host1',
    fullName: 'Ahmed Khan',
    email: 'ahmed@ironpeak.com',
    password: 'Host@1234!',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
  },
  {
    _key: 'host2',
    fullName: 'Sara Malik',
    email: 'sara@vitalityfit.com',
    password: 'Host@1234!',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
  },
  // Members
  {
    _key: 'member1',
    fullName: 'Ali Hassan',
    email: 'ali.hassan@example.com',
    password: 'Member@1234!',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
  },
  {
    _key: 'member2',
    fullName: 'Fatima Zahra',
    email: 'fatima.z@example.com',
    password: 'Member@1234!',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
  },
  {
    _key: 'member3',
    fullName: 'Omar Farooq',
    email: 'omar.farooq@example.com',
    password: 'Member@1234!',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
  },
  {
    _key: 'member4',
    fullName: 'Ayesha Noor',
    email: 'ayesha.noor@example.com',
    password: 'Member@1234!',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
  },
  {
    _key: 'member5',
    fullName: 'Bilal Chaudhry',
    email: 'bilal.c@example.com',
    password: 'Member@1234!',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Seed functions
// ─────────────────────────────────────────────────────────────────────────────

async function seedCities() {
  let createdCities = 0;
  let createdAreas  = 0;

  for (const cityData of CITIES) {
    const [city, cityCreated] = await City.findOrCreate({
      where:    { name: cityData.name },
      defaults: { name: cityData.name, isActive: true },
    });
    if (cityCreated) createdCities++;

    for (const areaName of cityData.areas) {
      const [, areaCreated] = await Area.findOrCreate({
        where:    { cityId: city.id, name: areaName },
        defaults: { cityId: city.id, name: areaName },
      });
      if (areaCreated) createdAreas++;
    }
  }

  console.log(`  Cities: ${createdCities} created (${CITIES.length} total processed)`);
  console.log(`  Areas:  ${createdAreas} created`);
}

async function seedPackages() {
  let created = 0;

  for (const pkgData of PACKAGES) {
    const [, wasCreated] = await PlatformPackage.findOrCreate({
      where:    { name: pkgData.name },
      defaults: pkgData,
    });
    if (wasCreated) created++;
  }

  console.log(`  Packages: ${created} created (${PACKAGES.length} total processed)`);
}

async function seedUsers() {
  const userMap = {};
  let created = 0;

  for (const u of SEED_USERS) {
    const existing = await User.findOne({ where: { email: u.email } });
    if (existing) {
      userMap[u._key] = existing;
      continue;
    }

    const passwordHash = await bcrypt.hash(u.password, 12);
    const user = await User.create({
      fullName: u.fullName,
      email:    u.email,
      passwordHash,
      role:       u.role,
      status:     u.status,
      isVerified: u.isVerified,
    });
    userMap[u._key] = user;
    created++;
  }

  console.log(`  Users: ${created} created (${SEED_USERS.length} total processed)`);
  return userMap;
}

async function seedTenantsAndListings(userMap) {
  // Look up city IDs
  const karachi   = await City.findOne({ where: { name: 'Karachi' } });
  const lahore    = await City.findOne({ where: { name: 'Lahore' } });
  const islamabad = await City.findOne({ where: { name: 'Islamabad' } });

  const karachiDha    = await Area.findOne({ where: { cityId: karachi.id,   name: 'DHA' } });
  const karachiClifton= await Area.findOne({ where: { cityId: karachi.id,   name: 'Clifton' } });
  const lahoreDha     = await Area.findOne({ where: { cityId: lahore.id,    name: 'DHA' } });
  const islamabadF8   = await Area.findOne({ where: { cityId: islamabad.id, name: 'F-8' } });

  const proPackage = await PlatformPackage.findOne({ where: { name: 'Professional' } });

  // ── Tenant 1: Iron Peak Fitness (Karachi, DHA) ──────────────────────────────
  const [tenant1, t1Created] = await Tenant.findOrCreate({
    where: { tenantCode: 'IRONPEAK' },
    defaults: {
      tenantCode:      'IRONPEAK',
      businessName:    'Iron Peak Fitness Pvt Ltd',
      ownerUserId:     userMap.host1.id,
      email:           'ahmed@ironpeak.com',
      phone:           '+923001234567',
      cityId:          karachi.id,
      address:         'Plot 12, DHA Phase 5, Karachi',
      gymName:         'Iron Peak Fitness',
      gymDescription:  'State-of-the-art gym with Olympic lifting platforms, powerlifting racks, and dedicated cardio zone. Certified trainers, nutrition counseling, and group fitness classes.',
      genderType:      'MIXED',
      status:          'ACTIVE',
      kycStatus:       'APPROVED',
      approvedAt:      new Date('2024-01-15'),
      // NOTE: connectionStringEncrypted would be set by the provisioning job.
      // For seeding purposes we store a placeholder — real DB provisioning
      // must run before tenant endpoints work.
      connectionStringEncrypted: 'PENDING_PROVISIONING',
    },
  });

  // ── Tenant 2: Vitality Fit Studio (Lahore, DHA) ─────────────────────────────
  const [tenant2, t2Created] = await Tenant.findOrCreate({
    where: { tenantCode: 'VITALITYFIT' },
    defaults: {
      tenantCode:      'VITALITYFIT',
      businessName:    'Vitality Fit Studio LLC',
      ownerUserId:     userMap.host2.id,
      email:           'sara@vitalityfit.com',
      phone:           '+923211234567',
      cityId:          lahore.id,
      address:         'Block D, DHA Phase 6, Lahore',
      gymName:         'Vitality Fit Studio',
      gymDescription:  'Premium ladies-only fitness studio with Pilates, Zumba, aerial yoga, and personalized coaching. Transforming lives through holistic wellness.',
      genderType:      'FEMALE_ONLY',
      status:          'ACTIVE',
      kycStatus:       'APPROVED',
      approvedAt:      new Date('2024-02-10'),
      connectionStringEncrypted: 'PENDING_PROVISIONING',
    },
  });

  console.log(`  Tenants: Iron Peak ${t1Created ? 'created' : 'exists'}, Vitality Fit ${t2Created ? 'created' : 'exists'}`);

  // ── Tenant subscriptions to platform package ─────────────────────────────────
  for (const [tenant] of [[tenant1], [tenant2]]) {
    await TenantSubscription.findOrCreate({
      where: { tenantId: tenant.id },
      defaults: {
        tenantId:          tenant.id,
        platformPackageId: proPackage.id,
        status:            'ACTIVE',
        startDate:         '2024-01-01',
        endDate:           '2025-12-31',
        amount:            proPackage.price,
        billingCycle:      proPackage.billingCycle,
        paymentStatus:     'PAID',
        autoRenew:         true,
      },
    });
  }

  // ── GymListings (the public-facing directory entries) ────────────────────────

  const gymListings = [
    {
      tenantId:         tenant1.id,
      cityId:           karachi.id,
      areaId:           karachiDha.id,
      title:            'Iron Peak Fitness — DHA Karachi',
      shortDescription: 'Karachi\'s premier powerlifting & bodybuilding gym. Olympic platforms, full cardio suite, protein bar.',
      genderType:       'MIXED',
      averageRating:    4.7,
      latitude:         24.80413,
      longitude:        67.07230,
      isFeatured:       true,
      contactPhone:     '+923001234567',
      website:          'https://ironpeak.com',
      facilitiesJson: {
        parking: true, wifi: true, locker: true, shower: true,
        sauna: false, pool: false, cafe: true, personalTraining: true,
      },
      status: 'ACTIVE',
    },
    {
      tenantId:         tenant1.id,
      cityId:           karachi.id,
      areaId:           karachiClifton.id,
      title:            'Iron Peak Fitness — Clifton Karachi',
      shortDescription: 'Iron Peak\'s second Karachi branch in Clifton. Full weights room + group classes.',
      genderType:       'MIXED',
      averageRating:    4.5,
      latitude:         24.81068,
      longitude:        67.02754,
      isFeatured:       false,
      contactPhone:     '+923001234568',
      website:          'https://ironpeak.com',
      facilitiesJson: {
        parking: true, wifi: true, locker: true, shower: true,
        sauna: false, pool: false, cafe: false, personalTraining: true,
      },
      status: 'ACTIVE',
    },
    {
      tenantId:         tenant2.id,
      cityId:           lahore.id,
      areaId:           lahoreDha.id,
      title:            'Vitality Fit Studio — DHA Lahore',
      shortDescription: 'Ladies-only wellness studio: Pilates, Zumba, aerial yoga & personal coaching.',
      genderType:       'FEMALE_ONLY',
      averageRating:    4.9,
      latitude:         31.47715,
      longitude:        74.40395,
      isFeatured:       true,
      contactPhone:     '+923211234567',
      website:          'https://vitalityfit.com',
      facilitiesJson: {
        parking: true, wifi: true, locker: true, shower: true,
        sauna: true, pool: false, cafe: true, personalTraining: true,
        yoga: true, pilates: true, zumba: true,
      },
      status: 'ACTIVE',
    },
    // Additional inactive listing for filter testing
    {
      tenantId:         tenant1.id,
      cityId:           islamabad.id,
      areaId:           islamabadF8.id,
      title:            'Iron Peak Fitness — F-8 Islamabad (Coming Soon)',
      shortDescription: 'Iron Peak expanding to Islamabad. Pre-registration open.',
      genderType:       'MIXED',
      averageRating:    0,
      latitude:         33.70756,
      longitude:        73.04941,
      isFeatured:       false,
      contactPhone:     '+923001234569',
      website:          'https://ironpeak.com',
      facilitiesJson: {},
      status: 'PENDING',
    },
  ];

  const listingMap = {};
  let listingsCreated = 0;

  for (const listingData of gymListings) {
    const [listing, wasCreated] = await GymListing.findOrCreate({
      where: { title: listingData.title, tenantId: listingData.tenantId },
      defaults: listingData,
    });
    listingMap[listing.title] = listing;
    if (wasCreated) listingsCreated++;
  }

  console.log(`  GymListings: ${listingsCreated} created (${gymListings.length} total processed)`);
  return { tenant1, tenant2, listingMap };
}

async function seedUserGymMemberships(userMap, listingMap, tenant1, tenant2) {
  const ironPeakDha   = listingMap['Iron Peak Fitness — DHA Karachi'];
  const ironPeakClifton = listingMap['Iron Peak Fitness — Clifton Karachi'];
  const vitalityDha   = listingMap['Vitality Fit Studio — DHA Lahore'];

  const memberships = [
    {
      userId:         userMap.member1.id,
      tenantId:       tenant1.id,
      gymListingId:   ironPeakDha.id,
      subscriptionId: uuidv4(), // placeholder — real one lives in tenant DB
      gymName:        ironPeakDha.title,
      planName:       'Professional Monthly',
      startDate:      '2024-03-01',
      endDate:        '2025-03-01',
      status:         'ACTIVE',
    },
    {
      userId:         userMap.member2.id,
      tenantId:       tenant1.id,
      gymListingId:   ironPeakDha.id,
      subscriptionId: uuidv4(),
      gymName:        ironPeakDha.title,
      planName:       'Starter Monthly',
      startDate:      '2024-04-01',
      endDate:        '2025-04-01',
      status:         'ACTIVE',
    },
    {
      userId:         userMap.member3.id,
      tenantId:       tenant1.id,
      gymListingId:   ironPeakClifton.id,
      subscriptionId: uuidv4(),
      gymName:        ironPeakClifton.title,
      planName:       'Starter Monthly',
      startDate:      '2024-05-01',
      endDate:        '2025-05-01',
      status:         'ACTIVE',
    },
    {
      userId:         userMap.member4.id,
      tenantId:       tenant2.id,
      gymListingId:   vitalityDha.id,
      subscriptionId: uuidv4(),
      gymName:        vitalityDha.title,
      planName:       'Premium Monthly',
      startDate:      '2024-06-01',
      endDate:        '2025-06-01',
      status:         'ACTIVE',
    },
    {
      userId:         userMap.member5.id,
      tenantId:       tenant2.id,
      gymListingId:   vitalityDha.id,
      subscriptionId: uuidv4(),
      gymName:        vitalityDha.title,
      planName:       'Premium Monthly',
      startDate:      '2024-07-01',
      endDate:        '2025-07-01',
      status:         'ACTIVE',
    },
  ];

  let created = 0;
  for (const m of memberships) {
    const exists = await UserGymMembership.findOne({
      where: { userId: m.userId, gymListingId: m.gymListingId },
    });
    if (!exists) {
      await UserGymMembership.create(m);
      created++;
    }
  }

  console.log(`  UserGymMemberships: ${created} created (${memberships.length} total processed)`);
}

async function seedReviews(userMap, listingMap, tenant1, tenant2) {
  const ironPeakDha = listingMap['Iron Peak Fitness — DHA Karachi'];
  const vitalityDha = listingMap['Vitality Fit Studio — DHA Lahore'];

  const reviews = [
    {
      gymListingId: ironPeakDha.id,
      userId:       userMap.member1.id,
      tenantId:     tenant1.id,
      rating:       5,
      title:        'Best gym in DHA!',
      body:         'Amazing equipment, super clean facility. The trainers are very knowledgeable and the powerlifting section is world-class. Highly recommend Iron Peak to anyone serious about fitness.',
      status:       'APPROVED',
    },
    {
      gymListingId: ironPeakDha.id,
      userId:       userMap.member2.id,
      tenantId:     tenant1.id,
      rating:       4,
      title:        'Great gym, slightly crowded evenings',
      body:         'Great selection of equipment and the staff is very helpful. Gets a bit crowded after 6pm but overall fantastic experience. The protein bar is a nice touch!',
      status:       'APPROVED',
    },
    {
      gymListingId: vitalityDha.id,
      userId:       userMap.member4.id,
      tenantId:     tenant2.id,
      rating:       5,
      title:        'Perfect ladies-only studio!',
      body:         'Finally a place where I feel completely comfortable working out. The Pilates classes are top-notch, the instructors are certified and very attentive. The cafe has amazing smoothies too.',
      status:       'APPROVED',
    },
    {
      gymListingId: vitalityDha.id,
      userId:       userMap.member5.id,
      tenantId:     tenant2.id,
      rating:       5,
      title:        'Transformed my life in 3 months',
      body:         'Joined for Zumba and ended up doing personal training as well. The holistic approach here is unlike any other gym I\'ve been to. The aerial yoga classes are breathtaking!',
      status:       'APPROVED',
    },
    // A pending review (to test moderation queue)
    {
      gymListingId: ironPeakDha.id,
      userId:       userMap.member3.id,
      tenantId:     tenant1.id,
      rating:       3,
      title:        'Good but parking is an issue',
      body:         'Equipment is solid and staff is friendly. However parking at DHA Phase 5 is a nightmare during peak hours. Hope they sort that out.',
      status:       'PENDING',
    },
  ];

  let created = 0;
  for (const r of reviews) {
    const exists = await GymReview.findOne({
      where: { gymListingId: r.gymListingId, userId: r.userId },
    });
    if (!exists) {
      await GymReview.create(r);
      created++;
    }
  }

  console.log(`  GymReviews: ${created} created (${reviews.length} total processed)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 GymsEra Full Platform Seeder\n');

  try {
    await connect();
    console.log('✅ Database connected\n');

    console.log('📍 1. Seeding cities and areas...');
    await seedCities();

    console.log('\n📦 2. Seeding platform packages...');
    await seedPackages();

    console.log('\n👤 3. Seeding users (admin + hosts + members)...');
    const userMap = await seedUsers();

    console.log('\n🏋️  4. Seeding tenants and gym listings (with lat/long)...');
    const { tenant1, tenant2, listingMap } = await seedTenantsAndListings(userMap);

    console.log('\n🔗 5. Seeding user gym memberships...');
    await seedUserGymMemberships(userMap, listingMap, tenant1, tenant2);

    console.log('\n⭐ 6. Seeding gym reviews...');
    await seedReviews(userMap, listingMap, tenant1, tenant2);

    console.log('\n✅ Seeding complete!\n');
    console.log('── Test credentials ─────────────────────────────────────────');
    console.log('  Platform Admin:   admin@gymsera.com       / Admin@1234!');
    console.log('  Gym Host 1:       ahmed@ironpeak.com      / Host@1234!');
    console.log('  Gym Host 2:       sara@vitalityfit.com    / Host@1234!');
    console.log('  Member 1:         ali.hassan@example.com  / Member@1234!');
    console.log('  Member 2:         fatima.z@example.com    / Member@1234!');
    console.log('  Member 3:         omar.farooq@example.com / Member@1234!');
    console.log('  Member 4:         ayesha.noor@example.com / Member@1234!');
    console.log('  Member 5:         bilal.c@example.com     / Member@1234!');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('  Test payment key: set PAYMENT_TEST_KEY in .env');
    console.log('  Device API key:   set DEVICE_API_KEY in .env');
    console.log('─────────────────────────────────────────────────────────────\n');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Seeder failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();

