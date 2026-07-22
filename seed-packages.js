/**
 * Minimal one-shot script to seed platform packages.
 * Run from gymsera_be root: node seed-packages.js
 */
require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(
  process.env.PLATFORM_DB_NAME || 'gymsera_platform',
  process.env.PLATFORM_DB_USER || 'root',
  process.env.PLATFORM_DB_PASS || '',
  {
    host:    process.env.PLATFORM_DB_HOST || 'localhost',
    port:    parseInt(process.env.PLATFORM_DB_PORT || '3306', 10),
    dialect: 'mysql',
    logging: false,
  }
);

const PlatformPackage = sequelize.define('PlatformPackage', {
  id:           { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name:         { type: DataTypes.STRING(100), allowNull: false },
  description:  { type: DataTypes.TEXT, allowNull: true },
  price:        { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  billingCycle: { type: DataTypes.ENUM('MONTHLY', 'QUARTERLY', 'YEARLY'), allowNull: false, defaultValue: 'MONTHLY' },
  maxOrganizations: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  maxBranches:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  maxTrainers:  { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
  maxMembers:   { type: DataTypes.INTEGER, allowNull: false, defaultValue: 200 },
  featureFlagsJson: { type: DataTypes.JSON, allowNull: true },
  status:       { type: DataTypes.ENUM('ACTIVE', 'INACTIVE'), allowNull: false, defaultValue: 'ACTIVE' },
}, {
  tableName: 'platform_packages',  // must match the real model exactly
  underscored: true,               // columns are snake_case in DB
  timestamps: true,
  indexes: [{ fields: ['status'] }],
});

const PACKAGES = [
  {
    name: 'Starter',
    description: 'Perfect for a single-branch gym just getting started.',
    price: 4999.00,
    billingCycle: 'MONTHLY',
    maxOrganizations: 1,
    maxBranches: 1,
    maxTrainers: 5,
    maxMembers: 150,
    featureFlagsJson: { attendance: true, memberships: true, payments: true, qrCheckin: true },
    status: 'ACTIVE',
  },
  {
    name: 'Professional',
    description: 'For growing gyms. Multi-branch support and advanced analytics.',
    price: 9999.00,
    billingCycle: 'MONTHLY',
    maxOrganizations: 2,
    maxBranches: 3,
    maxTrainers: 20,
    maxMembers: 500,
    featureFlagsJson: { attendance: true, memberships: true, payments: true, trainers: true, advancedReports: true, qrCheckin: true, smsNotifications: true },
    status: 'ACTIVE',
  },
  {
    name: 'Enterprise',
    description: 'For large gym chains. Full feature set, priority support.',
    price: 24999.00,
    billingCycle: 'MONTHLY',
    maxOrganizations: 5,
    maxBranches: 10,
    maxTrainers: 100,
    maxMembers: 5000,
    featureFlagsJson: { attendance: true, memberships: true, payments: true, trainers: true, advancedReports: true, qrCheckin: true, smsNotifications: true, prioritySupport: true, customBranding: true, apiAccess: true },
    status: 'ACTIVE',
  },
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✓ Connected to database');

    // Create/update the PlatformPackages table to match the model definition.
    await PlatformPackage.sync({ alter: true });
    console.log('✓ Table synced');

    let created = 0;
    for (const pkg of PACKAGES) {
      const [record, wasCreated] = await PlatformPackage.findOrCreate({
        where: { name: pkg.name },
        defaults: pkg,
      });
      if (wasCreated) {
        console.log(`  ✓ Created package: ${pkg.name} (id: ${record.id})`);
        created++;
      } else {
        console.log(`  – Already exists: ${pkg.name} (id: ${record.id})`);
      }
    }

    console.log(`\nDone. ${created} new package(s) created.`);
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message || err);
    console.error('Detail:', err);
    process.exit(1);
  }
})();
