const { Sequelize } = require('sequelize');
// Explicit require so Vercel's file tracer (nft) includes mysql2 in the bundle.
// Sequelize loads it dynamically based on dialect, which static analyzers miss.
require('mysql2');
const dbConfig = require('../config/database.config');

const { host, port, database, username, password } = dbConfig.platform;

const sequelize = new Sequelize(database, username, password, {
  host,
  port,
  dialect: 'mysql',
  logging: process.env.NODE_ENV === 'development' ? (sql) => console.log('[Platform DB]', sql) : false,
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions: {
    connectTimeout: 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  },
  define: {
    underscored: true,
    timestamps: true,
  },
});

/**
 * Authenticate and sync the platform database.
 * In development, uses `alter: true` to keep schema in sync with model changes.
 * In production, `sync` is a no-op — use migrations.
 */
const connect = async () => {
  await sequelize.authenticate();
  console.log('[Platform DB] Connected');

  // These migrations are expected to fail with a "duplicate column" /
  // "already exists"-style error on every boot after the first — that's
  // normal and stays silent. Any OTHER failure (wrong privileges, an FK
  // blocking a MODIFY, a syntax difference on this MySQL version) must not
  // vanish the way it used to: a swallowed failure here once left
  // platform_package_id NOT NULL for weeks with zero signal, until a real
  // purchase hit it in production.
  const _logIfUnexpected = (label, err) => {
    const msg = (err.original?.sqlMessage || err.message || '').toLowerCase();
    const benign = msg.includes('duplicate column') || msg.includes('duplicate key name') || msg.includes('already exists');
    if (!benign) console.warn(`[Platform DB] Migration step "${label}" failed unexpectedly:`, err.original?.sqlMessage || err.message);
  };

  // Ensure apple_id column exists on users table
  try {
    await sequelize.query('ALTER TABLE `users` ADD COLUMN `apple_id` VARCHAR(100) NULL;');
  } catch (err) {
    _logIfUnexpected('users.apple_id', err);
  }

  // ── Billing: BillingPlan / BillingOffer tables + TenantSubscription's
  // store-verified-purchase columns. Additive and idempotent — safe to run on
  // every boot, in every environment, same as the block above. See
  // BillingPlan.model.js / BillingOffer.model.js / TenantSubscription.model.js
  // for what each column is for.
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS billing_plans (
        id CHAR(36) NOT NULL PRIMARY KEY,
        branch_count INT NOT NULL,
        ios_monthly_product_id VARCHAR(150) NULL,
        ios_annual_product_id VARCHAR(150) NULL,
        android_product_id VARCHAR(150) NULL,
        android_monthly_base_plan_id VARCHAR(150) NULL,
        android_annual_base_plan_id VARCHAR(150) NULL,
        stripe_monthly_price_id VARCHAR(150) NULL,
        stripe_annual_price_id VARCHAR(150) NULL,
        monthly_price DECIMAL(12,2) NOT NULL,
        annual_price DECIMAL(12,2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'PKR',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        INDEX billing_plans_branch_count (branch_count),
        INDEX billing_plans_is_active (is_active)
      );
    `);
  } catch (err) {
    _logIfUnexpected('CREATE TABLE billing_plans', err);
  }
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS billing_offers (
        id CHAR(36) NOT NULL PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        description TEXT NULL,
        discount_type ENUM('PERCENTAGE','FIXED_AMOUNT','FREE_PERIOD') NOT NULL,
        discount_value DECIMAL(12,2) NOT NULL,
        applies_to_branch_min INT NULL,
        applies_to_branch_max INT NULL,
        platform ENUM('ALL','IOS','ANDROID','WEB') NOT NULL DEFAULT 'ALL',
        apple_offer_id VARCHAR(150) NULL,
        android_offer_id VARCHAR(150) NULL,
        stripe_coupon_id VARCHAR(150) NULL,
        valid_from DATETIME NULL,
        valid_until DATETIME NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        INDEX billing_offers_is_active (is_active),
        INDEX billing_offers_platform (platform)
      );
    `);
  } catch (err) {
    _logIfUnexpected('CREATE TABLE billing_offers', err);
  }
  try {
    await sequelize.query('ALTER TABLE `tenant_subscriptions` MODIFY COLUMN `platform_package_id` CHAR(36) NULL;');
  } catch (err) {
    _logIfUnexpected('tenant_subscriptions.platform_package_id -> NULL', err);
  }
  const tenantSubBillingColumns = [
    "ADD COLUMN `billing_plan_id` CHAR(36) NULL",
    "ADD COLUMN `platform` ENUM('MANUAL','IOS','ANDROID','STRIPE') NOT NULL DEFAULT 'MANUAL'",
    "ADD COLUMN `branch_count` INT NULL",
    "ADD COLUMN `product_id` VARCHAR(150) NULL",
    "ADD COLUMN `external_original_transaction_id` VARCHAR(150) NULL",
    "ADD COLUMN `external_transaction_id` VARCHAR(150) NULL",
    "ADD COLUMN `environment` ENUM('SANDBOX','PRODUCTION') NULL",
    "ADD COLUMN `last_verified_at` DATETIME NULL",
  ];
  for (const clause of tenantSubBillingColumns) {
    try {
      await sequelize.query(`ALTER TABLE \`tenant_subscriptions\` ${clause};`);
    } catch (err) {
      _logIfUnexpected(`tenant_subscriptions ${clause}`, err);
    }
  }
  try {
    await sequelize.query(
      'ALTER TABLE `tenant_subscriptions` ADD INDEX `tenant_subscriptions_external_original_transaction_id` (`external_original_transaction_id`);'
    );
  } catch (err) {
    _logIfUnexpected('tenant_subscriptions external_original_transaction_id index', err);
  }

  // Seed the branch-count pricing staircase — real production data, not
  // sample content, so this runs in every environment (unlike the dev-only
  // block below). Only ever inserts; never overwrites a row a human has
  // since edited (e.g. after correcting a price to what the store actually
  // accepted — see BillingPlan.model.js's per-platform product ID columns).
  try {
    const { BillingPlan } = require('../models/platform');
    const existing = await BillingPlan.count();
    if (existing === 0) {
      const iosAnnualPrices = {
        1: 47999, 2: 95900, 3: 144900, 4: 189999, 5: 239900,
        6: 289900, 7: 300000, 8: 300000, 9: 300000, 10: 300000,
      };
      const rows = [];
      for (let n = 1; n <= 10; n++) {
        rows.push({
          branchCount: n,
          iosMonthlyProductId: `branches_${n}_monthly`,
          iosAnnualProductId: `branches_${n}_annual`,
          monthlyPrice: n * 5000,
          annualPrice: iosAnnualPrices[n],
          currency: 'PKR',
          sortOrder: n,
        });
      }
      await BillingPlan.bulkCreate(rows);
      console.log('[Platform DB] Seeded billing_plans (branches 1-10, iOS product IDs).');
    }
  } catch (seedErr) {
    console.warn('[Platform DB] BillingPlan seed skipped:', seedErr.message);
  }

  if (process.env.NODE_ENV === 'development' && !process.env.VERCEL) {
    // Lazy-load models to ensure they're registered before sync
    require('../models/platform');
    await sequelize.sync({ alter: true });
    console.log('[Platform DB] Schema synced (development)');

    try {
      const { Tenant, GymListing, User, Conversation, Message } = require('../models/platform');
      const convCount = await Conversation.count();
      if (convCount === 0) {
        console.log('[Platform DB] Seeding initial conversations...');
        const users = await User.findAll({ where: { role: 'MEMBER' } });
        const tenants = await Tenant.findAll();
        
        const dummyConversations = [
          {
            type: 'MEMBER',
            messages: [
              { text: "Hey! Is the squat rack at the Warehouse location free around 5 PM? Looking to get a heavy session in.", senderType: 'USER' },
              { text: "Hi! Yes, the 5 PM slot is usually quiet on Tuesdays. We have three squat racks, so you should be good.", senderType: 'HOST' },
              { text: "Awesome. Do I need a new entry code or will my current one work?", senderType: 'USER' },
              { text: "Your current QR code will work fine. Valid for the next 30 days.", senderType: 'HOST' },
              { text: "Perfect. One more thing — can I bring a guest tomorrow?", senderType: 'USER' },
              { text: "Yes! Guests are welcome. Just register them at the reception with your member ID.", senderType: 'HOST' },
              { text: "Amazing, thanks! See you tomorrow.", senderType: 'USER' },
              { text: "See you then! Have a great workout 💪", senderType: 'HOST' }
            ]
          },
          {
            type: 'INQUIRY',
            messages: [
              { text: "Hi, I'm interested in joining. Do you offer student discounts on the Premium Monthly plan?", senderType: 'USER' },
              { text: "Hello! Yes, we offer a 15% discount for students with a valid student ID. You can register at the front desk.", senderType: 'HOST' },
              { text: "Regarding membership pause policy, what's the limit? Can I pause for 2 weeks?", senderType: 'USER' }
            ]
          },
          {
            type: 'MEMBER',
            messages: [
              { text: "Hey, my locker key isn't working today. Can someone help me at 5pm?", senderType: 'USER' }
            ]
          }
        ];

        if (users.length > 0 && tenants.length > 0) {
          for (const tenant of tenants) {
            const listings = await GymListing.findAll({ where: { tenantId: tenant.id } });
            for (const listing of listings) {
              if (!listing.branchId) continue;
              
              for (let i = 0; i < Math.min(dummyConversations.length, users.length); i++) {
                const user = users[i];
                const dummy = dummyConversations[i];
                
                const conversation = await Conversation.create({
                  tenantId: tenant.id,
                  branchId: listing.branchId,
                  userId: user.id,
                  type: dummy.type,
                  unreadCountHost: 0,
                  unreadCountUser: 0
                });

                let lastMsg = null;
                let unreadHost = 0;
                let unreadUser = 0;

                for (const msgData of dummy.messages) {
                  const senderId = msgData.senderType === 'USER' ? user.id : tenant.ownerUserId;
                  const createdMsg = await Message.create({
                    conversationId: conversation.id,
                    senderId: senderId || null,
                    senderType: msgData.senderType,
                    text: msgData.text,
                    isRead: false
                  });
                  lastMsg = createdMsg;

                  if (msgData.senderType === 'USER') {
                    unreadHost++;
                  } else if (msgData.senderType === 'HOST') {
                    unreadUser++;
                  }
                }

                if (lastMsg) {
                  await conversation.update({
                    lastMessageText: lastMsg.text,
                    lastMessageAt: lastMsg.createdAt,
                    unreadCountHost: unreadHost,
                    unreadCountUser: unreadUser
                  });
                }
              }
            }
          }
          console.log('[Platform DB] Auto-seeded conversations.');
        }
      }
    } catch (seedErr) {
      console.warn('[Platform DB] Auto-seed failed:', seedErr.message);
    }
  }
};

module.exports = { sequelize, connect };
