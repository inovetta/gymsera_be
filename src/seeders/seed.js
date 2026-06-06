/**
 * GymsEra — Full Platform Seeder
 *
 * Seeds:
 *   1.  30 Pakistan cities with real areas
 *   2.  Platform packages (Starter / Professional / Enterprise)
 *   3.  Admin users (Super Admin + Platform Admin + Ops Admin + Support Admin)
 *   4.  Gym hosts (5) + Members (15)
 *   5.  Tenants (5 approved gyms) with GymListings
 *   6.  TenantSubscriptions (platform packages)
 *   7.  UserGymMemberships (cross-tenant index)
 *   8.  GymReviews (approved + pending)
 *
 * Run with:   node src/seeders/seed.js
 * Idempotent: uses findOrCreate / findOne-guard — safe to re-run.
 *
 * After this, run:  node src/scripts/provision-seeded-tenants.js
 * Then:            node src/seeders/seed-tenant.js
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
// 1. CITIES + AREAS — Complete Pakistan Coverage
// ─────────────────────────────────────────────────────────────────────────────

const CITIES = [
  {
    name: 'Karachi',
    areas: [
      'Clifton', 'DHA Phase 1', 'DHA Phase 2', 'DHA Phase 5', 'DHA Phase 6',
      'Gulshan-e-Iqbal', 'Gulshan-e-Hadeed', 'North Nazimabad', 'Nazimabad',
      'Korangi', 'Saddar', 'Malir', 'Lyari', 'PECHS', 'F.B. Area',
      'Bahria Town Karachi', 'Landhi', 'Baldia Town', 'Surjani Town',
      'New Karachi', 'Orangi Town', 'Liaquatabad', 'Kemari',
    ],
  },
  {
    name: 'Lahore',
    areas: [
      'DHA Phase 1', 'DHA Phase 4', 'DHA Phase 6', 'Gulberg I', 'Gulberg III',
      'Model Town', 'Johar Town', 'Bahria Town', 'Wapda Town', 'Cantt',
      'Iqbal Town', 'Allama Iqbal Town', 'Garden Town', 'Faisal Town',
      'Shadman', 'Cavalry Ground', 'Gulshan-e-Ravi', 'Township',
      'Liberty Market', 'Askari 10', 'Askari 11', 'Lake City',
    ],
  },
  {
    name: 'Islamabad',
    areas: [
      'F-6', 'F-7', 'F-8', 'F-10', 'F-11', 'G-6', 'G-7', 'G-9',
      'G-10', 'G-11', 'G-13', 'Blue Area', 'Bahria Town Phase 7',
      'Bahria Town Phase 8', 'E-7', 'E-11', 'DHA Phase 2 Islamabad',
      'PWD', 'Bani Gala', 'CDA Sectors', 'Pak Town', 'Margalla Hills',
    ],
  },
  {
    name: 'Rawalpindi',
    areas: [
      'Saddar', 'Bahria Town Phase 4', 'DHA Rawalpindi', 'Gulshanabad',
      'Chaklala Scheme', 'Satellite Town', 'Raja Bazar', 'Commercial Market',
      'Westridge', 'Shamsabad', 'Adiala Road', 'Murree Road',
    ],
  },
  {
    name: 'Faisalabad',
    areas: [
      'Peoples Colony', 'Madina Town', 'Jinnah Colony', 'Gulshan-e-Iqbal',
      'Canal Road', 'Satiana Road', 'D Ground', 'Millat Town',
      'Samanabad', 'Susan Road', 'Sargodha Road', 'Jhang Road',
    ],
  },
  {
    name: 'Multan',
    areas: [
      'Gulgasht Colony', 'New Multan', 'Cantt', 'Qasim Bela',
      'Shah Rukn-e-Alam Colony', 'Bosan Road', 'Bahauddin Zakaria University Road',
      'Nishtar Colony', 'Hussain Agahi', 'Mumtazabad',
    ],
  },
  {
    name: 'Peshawar',
    areas: [
      'Hayatabad Phase 1', 'Hayatabad Phase 3', 'Hayatabad Phase 6',
      'University Town', 'Saddar', 'Cantt', 'Ring Road',
      'Regi Model Town', 'Warsak Road', 'Dalazak Road',
      'Gulbahar', 'Board Bazaar',
    ],
  },
  {
    name: 'Quetta',
    areas: [
      'Satellite Town', 'Cantt', 'Jinnah Road', 'Brewery Road',
      'Zarghoon Road', 'Jinnah Town', 'Saryab Road', 'Baleli',
      'Askari Park', 'Double Road',
    ],
  },
  {
    name: 'Sialkot',
    areas: [
      'Cantt', 'Paris Road', 'Iqbal Town', 'Allama Iqbal Colony',
      'Defence Road', 'Wazirabad Road', 'Sambrial',
    ],
  },
  {
    name: 'Gujranwala',
    areas: [
      'Model Town', 'Gulshan Colony', 'Satellite Town', 'Canal Road',
      'Peoples Colony', 'Ali Town', 'Railway Road', 'Trust Colony',
    ],
  },
  {
    name: 'Hyderabad',
    areas: [
      'Latifabad', 'Qasimabad', 'Cantonment', 'Hirabad',
      'Old City', 'Gulshan-e-Iqbal', 'Hussainabad', 'Sindhi Colony',
    ],
  },
  {
    name: 'Sukkur',
    areas: [
      'Ghanta Ghar', 'Military Road', 'Airport Road', 'Rohri', 'WAPDA Colony',
    ],
  },
  {
    name: 'Larkana',
    areas: [
      'New Town', 'Civil Lines', 'Station Road', 'Airport Road', 'Rani Bagh',
    ],
  },
  {
    name: 'Bahawalpur',
    areas: [
      'Satellite Town', 'Model Town', 'Civil Lines', 'Cantt',
      'Gulshan Colony', 'Baghdad ul Jadeed',
    ],
  },
  {
    name: 'Sargodha',
    areas: [
      'Satellite Town', 'University Road', 'Civil Lines',
      'Shaheenabad', 'Cantt', 'Johar Town',
    ],
  },
  {
    name: 'Abbottabad',
    areas: [
      'Cantt', 'Mandian', 'PMA Road', 'Jinnahabad',
      'Abbottabad University Road', 'Nawan Shehr',
    ],
  },
  {
    name: 'Mardan',
    areas: [
      'New Campus', 'Cantt', 'Saddar', 'Shahi Bagh', 'Hoti Road',
    ],
  },
  {
    name: 'Dera Ghazi Khan',
    areas: [
      'New Town', 'Civil Lines', 'Cantt', 'Jampur Road', 'Satellite Town',
    ],
  },
  {
    name: 'Sahiwal',
    areas: [
      'Model Town', 'Cantt', 'Gulshan-e-Sahiwal', 'Industrial Area', 'Civil Lines',
    ],
  },
  {
    name: 'Gujrat',
    areas: [
      'Satellite Town', 'Cantt', 'Civil Lines', 'Gulshan Colony', 'Lalamusa',
    ],
  },
  {
    name: 'Jhang',
    areas: [
      'City', 'Chiniot Road', 'Shorkot', 'Toba Tek Singh Road',
    ],
  },
  {
    name: 'Sheikhupura',
    areas: [
      'Cantt', 'Muridke', 'Farooqabad', 'Shahdara', 'Ferozwala',
    ],
  },
  {
    name: 'Rahim Yar Khan',
    areas: [
      'Cantt', 'Saddar', 'Model Town', 'Satellite Town', 'Khanpur',
    ],
  },
  {
    name: 'Kasur',
    areas: [
      'Pattoki', 'Chunian', 'City', 'Allama Iqbal Colony',
    ],
  },
  {
    name: 'Dera Ismail Khan',
    areas: [
      'City', 'Cantt', 'Paharpur', 'Tank Road', 'Model Town',
    ],
  },
  {
    name: 'Nawabshah',
    areas: [
      'Old Nawabshah', 'New Nawabshah', 'Sakrand Road', 'Airport Area',
    ],
  },
  {
    name: 'Mirpur Khas',
    areas: [
      'City', 'Cantt', 'Sindhri', 'Digri',
    ],
  },
  {
    name: 'Muzaffarabad',
    areas: [
      'Committee Chowk', 'Chattar', 'Dhirkot', 'Patika', 'Kohala',
    ],
  },
  {
    name: 'Mirpur',
    areas: [
      'New Mirpur', 'Old Mirpur', 'Allama Iqbal Colony', 'Dadyal', 'Chakswari',
    ],
  },
  {
    name: 'Taxila',
    areas: [
      'Taxila Cantt', 'Wah Cantt', 'Mohra Moradu', 'Heavy Industries',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. PLATFORM PACKAGES
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
  // ── Super Admin ──────────────────────────────────────────────────────────────
  {
    _key: 'superadmin',
    fullName: 'GymsEra Super Admin',
    email: 'superadmin@gymsera.com',
    password: 'SuperAdmin@GymsEra1',
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+920000000001',
  },
  // ── Platform Admins ──────────────────────────────────────────────────────────
  {
    _key: 'admin',
    fullName: 'GymsEra Platform Admin',
    email: 'admin@gymsera.com',
    password: 'Admin@GymsEra1',
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+920000000002',
  },
  {
    _key: 'opsadmin',
    fullName: 'GymsEra Operations',
    email: 'ops@gymsera.com',
    password: 'Ops@GymsEra1',
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+920000000003',
  },
  {
    _key: 'supportadmin',
    fullName: 'GymsEra Support',
    email: 'support@gymsera.com',
    password: 'Support@GymsEra1',
    role: 'PLATFORM_ADMIN',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+920000000004',
  },
  // ── Gym Hosts ────────────────────────────────────────────────────────────────
  {
    _key: 'host1',
    fullName: 'Ahmed Khan',
    email: 'ahmed@ironpeak.com',
    password: 'GymHost@1234',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923001234567',
  },
  {
    _key: 'host2',
    fullName: 'Sara Malik',
    email: 'sara@vitalityfit.com',
    password: 'GymHost@1234',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923211234567',
  },
  {
    _key: 'host3',
    fullName: 'Usman Tariq',
    email: 'usman@powerzone.com',
    password: 'GymHost@1234',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923451234567',
  },
  {
    _key: 'host4',
    fullName: 'Nadia Hussain',
    email: 'nadia@fitlife.com',
    password: 'GymHost@1234',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923361234567',
  },
  {
    _key: 'host5',
    fullName: 'Zain Ali',
    email: 'zain@champions.com',
    password: 'GymHost@1234',
    role: 'GYM_HOST',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923121234567',
  },
  // ── Members ──────────────────────────────────────────────────────────────────
  {
    _key: 'member1',
    fullName: 'Ali Hassan',
    email: 'ali.hassan@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001001',
  },
  {
    _key: 'member2',
    fullName: 'Fatima Zahra',
    email: 'fatima.z@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001002',
  },
  {
    _key: 'member3',
    fullName: 'Omar Farooq',
    email: 'omar.farooq@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001003',
  },
  {
    _key: 'member4',
    fullName: 'Ayesha Noor',
    email: 'ayesha.noor@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001004',
  },
  {
    _key: 'member5',
    fullName: 'Bilal Chaudhry',
    email: 'bilal.c@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001005',
  },
  {
    _key: 'member6',
    fullName: 'Hira Sheikh',
    email: 'hira.sheikh@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001006',
  },
  {
    _key: 'member7',
    fullName: 'Kamran Baig',
    email: 'kamran.baig@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001007',
  },
  {
    _key: 'member8',
    fullName: 'Sana Iqbal',
    email: 'sana.iqbal@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001008',
  },
  {
    _key: 'member9',
    fullName: 'Tariq Mehmood',
    email: 'tariq.m@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001009',
  },
  {
    _key: 'member10',
    fullName: 'Zara Qureshi',
    email: 'zara.q@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001010',
  },
  {
    _key: 'member11',
    fullName: 'Hamza Raza',
    email: 'hamza.raza@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001011',
  },
  {
    _key: 'member12',
    fullName: 'Mahnoor Butt',
    email: 'mahnoor.b@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001012',
  },
  {
    _key: 'member13',
    fullName: 'Asad Javed',
    email: 'asad.javed@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001013',
  },
  {
    _key: 'member14',
    fullName: 'Rimsha Anwar',
    email: 'rimsha.anwar@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001014',
  },
  {
    _key: 'member15',
    fullName: 'Waqar Shah',
    email: 'waqar.shah@example.com',
    password: 'Member@1234',
    role: 'MEMBER',
    status: 'ACTIVE',
    isVerified: true,
    phone: '+923009001015',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
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

  console.log(`  Cities: ${createdCities} new  (${CITIES.length} total processed)`);
  console.log(`  Areas:  ${createdAreas} new`);
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
  console.log(`  Packages: ${created} new  (${PACKAGES.length} total processed)`);
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
      phone:    u.phone,
      passwordHash,
      role:       u.role,
      status:     u.status,
      isVerified: u.isVerified,
    });
    userMap[u._key] = user;
    created++;
  }

  console.log(`  Users: ${created} new  (${SEED_USERS.length} total processed)`);
  return userMap;
}

async function seedTenantsAndListings(userMap) {
  // Resolve city records
  const cities = {};
  for (const name of ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad']) {
    cities[name] = await City.findOne({ where: { name } });
  }

  // Resolve area records
  const areas = {};
  const areaLookups = [
    ['karachi_dha5',     'Karachi',     'DHA Phase 5'],
    ['karachi_clifton',  'Karachi',     'Clifton'],
    ['karachi_gulshan',  'Karachi',     'Gulshan-e-Iqbal'],
    ['lahore_dha4',      'Lahore',      'DHA Phase 4'],
    ['lahore_gulberg',   'Lahore',      'Gulberg III'],
    ['lahore_johar',     'Lahore',      'Johar Town'],
    ['islamabad_f8',     'Islamabad',   'F-8'],
    ['islamabad_f7',     'Islamabad',   'F-7'],
    ['islamabad_e11',    'Islamabad',   'E-11'],
    ['pindi_dha',        'Rawalpindi',  'DHA Rawalpindi'],
    ['pindi_bahria',     'Rawalpindi',  'Bahria Town Phase 4'],
    ['fsd_peoples',      'Faisalabad',  'Peoples Colony'],
    ['fsd_madina',       'Faisalabad',  'Madina Town'],
  ];
  for (const [key, cityName, areaName] of areaLookups) {
    areas[key] = await Area.findOne({ where: { cityId: cities[cityName].id, name: areaName } });
  }

  const proPackage   = await PlatformPackage.findOne({ where: { name: 'Professional' } });
  const entPackage   = await PlatformPackage.findOne({ where: { name: 'Enterprise' } });
  const startPackage = await PlatformPackage.findOne({ where: { name: 'Starter' } });

  // ── TENANT DEFINITIONS ──────────────────────────────────────────────────────
  const tenantDefs = [
    {
      _key: 'tenant1',
      data: {
        tenantCode:    'IRONPEAK',
        businessName:  'Iron Peak Fitness Pvt Ltd',
        ownerUserId:   userMap.host1.id,
        email:         'ahmed@ironpeak.com',
        phone:         '+923001234567',
        cityId:        cities['Karachi'].id,
        address:       'Plot 12, DHA Phase 5, Karachi',
        gymName:       'Iron Peak Fitness',
        gymDescription:'State-of-the-art gym with Olympic lifting platforms, powerlifting racks, and a dedicated cardio zone. Certified trainers, nutrition counseling, and group fitness classes.',
        genderType:    'MIXED',
        status:        'ACTIVE',
        kycStatus:     'APPROVED',
        onboardingStep: 3,
        approvedAt:    new Date('2024-01-15'),
        connectionStringEncrypted: 'PENDING_PROVISIONING',
      },
      pkg: entPackage,
      subStart: '2024-01-15',
      subEnd:   '2026-01-14',
    },
    {
      _key: 'tenant2',
      data: {
        tenantCode:    'VITALITYFIT',
        businessName:  'Vitality Fit Studio LLC',
        ownerUserId:   userMap.host2.id,
        email:         'sara@vitalityfit.com',
        phone:         '+923211234567',
        cityId:        cities['Lahore'].id,
        address:       'Block D, DHA Phase 4, Lahore',
        gymName:       'Vitality Fit Studio',
        gymDescription:'Premium ladies-only fitness studio with Pilates, Zumba, aerial yoga, and personalized coaching. Transforming lives through holistic wellness.',
        genderType:    'FEMALE_ONLY',
        status:        'ACTIVE',
        kycStatus:     'APPROVED',
        onboardingStep: 3,
        approvedAt:    new Date('2024-02-10'),
        connectionStringEncrypted: 'PENDING_PROVISIONING',
      },
      pkg: proPackage,
      subStart: '2024-02-10',
      subEnd:   '2025-02-09',
    },
    {
      _key: 'tenant3',
      data: {
        tenantCode:    'POWERZONE',
        businessName:  'PowerZone Gym & Fitness',
        ownerUserId:   userMap.host3.id,
        email:         'usman@powerzone.com',
        phone:         '+923451234567',
        cityId:        cities['Rawalpindi'].id,
        address:       'Main Boulevard, DHA Rawalpindi',
        gymName:       'PowerZone Gym',
        gymDescription:'Rawalpindi\'s premier strength and conditioning facility. Heavy iron, functional training, combat sports, and a protein cafe.',
        genderType:    'MIXED',
        status:        'ACTIVE',
        kycStatus:     'APPROVED',
        onboardingStep: 3,
        approvedAt:    new Date('2024-03-20'),
        connectionStringEncrypted: 'PENDING_PROVISIONING',
      },
      pkg: proPackage,
      subStart: '2024-03-20',
      subEnd:   '2025-03-19',
    },
    {
      _key: 'tenant4',
      data: {
        tenantCode:    'FITLIFE',
        businessName:  'FitLife Studio Islamabad',
        ownerUserId:   userMap.host4.id,
        email:         'nadia@fitlife.com',
        phone:         '+923361234567',
        cityId:        cities['Islamabad'].id,
        address:       'F-8 Markaz, Islamabad',
        gymName:       'FitLife Studio',
        gymDescription:'Islamabad\'s top women-only fitness destination. Yoga, spinning, HIIT, and luxury spa facilities in a serene environment.',
        genderType:    'FEMALE_ONLY',
        status:        'ACTIVE',
        kycStatus:     'APPROVED',
        onboardingStep: 3,
        approvedAt:    new Date('2024-04-05'),
        connectionStringEncrypted: 'PENDING_PROVISIONING',
      },
      pkg: startPackage,
      subStart: '2024-04-05',
      subEnd:   '2025-04-04',
    },
    {
      _key: 'tenant5',
      data: {
        tenantCode:    'CHAMPIONS',
        businessName:  'Champions Athletic Club',
        ownerUserId:   userMap.host5.id,
        email:         'zain@champions.com',
        phone:         '+923121234567',
        cityId:        cities['Faisalabad'].id,
        address:       'Peoples Colony, Faisalabad',
        gymName:       'Champions Athletic Club',
        gymDescription:'Mixed martial arts, boxing, wrestling, and general fitness under one roof. Faisalabad\'s home of combat sports and strength training.',
        genderType:    'MIXED',
        status:        'ACTIVE',
        kycStatus:     'APPROVED',
        onboardingStep: 3,
        approvedAt:    new Date('2024-05-01'),
        connectionStringEncrypted: 'PENDING_PROVISIONING',
      },
      pkg: startPackage,
      subStart: '2024-05-01',
      subEnd:   '2025-04-30',
    },
  ];

  const tenantMap = {};
  let tenantsCreated = 0;

  for (const td of tenantDefs) {
    const [tenant, wasCreated] = await Tenant.findOrCreate({
      where:    { tenantCode: td.data.tenantCode },
      defaults: td.data,
    });
    tenantMap[td._key] = tenant;
    if (wasCreated) tenantsCreated++;

    await TenantSubscription.findOrCreate({
      where: { tenantId: tenant.id },
      defaults: {
        tenantId:          tenant.id,
        platformPackageId: td.pkg.id,
        status:            'ACTIVE',
        startDate:         td.subStart,
        endDate:           td.subEnd,
        amount:            td.pkg.price,
        billingCycle:      td.pkg.billingCycle,
        paymentStatus:     'PAID',
        autoRenew:         true,
      },
    });
  }

  console.log(`  Tenants: ${tenantsCreated} new  (${tenantDefs.length} total processed)`);

  // ── GYM LISTINGS ────────────────────────────────────────────────────────────
  const listingDefs = [
    // Iron Peak
    {
      tenantId:         tenantMap.tenant1.id,
      cityId:           cities['Karachi'].id,
      areaId:           areas['karachi_dha5'].id,
      title:            'Iron Peak Fitness — DHA Phase 5 Karachi',
      shortDescription: 'Karachi\'s premier powerlifting & bodybuilding gym. Olympic platforms, full cardio suite, protein bar.',
      genderType:       'MIXED',
      averageRating:    4.7,
      latitude:         24.80413,
      longitude:        67.07230,
      isFeatured:       true,
      contactPhone:     '+923001234567',
      website:          'https://ironpeak.com',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: false, pool: false, cafe: true, personalTraining: true, ac: true, cctv: true },
      status:           'ACTIVE',
    },
    {
      tenantId:         tenantMap.tenant1.id,
      cityId:           cities['Karachi'].id,
      areaId:           areas['karachi_clifton'].id,
      title:            'Iron Peak Fitness — Clifton Karachi',
      shortDescription: 'Iron Peak\'s Clifton branch — full weights room, group classes, and sports nutrition.',
      genderType:       'MIXED',
      averageRating:    4.5,
      latitude:         24.81068,
      longitude:        67.02754,
      isFeatured:       false,
      contactPhone:     '+923001234568',
      website:          'https://ironpeak.com',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: false, pool: false, cafe: false, personalTraining: true, ac: true },
      status:           'ACTIVE',
    },
    // Vitality Fit
    {
      tenantId:         tenantMap.tenant2.id,
      cityId:           cities['Lahore'].id,
      areaId:           areas['lahore_dha4'].id,
      title:            'Vitality Fit Studio — DHA Lahore',
      shortDescription: 'Ladies-only wellness studio: Pilates, Zumba, aerial yoga & personal coaching.',
      genderType:       'FEMALE_ONLY',
      averageRating:    4.9,
      latitude:         31.47715,
      longitude:        74.40395,
      isFeatured:       true,
      contactPhone:     '+923211234567',
      website:          'https://vitalityfit.com',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: true, pool: false, cafe: true, personalTraining: true, yoga: true, pilates: true, zumba: true, spa: true },
      status:           'ACTIVE',
    },
    {
      tenantId:         tenantMap.tenant2.id,
      cityId:           cities['Lahore'].id,
      areaId:           areas['lahore_gulberg'].id,
      title:            'Vitality Fit Studio — Gulberg Lahore',
      shortDescription: 'Vitality Fit\'s Gulberg studio — dance fitness, spinning, and wellness therapy.',
      genderType:       'FEMALE_ONLY',
      averageRating:    4.6,
      latitude:         31.51620,
      longitude:        74.35580,
      isFeatured:       false,
      contactPhone:     '+923211234577',
      website:          'https://vitalityfit.com',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: false, pool: false, cafe: true, personalTraining: true, yoga: true, spinning: true },
      status:           'ACTIVE',
    },
    // PowerZone
    {
      tenantId:         tenantMap.tenant3.id,
      cityId:           cities['Rawalpindi'].id,
      areaId:           areas['pindi_dha'].id,
      title:            'PowerZone Gym — DHA Rawalpindi',
      shortDescription: 'Heavy iron, functional training & combat sports. Rawalpindi\'s #1 strength gym.',
      genderType:       'MIXED',
      averageRating:    4.6,
      latitude:         33.53260,
      longitude:        73.10570,
      isFeatured:       true,
      contactPhone:     '+923451234567',
      website:          'https://powerzonegym.pk',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: false, pool: false, cafe: true, personalTraining: true, boxing: true, mma: true, ac: true },
      status:           'ACTIVE',
    },
    {
      tenantId:         tenantMap.tenant3.id,
      cityId:           cities['Rawalpindi'].id,
      areaId:           areas['pindi_bahria'].id,
      title:            'PowerZone Gym — Bahria Town Rawalpindi',
      shortDescription: 'PowerZone\'s Bahria Town branch — full gym, cardio zone, and MMA ring.',
      genderType:       'MIXED',
      averageRating:    4.4,
      latitude:         33.52400,
      longitude:        73.17000,
      isFeatured:       false,
      contactPhone:     '+923451234577',
      website:          'https://powerzonegym.pk',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, cafe: false, personalTraining: true, boxing: true, ac: true },
      status:           'ACTIVE',
    },
    // FitLife
    {
      tenantId:         tenantMap.tenant4.id,
      cityId:           cities['Islamabad'].id,
      areaId:           areas['islamabad_f8'].id,
      title:            'FitLife Studio — F-8 Islamabad',
      shortDescription: 'Islamabad\'s top women-only studio. Yoga, HIIT, spinning, and luxury spa.',
      genderType:       'FEMALE_ONLY',
      averageRating:    4.8,
      latitude:         33.70756,
      longitude:        73.04941,
      isFeatured:       true,
      contactPhone:     '+923361234567',
      website:          'https://fitlifestudio.pk',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: true, pool: false, cafe: true, personalTraining: true, yoga: true, spinning: true, spa: true, ac: true },
      status:           'ACTIVE',
    },
    // Champions
    {
      tenantId:         tenantMap.tenant5.id,
      cityId:           cities['Faisalabad'].id,
      areaId:           areas['fsd_peoples'].id,
      title:            'Champions Athletic Club — Peoples Colony Faisalabad',
      shortDescription: 'MMA, boxing, wrestling & general fitness. Faisalabad\'s combat sports HQ.',
      genderType:       'MIXED',
      averageRating:    4.5,
      latitude:         31.41500,
      longitude:        73.07400,
      isFeatured:       true,
      contactPhone:     '+923121234567',
      website:          'https://champions.pk',
      facilitiesJson:   { parking: true, wifi: true, locker: true, shower: true, sauna: false, pool: false, cafe: false, personalTraining: true, boxing: true, mma: true, wrestling: true, ac: false },
      status:           'ACTIVE',
    },
    // Coming soon (filter testing)
    {
      tenantId:         tenantMap.tenant1.id,
      cityId:           cities['Islamabad'].id,
      areaId:           areas['islamabad_e11'].id,
      title:            'Iron Peak Fitness — E-11 Islamabad (Coming Soon)',
      shortDescription: 'Iron Peak expanding to Islamabad. Pre-registration open.',
      genderType:       'MIXED',
      averageRating:    0,
      latitude:         33.72380,
      longitude:        72.98920,
      isFeatured:       false,
      contactPhone:     '+923001234569',
      website:          'https://ironpeak.com',
      facilitiesJson:   {},
      status:           'PENDING',
    },
  ];

  const listingMap = {};
  let listingsCreated = 0;

  for (const ld of listingDefs) {
    const [listing, wasCreated] = await GymListing.findOrCreate({
      where:    { title: ld.title, tenantId: ld.tenantId },
      defaults: ld,
    });
    listingMap[listing.title] = listing;
    if (wasCreated) listingsCreated++;
  }

  console.log(`  GymListings: ${listingsCreated} new  (${listingDefs.length} total processed)`);

  return { tenantMap, listingMap, cities, areas };
}

async function seedUserGymMemberships(userMap, tenantMap, listingMap) {
  const t1 = tenantMap.tenant1;
  const t2 = tenantMap.tenant2;
  const t3 = tenantMap.tenant3;
  const t4 = tenantMap.tenant4;
  const t5 = tenantMap.tenant5;

  const ip_dha      = listingMap['Iron Peak Fitness — DHA Phase 5 Karachi'];
  const ip_clifton  = listingMap['Iron Peak Fitness — Clifton Karachi'];
  const vf_dha      = listingMap['Vitality Fit Studio — DHA Lahore'];
  const vf_gulberg  = listingMap['Vitality Fit Studio — Gulberg Lahore'];
  const pz_dha      = listingMap['PowerZone Gym — DHA Rawalpindi'];
  const fl_f8       = listingMap['FitLife Studio — F-8 Islamabad'];
  const ch_peoples  = listingMap['Champions Athletic Club — Peoples Colony Faisalabad'];

  const memberships = [
    { userId: userMap.member1.id,  tenantId: t1.id, gymListingId: ip_dha.id,     gymName: ip_dha.title,     planName: 'Premium Monthly',    startDate: '2024-03-01', endDate: '2026-03-01', status: 'ACTIVE' },
    { userId: userMap.member2.id,  tenantId: t1.id, gymListingId: ip_dha.id,     gymName: ip_dha.title,     planName: 'Starter Monthly',    startDate: '2024-04-01', endDate: '2026-04-01', status: 'ACTIVE' },
    { userId: userMap.member3.id,  tenantId: t1.id, gymListingId: ip_clifton.id,  gymName: ip_clifton.title, planName: 'Starter Monthly',    startDate: '2024-05-01', endDate: '2026-05-01', status: 'ACTIVE' },
    { userId: userMap.member4.id,  tenantId: t2.id, gymListingId: vf_dha.id,     gymName: vf_dha.title,     planName: 'Premium Quarterly',  startDate: '2024-06-01', endDate: '2026-06-01', status: 'ACTIVE' },
    { userId: userMap.member5.id,  tenantId: t2.id, gymListingId: vf_dha.id,     gymName: vf_dha.title,     planName: 'Premium Monthly',    startDate: '2024-07-01', endDate: '2026-07-01', status: 'ACTIVE' },
    { userId: userMap.member6.id,  tenantId: t2.id, gymListingId: vf_gulberg.id, gymName: vf_gulberg.title, planName: 'Starter Monthly',    startDate: '2024-08-01', endDate: '2025-08-01', status: 'ACTIVE' },
    { userId: userMap.member7.id,  tenantId: t3.id, gymListingId: pz_dha.id,     gymName: pz_dha.title,     planName: 'Fighter Monthly',    startDate: '2024-09-01', endDate: '2026-09-01', status: 'ACTIVE' },
    { userId: userMap.member8.id,  tenantId: t4.id, gymListingId: fl_f8.id,      gymName: fl_f8.title,      planName: 'Wellness Monthly',   startDate: '2024-10-01', endDate: '2026-10-01', status: 'ACTIVE' },
    { userId: userMap.member9.id,  tenantId: t4.id, gymListingId: fl_f8.id,      gymName: fl_f8.title,      planName: 'Starter Monthly',    startDate: '2024-11-01', endDate: '2025-11-01', status: 'ACTIVE' },
    { userId: userMap.member10.id, tenantId: t5.id, gymListingId: ch_peoples.id, gymName: ch_peoples.title, planName: 'Martial Arts Monthly', startDate: '2024-12-01', endDate: '2026-12-01', status: 'ACTIVE' },
    { userId: userMap.member11.id, tenantId: t5.id, gymListingId: ch_peoples.id, gymName: ch_peoples.title, planName: 'General Fitness',    startDate: '2025-01-01', endDate: '2026-01-01', status: 'ACTIVE' },
    { userId: userMap.member12.id, tenantId: t2.id, gymListingId: vf_dha.id,     gymName: vf_dha.title,     planName: 'Yearly Premium',     startDate: '2025-02-01', endDate: '2026-02-01', status: 'ACTIVE' },
    { userId: userMap.member13.id, tenantId: t1.id, gymListingId: ip_dha.id,     gymName: ip_dha.title,     planName: 'Monthly',            startDate: '2025-03-01', endDate: '2025-06-01', status: 'EXPIRED' },
    { userId: userMap.member14.id, tenantId: t3.id, gymListingId: pz_dha.id,     gymName: pz_dha.title,     planName: 'Starter Monthly',    startDate: '2025-04-01', endDate: '2026-04-01', status: 'ACTIVE' },
    { userId: userMap.member15.id, tenantId: t1.id, gymListingId: ip_clifton.id, gymName: ip_clifton.title, planName: 'Annual',             startDate: '2025-05-01', endDate: '2026-05-01', status: 'ACTIVE' },
  ];

  let created = 0;
  for (const m of memberships) {
    const exists = await UserGymMembership.findOne({
      where: { userId: m.userId, gymListingId: m.gymListingId },
    });
    if (!exists) {
      await UserGymMembership.create({ ...m, subscriptionId: uuidv4() });
      created++;
    }
  }

  console.log(`  UserGymMemberships: ${created} new  (${memberships.length} total processed)`);
}

async function seedReviews(userMap, tenantMap, listingMap) {
  const ip_dha     = listingMap['Iron Peak Fitness — DHA Phase 5 Karachi'];
  const ip_clifton = listingMap['Iron Peak Fitness — Clifton Karachi'];
  const vf_dha     = listingMap['Vitality Fit Studio — DHA Lahore'];
  const pz_dha     = listingMap['PowerZone Gym — DHA Rawalpindi'];
  const fl_f8      = listingMap['FitLife Studio — F-8 Islamabad'];
  const ch_peoples = listingMap['Champions Athletic Club — Peoples Colony Faisalabad'];

  const reviews = [
    // Iron Peak DHA
    { gymListingId: ip_dha.id,     userId: userMap.member1.id,  tenantId: tenantMap.tenant1.id, rating: 5, title: 'Best gym in DHA!', body: 'Amazing equipment, super clean facility. The trainers are very knowledgeable and the powerlifting section is world-class. Highly recommend Iron Peak to anyone serious about fitness.', status: 'APPROVED' },
    { gymListingId: ip_dha.id,     userId: userMap.member2.id,  tenantId: tenantMap.tenant1.id, rating: 4, title: 'Great gym, slightly crowded evenings', body: 'Great selection of equipment and the staff is very helpful. Gets a bit crowded after 6pm but overall fantastic experience. The protein bar is a nice touch!', status: 'APPROVED' },
    { gymListingId: ip_dha.id,     userId: userMap.member3.id,  tenantId: tenantMap.tenant1.id, rating: 3, title: 'Good but parking is an issue', body: 'Equipment is solid and staff is friendly. However parking at DHA Phase 5 is a nightmare during peak hours. Hope they sort that out.', status: 'PENDING' },
    { gymListingId: ip_dha.id,     userId: userMap.member13.id, tenantId: tenantMap.tenant1.id, rating: 5, title: 'Transformed my physique in 6 months', body: 'I joined Iron Peak as a complete beginner and my trainer Faisal completely transformed my approach to fitness. World-class facility, worth every rupee.', status: 'APPROVED' },
    // Iron Peak Clifton
    { gymListingId: ip_clifton.id, userId: userMap.member15.id, tenantId: tenantMap.tenant1.id, rating: 4, title: 'Solid gym in Clifton', body: 'Great alternative to the DHA branch if you live in Clifton. All the important equipment is there. Staff could be more attentive but overall good experience.', status: 'APPROVED' },
    // Vitality Fit DHA
    { gymListingId: vf_dha.id,     userId: userMap.member4.id,  tenantId: tenantMap.tenant2.id, rating: 5, title: 'Perfect ladies-only studio!', body: 'Finally a place where I feel completely comfortable working out. The Pilates classes are top-notch, the instructors are certified and very attentive. The cafe has amazing smoothies too.', status: 'APPROVED' },
    { gymListingId: vf_dha.id,     userId: userMap.member5.id,  tenantId: tenantMap.tenant2.id, rating: 5, title: 'Transformed my life in 3 months', body: 'Joined for Zumba and ended up doing personal training as well. The holistic approach here is unlike any other gym I\'ve been to. The aerial yoga classes are breathtaking!', status: 'APPROVED' },
    { gymListingId: vf_dha.id,     userId: userMap.member12.id, tenantId: tenantMap.tenant2.id, rating: 5, title: 'Best investment in my health', body: 'Sara and her team have created something truly special. The spa facilities are luxurious and the trainers genuinely care about your progress. 10/10 recommend.', status: 'APPROVED' },
    // PowerZone
    { gymListingId: pz_dha.id,     userId: userMap.member7.id,  tenantId: tenantMap.tenant3.id, rating: 5, title: 'Rawalpindi\'s finest!', body: 'The MMA section is phenomenal. Coach Umer is one of the best in Pakistan. The strength training area has everything you need. Very professional environment.', status: 'APPROVED' },
    { gymListingId: pz_dha.id,     userId: userMap.member14.id, tenantId: tenantMap.tenant3.id, rating: 4, title: 'Great for combat sports', body: 'Excellent boxing and wrestling facilities. The sparring sessions are well-organized. Could use more cardio equipment but overall a solid gym.', status: 'APPROVED' },
    // FitLife
    { gymListingId: fl_f8.id,      userId: userMap.member8.id,  tenantId: tenantMap.tenant4.id, rating: 5, title: 'The best women-only gym in Islamabad', body: 'The spinning classes are incredible and the yoga studio has such a calming atmosphere. The spa services are a great bonus. Really worth the premium price.', status: 'APPROVED' },
    { gymListingId: fl_f8.id,      userId: userMap.member9.id,  tenantId: tenantMap.tenant4.id, rating: 4, title: 'Love the HIIT classes', body: 'The HIIT and functional training classes are my favourites. The trainers push you just the right amount. Parking can be tricky in F-8 but the gym itself is excellent.', status: 'APPROVED' },
    // Champions
    { gymListingId: ch_peoples.id, userId: userMap.member10.id, tenantId: tenantMap.tenant5.id, rating: 5, title: 'Faisalabad\'s MMA capital', body: 'This is the real deal for combat sports in Faisalabad. The coaches are highly experienced and the training atmosphere is very motivating. Boxing, wrestling, and BJJ all under one roof!', status: 'APPROVED' },
    { gymListingId: ch_peoples.id, userId: userMap.member11.id, tenantId: tenantMap.tenant5.id, rating: 4, title: 'Great for serious athletes', body: 'Very professional setup. The strength training area is well-equipped. Would love to see some AC added in summer but the training quality compensates for that.', status: 'APPROVED' },
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

  console.log(`  GymReviews: ${created} new  (${reviews.length} total processed)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  GymsEra Full Platform Seeder\n');

  try {
    await connect();
    console.log('✅  Database connected\n');

    console.log('📍  1. Seeding cities and areas (30 cities, complete Pakistan coverage)...');
    await seedCities();

    console.log('\n📦  2. Seeding platform packages...');
    await seedPackages();

    console.log('\n👤  3. Seeding users (admins + hosts + members)...');
    const userMap = await seedUsers();

    console.log('\n🏋️   4. Seeding tenants and gym listings...');
    const { tenantMap, listingMap } = await seedTenantsAndListings(userMap);

    console.log('\n🔗  5. Seeding user gym memberships...');
    await seedUserGymMemberships(userMap, tenantMap, listingMap);

    console.log('\n⭐  6. Seeding gym reviews...');
    await seedReviews(userMap, tenantMap, listingMap);

    console.log('\n✅  Platform seeding complete!\n');

    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║                  TEST CREDENTIALS — STAGING                     ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  ADMIN ACCOUNTS                                                  ║');
    console.log('║  Super Admin      superadmin@gymsera.com  SuperAdmin@GymsEra1   ║');
    console.log('║  Platform Admin   admin@gymsera.com       Admin@GymsEra1        ║');
    console.log('║  Ops Admin        ops@gymsera.com         Ops@GymsEra1          ║');
    console.log('║  Support Admin    support@gymsera.com     Support@GymsEra1      ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  GYM HOSTS (all password: GymHost@1234)                         ║');
    console.log('║  Iron Peak        ahmed@ironpeak.com                            ║');
    console.log('║  Vitality Fit     sara@vitalityfit.com                          ║');
    console.log('║  PowerZone        usman@powerzone.com                           ║');
    console.log('║  FitLife          nadia@fitlife.com                             ║');
    console.log('║  Champions        zain@champions.com                            ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  MEMBERS (all password: Member@1234)                            ║');
    console.log('║  ali.hassan@example.com     fatima.z@example.com               ║');
    console.log('║  omar.farooq@example.com    ayesha.noor@example.com            ║');
    console.log('║  bilal.c@example.com        hira.sheikh@example.com            ║');
    console.log('║  kamran.baig@example.com    sana.iqbal@example.com             ║');
    console.log('║  tariq.m@example.com        zara.q@example.com                 ║');
    console.log('║  hamza.raza@example.com     mahnoor.b@example.com              ║');
    console.log('║  asad.javed@example.com     rimsha.anwar@example.com           ║');
    console.log('║  waqar.shah@example.com                                         ║');
    console.log('╠══════════════════════════════════════════════════════════════════╣');
    console.log('║  NEXT STEPS                                                      ║');
    console.log('║  1. node src/scripts/provision-seeded-tenants.js                ║');
    console.log('║  2. node src/seeders/seed-tenant.js                             ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    process.exit(0);
  } catch (err) {
    console.error('\n❌  Seeder failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
