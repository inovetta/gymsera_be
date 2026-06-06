/**
 * GymsEra — Tenant DB Seeder
 *
 * Seeds all approved tenant databases with real operational data:
 *   • Gym profile
 *   • 2–3 Branches (with real Pakistani addresses + coordinates)
 *   • Membership Plans (Daily / Monthly / Quarterly / Yearly + Trial)
 *   • Trainers with specializations and schedules
 *   • GymStaff (managers, receptionists)
 *   • MemberProfiles (health data for each member)
 *   • MemberSubscriptions (members subscribed to plans)
 *   • AttendanceLogs (realistic 90-day check-in history)
 *   • Payments (COMPLETED) for each subscription
 *   • Invoices (PAID) matching each payment
 *
 * Prerequisites:
 *   1. node src/seeders/seed.js                      (platform data)
 *   2. node src/scripts/provision-seeded-tenants.js  (tenant DB provisioning)
 *
 * Run:   node src/seeders/seed-tenant.js
 *        node src/seeders/seed-tenant.js IRONPEAK    (single tenant)
 */
require('dotenv').config();

const mysql     = require('mysql2/promise');
const { Sequelize } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

const { connect: initPlatformDb } = require('../database/platform');
const { Tenant, User, City, Area, UserGymMembership } = require('../models/platform');
const registerTenantModels = require('../models/tenant');
const { decrypt } = require('../utils/crypto.utils');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

const dateOnly = (d) => d.toISOString().slice(0, 10);

// Invoice numbers: INV-TENANTCODE-000001
const makeInvoiceNo = (tenantCode, n) =>
  `INV-${tenantCode}-${String(n).padStart(6, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant seed definitions
// ─────────────────────────────────────────────────────────────────────────────

const TENANT_SEEDS = {

  // ── IRONPEAK ────────────────────────────────────────────────────────────────
  IRONPEAK: {
    gym: {
      name:            'Iron Peak Fitness',
      description:     'Pakistan\'s leading powerlifting and bodybuilding facility. Olympic lifting platforms, powerlifting racks, functional training zone, and a fully-stocked protein bar.',
      contactPhone:    '+923001234567',
      contactEmail:    'info@ironpeak.com',
      website:         'https://ironpeak.com',
      genderType:      'MIXED',
      socialLinksJson: { instagram: 'https://instagram.com/ironpeakfitness', facebook: 'https://facebook.com/ironpeakfitness' },
    },
    branches: [
      {
        branchName:   'Iron Peak DHA Phase 5',
        address:      'Plot 12, Street 4, DHA Phase 5, Karachi',
        cityName:     'Karachi',
        areaName:     'DHA Phase 5',
        latitude:     24.80413,
        longitude:    67.07230,
        openingTime:  '05:30:00',
        closingTime:  '23:00:00',
        phone:        '+923001234567',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Cafe', 'CCTV', 'Olympic Platform', 'Sauna'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
      {
        branchName:   'Iron Peak Clifton',
        address:      'Block 5, Clifton, Karachi',
        cityName:     'Karachi',
        areaName:     'Clifton',
        latitude:     24.81068,
        longitude:    67.02754,
        openingTime:  '06:00:00',
        closingTime:  '22:30:00',
        phone:        '+923001234568',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'CCTV', 'Olympic Platform'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
      {
        branchName:   'Iron Peak Gulshan',
        address:      'Block 13A, Gulshan-e-Iqbal, Karachi',
        cityName:     'Karachi',
        areaName:     'Gulshan-e-Iqbal',
        latitude:     24.92300,
        longitude:    67.11200,
        openingTime:  '06:00:00',
        closingTime:  '22:00:00',
        phone:        '+923001234570',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
    ],
    plans: [
      { name: 'Day Pass',        durationType: 'DAILY',     durationValue: 1,  price: 500,   joiningFee: 0,    maxMembers: null, isTrial: false },
      { name: 'Monthly Basic',   durationType: 'MONTHLY',   durationValue: 1,  price: 4500,  joiningFee: 500,  maxMembers: null, isTrial: false },
      { name: 'Monthly Premium', durationType: 'MONTHLY',   durationValue: 1,  price: 7000,  joiningFee: 500,  maxMembers: null, isTrial: false },
      { name: 'Quarterly',       durationType: 'QUARTERLY', durationValue: 3,  price: 18000, joiningFee: 500,  maxMembers: null, isTrial: false },
      { name: 'Annual',          durationType: 'YEARLY',    durationValue: 12, price: 60000, joiningFee: 1000, maxMembers: null, isTrial: false },
      { name: '3-Day Trial',     durationType: 'DAILY',     durationValue: 3,  price: 0,     joiningFee: 0,    maxMembers: null, isTrial: true  },
    ],
    trainers: [
      { fullName: 'Faisal Qureshi',  specialization: 'Powerlifting & Strength',  bio: 'National-level powerlifter with 8 years coaching experience. IPF certified coach.',       yearsExperience: 8,  certifications: ['IPF Level 2', 'Nutrition Certification'], ratingAvg: 4.9 },
      { fullName: 'Kamran Siddiqui', specialization: 'Bodybuilding & Aesthetics', bio: 'Competitive bodybuilder and IFBB judge. Expert in hypertrophy programming and diet planning.', yearsExperience: 6, certifications: ['IFBB Pro Card', 'ACE Certified'], ratingAvg: 4.7 },
      { fullName: 'Zubair Ahmed',    specialization: 'Cardio & Fat Loss',         bio: 'ACSM-certified fitness trainer specializing in weight management and functional fitness.', yearsExperience: 4, certifications: ['ACSM CPT', 'TRX Certified'], ratingAvg: 4.6 },
    ],
    staff: [
      { designation: 'Branch Manager',  fullName: 'Hassan Raza' },
      { designation: 'Receptionist',    fullName: 'Aqsa Saleem' },
      { designation: 'Receptionist',    fullName: 'Noman Ali' },
    ],
    memberKeys: ['member1', 'member2', 'member3', 'member13', 'member15'],
    memberPlans: {
      member1:  'Monthly Premium',
      member2:  'Monthly Basic',
      member3:  'Quarterly',
      member13: 'Monthly Basic',
      member15: 'Annual',
    },
  },

  // ── VITALITYFIT ─────────────────────────────────────────────────────────────
  VITALITYFIT: {
    gym: {
      name:            'Vitality Fit Studio',
      description:     'Lahore\'s premium ladies-only fitness destination. Pilates, Zumba, aerial yoga, and luxury spa facilities in a serene, all-women environment.',
      contactPhone:    '+923211234567',
      contactEmail:    'info@vitalityfit.com',
      website:         'https://vitalityfit.com',
      genderType:      'FEMALE_ONLY',
      socialLinksJson: { instagram: 'https://instagram.com/vitalityfitstudio', facebook: 'https://facebook.com/vitalityfit' },
    },
    branches: [
      {
        branchName:   'Vitality Fit DHA Lahore',
        address:      'Block D, DHA Phase 4, Lahore',
        cityName:     'Lahore',
        areaName:     'DHA Phase 4',
        latitude:     31.47715,
        longitude:    74.40395,
        openingTime:  '06:00:00',
        closingTime:  '22:00:00',
        phone:        '+923211234567',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Cafe', 'Sauna', 'Spa', 'Yoga Studio', 'Aerial Rig'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
      {
        branchName:   'Vitality Fit Gulberg',
        address:      'Main Boulevard, Gulberg III, Lahore',
        cityName:     'Lahore',
        areaName:     'Gulberg III',
        latitude:     31.51620,
        longitude:    74.35580,
        openingTime:  '07:00:00',
        closingTime:  '21:00:00',
        phone:        '+923211234577',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Cafe', 'Yoga Studio', 'Spinning'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
    ],
    plans: [
      { name: 'Drop-in Class',     durationType: 'DAILY',     durationValue: 1,  price: 800,   joiningFee: 0,    isTrial: false },
      { name: 'Monthly Starter',   durationType: 'MONTHLY',   durationValue: 1,  price: 6000,  joiningFee: 1000, isTrial: false },
      { name: 'Monthly Premium',   durationType: 'MONTHLY',   durationValue: 1,  price: 10000, joiningFee: 1000, isTrial: false },
      { name: 'Quarterly Premium', durationType: 'QUARTERLY', durationValue: 3,  price: 27000, joiningFee: 1000, isTrial: false },
      { name: 'Yearly Premium',    durationType: 'YEARLY',    durationValue: 12, price: 90000, joiningFee: 2000, isTrial: false },
      { name: 'Free Trial Week',   durationType: 'DAILY',     durationValue: 7,  price: 0,     joiningFee: 0,    isTrial: true  },
    ],
    trainers: [
      { fullName: 'Amna Rehan',    specialization: 'Pilates & Yoga',     bio: 'STOTT Pilates certified instructor with 7 years of teaching experience. RYT-500 yoga teacher.', yearsExperience: 7, certifications: ['STOTT Pilates', 'RYT-500'], ratingAvg: 4.9 },
      { fullName: 'Sadia Awan',    specialization: 'Zumba & Dance Fitness', bio: 'Licensed Zumba instructor and choreographer. Makes every class a party!',                 yearsExperience: 5, certifications: ['Zumba License', 'AFAA Group Fitness'], ratingAvg: 4.8 },
      { fullName: 'Mariam Sheikh', specialization: 'Personal Training & HIIT', bio: 'NASM-certified personal trainer specializing in fat loss and body composition.',         yearsExperience: 4, certifications: ['NASM CPT', 'TRX Certified', 'Nutrition Coach'], ratingAvg: 4.7 },
    ],
    staff: [
      { designation: 'Studio Manager',  fullName: 'Rida Khan' },
      { designation: 'Receptionist',    fullName: 'Aliza Butt' },
    ],
    memberKeys: ['member4', 'member5', 'member6', 'member12'],
    memberPlans: {
      member4:  'Quarterly Premium',
      member5:  'Monthly Premium',
      member6:  'Monthly Starter',
      member12: 'Yearly Premium',
    },
  },

  // ── POWERZONE ───────────────────────────────────────────────────────────────
  POWERZONE: {
    gym: {
      name:            'PowerZone Gym',
      description:     'Rawalpindi\'s premier strength, conditioning, and combat sports facility. Heavy iron, Olympic lifting, MMA, boxing, and a fully-equipped fight gym.',
      contactPhone:    '+923451234567',
      contactEmail:    'info@powerzonegym.pk',
      website:         'https://powerzonegym.pk',
      genderType:      'MIXED',
      socialLinksJson: { instagram: 'https://instagram.com/powerzonepk', facebook: 'https://facebook.com/powerzone' },
    },
    branches: [
      {
        branchName:   'PowerZone DHA Rawalpindi',
        address:      'Main Boulevard, DHA Phase 2, Rawalpindi',
        cityName:     'Rawalpindi',
        areaName:     'DHA Rawalpindi',
        latitude:     33.53260,
        longitude:    73.10570,
        openingTime:  '05:00:00',
        closingTime:  '23:00:00',
        phone:        '+923451234567',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Boxing Ring', 'MMA Cage', 'Wrestling Mat', 'Cafe', 'CCTV'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
      {
        branchName:   'PowerZone Bahria Town',
        address:      'Sector C, Bahria Town Phase 4, Rawalpindi',
        cityName:     'Rawalpindi',
        areaName:     'Bahria Town Phase 4',
        latitude:     33.52400,
        longitude:    73.17000,
        openingTime:  '06:00:00',
        closingTime:  '22:00:00',
        phone:        '+923451234577',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Boxing Ring', 'CCTV'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
    ],
    plans: [
      { name: 'Day Pass',              durationType: 'DAILY',     durationValue: 1,  price: 400,   joiningFee: 0,    isTrial: false },
      { name: 'Monthly General',       durationType: 'MONTHLY',   durationValue: 1,  price: 4000,  joiningFee: 500,  isTrial: false },
      { name: 'Monthly Fighter',       durationType: 'MONTHLY',   durationValue: 1,  price: 6500,  joiningFee: 500,  isTrial: false },
      { name: 'Quarterly General',     durationType: 'QUARTERLY', durationValue: 3,  price: 10000, joiningFee: 500,  isTrial: false },
      { name: 'Quarterly Fighter',     durationType: 'QUARTERLY', durationValue: 3,  price: 17000, joiningFee: 500,  isTrial: false },
      { name: 'Annual All-Access',     durationType: 'YEARLY',    durationValue: 12, price: 55000, joiningFee: 1000, isTrial: false },
      { name: '2-Day Trial',           durationType: 'DAILY',     durationValue: 2,  price: 0,     joiningFee: 0,    isTrial: true  },
    ],
    trainers: [
      { fullName: 'Umer Shahzad',    specialization: 'MMA & Combat Sports', bio: 'Former national MMA champion. Head coach with 10 years of professional fighting and coaching.', yearsExperience: 10, certifications: ['MMA Pakistan Coach License', 'BJJ Blue Belt'], ratingAvg: 4.9 },
      { fullName: 'Tariq Bashir',    specialization: 'Boxing',              bio: 'Ex-Pakistan national boxing team member. PAF Sports Complex certified boxing coach.',           yearsExperience: 8,  certifications: ['AIBA Certified Coach', 'PAF Boxing'], ratingAvg: 4.8 },
      { fullName: 'Rizwan Malik',    specialization: 'Powerlifting',         bio: 'IPF affiliated coach. Specializes in raw powerlifting and strength periodization.',            yearsExperience: 6,  certifications: ['IPF Level 1', 'CSCS'], ratingAvg: 4.6 },
    ],
    staff: [
      { designation: 'Gym Manager',  fullName: 'Shahid Iqbal' },
      { designation: 'Receptionist', fullName: 'Wajid Ali' },
    ],
    memberKeys: ['member7', 'member14'],
    memberPlans: {
      member7:  'Monthly Fighter',
      member14: 'Quarterly General',
    },
  },

  // ── FITLIFE ─────────────────────────────────────────────────────────────────
  FITLIFE: {
    gym: {
      name:            'FitLife Studio',
      description:     'Islamabad\'s most luxurious women-only fitness studio. Yoga, spinning, HIIT, and exclusive spa services in the heart of F-8.',
      contactPhone:    '+923361234567',
      contactEmail:    'info@fitlifestudio.pk',
      website:         'https://fitlifestudio.pk',
      genderType:      'FEMALE_ONLY',
      socialLinksJson: { instagram: 'https://instagram.com/fitlifepk', facebook: 'https://facebook.com/fitlifestudio' },
    },
    branches: [
      {
        branchName:   'FitLife F-8 Islamabad',
        address:      'F-8 Markaz, Near Centaurus, Islamabad',
        cityName:     'Islamabad',
        areaName:     'F-8',
        latitude:     33.70756,
        longitude:    73.04941,
        openingTime:  '06:30:00',
        closingTime:  '21:30:00',
        phone:        '+923361234567',
        facilitiesJson: ['AC', 'Parking', 'Shower', 'Locker', 'Wifi', 'Cafe', 'Sauna', 'Spa', 'Yoga Studio', 'Spinning Studio'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
    ],
    plans: [
      { name: 'Single Session',    durationType: 'DAILY',     durationValue: 1,  price: 1000,  joiningFee: 0,    isTrial: false },
      { name: 'Monthly Wellness',  durationType: 'MONTHLY',   durationValue: 1,  price: 8000,  joiningFee: 1500, isTrial: false },
      { name: 'Monthly Premium',   durationType: 'MONTHLY',   durationValue: 1,  price: 13000, joiningFee: 1500, isTrial: false },
      { name: 'Quarterly',         durationType: 'QUARTERLY', durationValue: 3,  price: 33000, joiningFee: 1500, isTrial: false },
      { name: 'Annual',            durationType: 'YEARLY',    durationValue: 12, price: 110000, joiningFee: 2000, isTrial: false },
      { name: 'Starter Trial',     durationType: 'DAILY',     durationValue: 5,  price: 0,     joiningFee: 0,    isTrial: true  },
    ],
    trainers: [
      { fullName: 'Nida Imran',    specialization: 'Yoga & Mindfulness',  bio: 'RYT-200 certified yoga instructor. Specializes in Hatha and Vinyasa flow with a focus on holistic well-being.', yearsExperience: 6, certifications: ['RYT-200', 'Meditation Coach'], ratingAvg: 4.9 },
      { fullName: 'Saira Bano',    specialization: 'HIIT & Functional Fitness', bio: 'NASM-CPT with expertise in high-intensity training and post-natal fitness recovery.',                    yearsExperience: 5, certifications: ['NASM CPT', 'Pre/Post Natal Fitness'], ratingAvg: 4.8 },
    ],
    staff: [
      { designation: 'Studio Manager', fullName: 'Iqra Zahid' },
      { designation: 'Receptionist',   fullName: 'Huma Naeem' },
    ],
    memberKeys: ['member8', 'member9'],
    memberPlans: {
      member8: 'Monthly Premium',
      member9: 'Monthly Wellness',
    },
  },

  // ── CHAMPIONS ───────────────────────────────────────────────────────────────
  CHAMPIONS: {
    gym: {
      name:            'Champions Athletic Club',
      description:     'Faisalabad\'s home of combat sports and strength training. Mixed martial arts, boxing, wrestling, and general fitness coaching by experienced professionals.',
      contactPhone:    '+923121234567',
      contactEmail:    'info@champions.pk',
      website:         'https://champions.pk',
      genderType:      'MIXED',
      socialLinksJson: { instagram: 'https://instagram.com/championsathleticclub', facebook: 'https://facebook.com/champions.fsd' },
    },
    branches: [
      {
        branchName:   'Champions Peoples Colony',
        address:      'Street 12, Block A, Peoples Colony, Faisalabad',
        cityName:     'Faisalabad',
        areaName:     'Peoples Colony',
        latitude:     31.41500,
        longitude:    73.07400,
        openingTime:  '05:30:00',
        closingTime:  '22:30:00',
        phone:        '+923121234567',
        facilitiesJson: ['Parking', 'Shower', 'Locker', 'Boxing Ring', 'Wrestling Mat', 'MMA Cage', 'CCTV'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
      {
        branchName:   'Champions Madina Town',
        address:      'Block C-1, Madina Town, Faisalabad',
        cityName:     'Faisalabad',
        areaName:     'Madina Town',
        latitude:     31.43900,
        longitude:    73.10500,
        openingTime:  '06:00:00',
        closingTime:  '22:00:00',
        phone:        '+923121234577',
        facilitiesJson: ['Parking', 'Shower', 'Locker', 'Boxing Ring'],
        imagesJson:   [],
        status:       'ACTIVE',
      },
    ],
    plans: [
      { name: 'Day Pass',              durationType: 'DAILY',     durationValue: 1,  price: 300,   joiningFee: 0,    isTrial: false },
      { name: 'Monthly General',       durationType: 'MONTHLY',   durationValue: 1,  price: 3000,  joiningFee: 300,  isTrial: false },
      { name: 'Monthly Martial Arts',  durationType: 'MONTHLY',   durationValue: 1,  price: 5500,  joiningFee: 300,  isTrial: false },
      { name: 'Quarterly',             durationType: 'QUARTERLY', durationValue: 3,  price: 13000, joiningFee: 300,  isTrial: false },
      { name: 'Annual',                durationType: 'YEARLY',    durationValue: 12, price: 44000, joiningFee: 500,  isTrial: false },
      { name: '1-Day Free Trial',      durationType: 'DAILY',     durationValue: 1,  price: 0,     joiningFee: 0,    isTrial: true  },
    ],
    trainers: [
      { fullName: 'Asif Khan',      specialization: 'Boxing & Kickboxing',  bio: 'Former Punjab provincial boxing champion. 12 years of coaching amateur and professional fighters.', yearsExperience: 12, certifications: ['AIBA Coach', 'WKF Kickboxing'], ratingAvg: 4.9 },
      { fullName: 'Nadeem Akhtar',  specialization: 'Wrestling & Grappling', bio: 'National-level freestyle wrestler turned coach. Expert in takedowns, throws, and ground control.', yearsExperience: 9, certifications: ['UWW Coach', 'BJJ Blue Belt'], ratingAvg: 4.7 },
      { fullName: 'Shoaib Dar',     specialization: 'Strength & Conditioning', bio: 'S&C coach for Faisalabad-based cricket and football academies. NSCA-CSCS certified.',               yearsExperience: 5, certifications: ['NSCA-CSCS', 'FMS Level 2'], ratingAvg: 4.6 },
    ],
    staff: [
      { designation: 'Club Manager',  fullName: 'Irfan Saleem' },
      { designation: 'Receptionist',  fullName: 'Danish Maqbool' },
    ],
    memberKeys: ['member10', 'member11'],
    memberPlans: {
      member10: 'Monthly Martial Arts',
      member11: 'Monthly General',
    },
  },
};

// Member profiles (health data keyed by user email)
const MEMBER_PROFILES = {
  'ali.hassan@example.com':     { gender: 'MALE',   dateOfBirth: '1995-03-15', heightCm: 178, weightKg: 82, fitnessGoal: 'Build muscle and increase strength', emergencyContactName: 'Hassan Ali',   emergencyContactPhone: '+923009002001' },
  'fatima.z@example.com':       { gender: 'FEMALE', dateOfBirth: '1997-07-22', heightCm: 162, weightKg: 58, fitnessGoal: 'Lose weight and tone body',          emergencyContactName: 'Zahra Fatima', emergencyContactPhone: '+923009002002' },
  'omar.farooq@example.com':    { gender: 'MALE',   dateOfBirth: '1993-11-08', heightCm: 183, weightKg: 91, fitnessGoal: 'Powerlifting competition prep',      emergencyContactName: 'Farooq Omar',  emergencyContactPhone: '+923009002003' },
  'ayesha.noor@example.com':    { gender: 'FEMALE', dateOfBirth: '1999-04-30', heightCm: 158, weightKg: 52, fitnessGoal: 'General wellness and flexibility',    emergencyContactName: 'Noor Ayesha',  emergencyContactPhone: '+923009002004' },
  'bilal.c@example.com':        { gender: 'MALE',   dateOfBirth: '1996-09-12', heightCm: 175, weightKg: 79, fitnessGoal: 'Lean muscle gain',                   emergencyContactName: 'Chaudhry Bilal', emergencyContactPhone: '+923009002005' },
  'hira.sheikh@example.com':    { gender: 'FEMALE', dateOfBirth: '2000-01-18', heightCm: 160, weightKg: 55, fitnessGoal: 'Zumba and dance fitness',             emergencyContactName: 'Sheikh Hira',  emergencyContactPhone: '+923009002006' },
  'kamran.baig@example.com':    { gender: 'MALE',   dateOfBirth: '1990-06-25', heightCm: 180, weightKg: 95, fitnessGoal: 'MMA and combat sports',               emergencyContactName: 'Baig Kamran',  emergencyContactPhone: '+923009002007' },
  'sana.iqbal@example.com':     { gender: 'FEMALE', dateOfBirth: '1998-12-03', heightCm: 164, weightKg: 60, fitnessGoal: 'Yoga and mind-body balance',          emergencyContactName: 'Iqbal Sana',   emergencyContactPhone: '+923009002008' },
  'tariq.m@example.com':        { gender: 'MALE',   dateOfBirth: '1994-05-17', heightCm: 172, weightKg: 74, fitnessGoal: 'Cardio fitness and weight loss',      emergencyContactName: 'Mehmood Tariq', emergencyContactPhone: '+923009002009' },
  'zara.q@example.com':         { gender: 'FEMALE', dateOfBirth: '2001-08-09', heightCm: 157, weightKg: 50, fitnessGoal: 'Martial arts — beginners karate',     emergencyContactName: 'Qureshi Zara', emergencyContactPhone: '+923009002010' },
  'hamza.raza@example.com':     { gender: 'MALE',   dateOfBirth: '1992-02-14', heightCm: 185, weightKg: 100, fitnessGoal: 'Boxing competition training',        emergencyContactName: 'Raza Hamza',   emergencyContactPhone: '+923009002011' },
  'mahnoor.b@example.com':      { gender: 'FEMALE', dateOfBirth: '1999-10-27', heightCm: 165, weightKg: 62, fitnessGoal: 'Pilates and core strength',           emergencyContactName: 'Butt Mahnoor', emergencyContactPhone: '+923009002012' },
  'asad.javed@example.com':     { gender: 'MALE',   dateOfBirth: '1991-07-04', heightCm: 176, weightKg: 85, fitnessGoal: 'Bodybuilding competition',            emergencyContactName: 'Javed Asad',   emergencyContactPhone: '+923009002013' },
  'rimsha.anwar@example.com':   { gender: 'FEMALE', dateOfBirth: '2000-03-21', heightCm: 161, weightKg: 57, fitnessGoal: 'HIIT and functional fitness',         emergencyContactName: 'Anwar Rimsha', emergencyContactPhone: '+923009002014' },
  'waqar.shah@example.com':     { gender: 'MALE',   dateOfBirth: '1994-11-16', heightCm: 179, weightKg: 88, fitnessGoal: 'Annual training — stay fit and strong', emergencyContactName: 'Shah Waqar', emergencyContactPhone: '+923009002015' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Core seeding function for a single tenant
// ─────────────────────────────────────────────────────────────────────────────

async function seedTenant(tenant, platformUsers, cityMap, areaMap) {
  const code = tenant.tenantCode;
  const def  = TENANT_SEEDS[code];

  if (!def) {
    console.log(`  ⚠️  No seed definition found for ${code} — skipping`);
    return;
  }

  // Decrypt and connect to tenant DB
  const connUrl = decrypt(tenant.connectionStringEncrypted);
  const seq = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging:  false,
    pool: { max: 5, min: 0, acquire: 30000, idle: 10000 },
    define: { underscored: true, timestamps: true },
  });

  try {
    await seq.authenticate();
    const M = registerTenantModels(seq);
    await seq.sync({ alter: true });

    // ── 1. Gym ──────────────────────────────────────────────────────────────
    let [gym] = await M.Gym.findOrCreate({
      where:    { name: def.gym.name },
      defaults: def.gym,
    });

    // ── 2. Branches ─────────────────────────────────────────────────────────
    const branchMap = {};
    for (const b of def.branches) {
      const cityId = cityMap[b.cityName];
      const areaId = areaMap[`${b.cityName}::${b.areaName}`];

      const { cityName, areaName, ...branchData } = b;
      const [branch] = await M.Branch.findOrCreate({
        where:    { gymId: gym.id, branchName: b.branchName },
        defaults: { ...branchData, gymId: gym.id, cityId, areaId },
      });
      branchMap[b.branchName] = branch;
    }
    const primaryBranch = Object.values(branchMap)[0];

    // ── 3. Membership Plans ─────────────────────────────────────────────────
    const planMap = {};
    for (const p of def.plans) {
      const [plan] = await M.MembershipPlan.findOrCreate({
        where:    { gymId: gym.id, name: p.name },
        defaults: {
          gymId:           gym.id,
          branchId:        null,
          name:            p.name,
          durationType:    p.durationType,
          durationValue:   p.durationValue,
          price:           p.price,
          joiningFee:      p.joiningFee || 0,
          securityFee:     0,
          visitLimit:      null,
          freezeLimitDays: p.durationType === 'YEARLY' ? 30 : p.durationType === 'QUARTERLY' ? 15 : 7,
          isTrial:         p.isTrial,
          status:          'ACTIVE',
        },
      });
      planMap[p.name] = plan;
    }

    // ── 4. Trainers ─────────────────────────────────────────────────────────
    for (const t of def.trainers) {
      const trainerUser = platformUsers.find(u => u.fullName === t.fullName);
      const userId = trainerUser ? trainerUser.id : uuidv4();

      await M.Trainer.findOrCreate({
        where:    { userId },
        defaults: {
          userId,
          branchId:             primaryBranch.id,
          specialization:       t.specialization,
          bio:                  t.bio,
          yearsExperience:      t.yearsExperience,
          certificationsJson:   t.certifications,
          availabilityJson: {
            monday:    { available: true,  start: '09:00', end: '17:00' },
            tuesday:   { available: true,  start: '09:00', end: '17:00' },
            wednesday: { available: true,  start: '09:00', end: '17:00' },
            thursday:  { available: true,  start: '09:00', end: '17:00' },
            friday:    { available: true,  start: '09:00', end: '15:00' },
            saturday:  { available: true,  start: '10:00', end: '14:00' },
            sunday:    { available: false },
          },
          ratingAvg: t.ratingAvg,
          status:    'ACTIVE',
        },
      });
    }

    // ── 5. GymStaff ─────────────────────────────────────────────────────────
    for (const s of def.staff) {
      const staffUser = platformUsers.find(u => u.fullName === s.fullName);
      const userId = staffUser ? staffUser.id : uuidv4();

      await M.GymStaff.findOrCreate({
        where:    { userId, branchId: primaryBranch.id },
        defaults: {
          branchId:         primaryBranch.id,
          userId,
          designation:      s.designation,
          employmentStatus: 'ACTIVE',
        },
      });
    }

    // ── 6. MemberProfiles + Subscriptions + Payments + Invoices ────────────
    let invoiceCounter = 1;

    for (const memberKey of def.memberKeys) {
      const memberUser = platformUsers.find(u => u.email === SEED_USERS_EMAIL_MAP[memberKey]);
      if (!memberUser) continue;

      const profileData = MEMBER_PROFILES[memberUser.email];
      if (profileData) {
        await M.MemberProfile.findOrCreate({
          where:    { userId: memberUser.id },
          defaults: { ...profileData, userId: memberUser.id },
        });
      }

      const planName = def.memberPlans[memberKey];
      const plan     = planMap[planName];
      if (!plan) continue;

      const startDate  = daysAgo(randomBetween(60, 150));
      const endDate    = new Date(startDate);

      if (plan.durationType === 'DAILY')     endDate.setDate(endDate.getDate() + plan.durationValue);
      if (plan.durationType === 'MONTHLY')   endDate.setMonth(endDate.getMonth() + plan.durationValue);
      if (plan.durationType === 'QUARTERLY') endDate.setMonth(endDate.getMonth() + plan.durationValue * 3);
      if (plan.durationType === 'YEARLY')    endDate.setFullYear(endDate.getFullYear() + plan.durationValue);

      const totalAmount = plan.price + plan.joiningFee;

      const subStatus = endDate < new Date() ? 'EXPIRED' : 'ACTIVE';

      const [sub, subCreated] = await M.MemberSubscription.findOrCreate({
        where: { userId: memberUser.id, membershipPlanId: plan.id },
        defaults: {
          userId:           memberUser.id,
          branchId:         primaryBranch.id,
          membershipPlanId: plan.id,
          startDate:        dateOnly(startDate),
          endDate:          dateOnly(endDate),
          status:           subStatus,
          autoRenew:        false,
          qrCode:           `GE-${memberUser.id.replace(/-/g, '').toUpperCase()}`,
          subscribedAt:     startDate,
          sourceChannel:    'WALK_IN',
          remainingVisits:  null,
        },
      });

      // Sync Platform DB cross-tenant index with the real MemberSubscription UUID.
      // seed.js uses uuidv4() as a placeholder — overwrite it here with the actual sub.id.
      await UserGymMembership.update(
        { subscriptionId: sub.id, status: subStatus, startDate: dateOnly(startDate), endDate: dateOnly(endDate), planName: plan.name },
        { where: { userId: memberUser.id, tenantId: tenant.id } }
      );

      if (subCreated && plan.price > 0) {
        // Payment
        const paidAt = new Date(startDate);
        paidAt.setHours(paidAt.getHours() + 1);

        const payment = await M.Payment.create({
          userId:              memberUser.id,
          paymentFor:          'MEMBERSHIP',
          referenceEntityId:   sub.id,
          method:              'CASH',
          amount:              totalAmount,
          currency:            'PKR',
          status:              'COMPLETED',
          paidAt,
        });

        // Invoice
        const invoiceNo = makeInvoiceNo(code, invoiceCounter++);
        await M.Invoice.create({
          userId:            memberUser.id,
          invoiceNo,
          invoiceType:       'MEMBERSHIP',
          referenceEntityId: sub.id,
          subtotal:          plan.price,
          discountAmount:    0,
          taxAmount:         0,
          totalAmount,
          dueDate:           dateOnly(startDate),
          paidAt,
          status:            'PAID',
        });
      }

      // ── 7. Attendance Logs (last 90 days, ~4–5x per week) ─────────────────
      if (subStatus === 'ACTIVE' && subCreated) {
        for (let i = 89; i >= 0; i--) {
          if (randomBetween(1, 7) <= 2) continue; // ~72% attendance rate

          const checkIn = daysAgo(i);
          checkIn.setHours(randomBetween(6, 20), randomBetween(0, 59), 0, 0);
          const checkOut = new Date(checkIn);
          checkOut.setMinutes(checkOut.getMinutes() + randomBetween(45, 120));

          await M.AttendanceLog.create({
            branchId:             primaryBranch.id,
            userId:               memberUser.id,
            memberSubscriptionId: sub.id,
            attendanceType:       'CHECK_IN',
            checkInAt:            checkIn,
            checkOutAt:           checkOut,
            entryMethod:          randomBetween(0, 1) === 0 ? 'QR_SCAN' : 'MANUAL',
          });
        }
      }
    }

    console.log(`  ✅  ${code}: Gym, ${def.branches.length} branch(es), ${def.plans.length} plans, ${def.trainers.length} trainers, ${def.memberKeys.length} members seeded`);
  } finally {
    await seq.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email → key map (used for member lookups)
// ─────────────────────────────────────────────────────────────────────────────

const SEED_USERS_EMAIL_MAP = {
  member1:  'ali.hassan@example.com',
  member2:  'fatima.z@example.com',
  member3:  'omar.farooq@example.com',
  member4:  'ayesha.noor@example.com',
  member5:  'bilal.c@example.com',
  member6:  'hira.sheikh@example.com',
  member7:  'kamran.baig@example.com',
  member8:  'sana.iqbal@example.com',
  member9:  'tariq.m@example.com',
  member10: 'zara.q@example.com',
  member11: 'hamza.raza@example.com',
  member12: 'mahnoor.b@example.com',
  member13: 'asad.javed@example.com',
  member14: 'rimsha.anwar@example.com',
  member15: 'waqar.shah@example.com',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const targetCode = process.argv[2]?.toUpperCase() || null;

  console.log('🏋️   GymsEra Tenant DB Seeder\n');

  try {
    await initPlatformDb();
    console.log('✅  Platform DB connected\n');

    // Load all platform users
    const platformUsers = await User.findAll();
    console.log(`   Loaded ${platformUsers.length} platform users\n`);

    // Build city + area lookup maps
    const allCities = await City.findAll();
    const allAreas  = await Area.findAll();

    const cityMap = {};
    for (const c of allCities) cityMap[c.name] = c.id;

    const areaMap = {};
    for (const a of allAreas) {
      const city = allCities.find(c => c.id === a.cityId);
      if (city) areaMap[`${city.name}::${a.name}`] = a.id;
    }

    // Find approved tenants
    const whereClause = {
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
    };
    if (targetCode) whereClause.tenantCode = targetCode;

    const tenants = await Tenant.findAll({ where: whereClause });

    if (tenants.length === 0) {
      console.log('⚠️  No approved tenants found. Run seed.js and provision-seeded-tenants.js first.');
      process.exit(0);
    }

    const unprovisioned = tenants.filter(t => t.connectionStringEncrypted === 'PENDING_PROVISIONING');
    if (unprovisioned.length > 0) {
      console.log(`⚠️  ${unprovisioned.length} tenant(s) not yet provisioned: ${unprovisioned.map(t => t.tenantCode).join(', ')}`);
      console.log('   Run: node src/scripts/provision-seeded-tenants.js\n');
      process.exit(1);
    }

    const ready = tenants.filter(t => t.connectionStringEncrypted !== 'PENDING_PROVISIONING');
    console.log(`📋  Seeding ${ready.length} tenant(s): ${ready.map(t => t.tenantCode).join(', ')}\n`);

    for (const tenant of ready) {
      console.log(`🔧  Seeding ${tenant.tenantCode}...`);
      await seedTenant(tenant, platformUsers, cityMap, areaMap);
    }

    console.log('\n✅  Tenant seeding complete!\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌  Tenant seeder failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
