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
 * Migrations below are expected to fail with a "duplicate column" /
 * "already exists"-style error on every boot after the first — that's
 * normal and stays silent. Any OTHER failure (wrong privileges, an FK
 * blocking a MODIFY, a syntax difference on this MySQL version) must not
 * vanish the way it used to: a swallowed failure here once left
 * platform_package_id NOT NULL for weeks with zero signal, until a real
 * purchase hit it in production.
 */
const _logIfUnexpected = (label, err) => {
  const msg = (err.original?.sqlMessage || err.message || '').toLowerCase();
  const benign = msg.includes('duplicate column') || msg.includes('duplicate key name') || msg.includes('already exists');
  if (!benign) console.warn(`[Platform DB] Migration step "${label}" failed unexpectedly:`, err.original?.sqlMessage || err.message);
};

/**
 * MySQL refuses a plain MODIFY COLUMN on a column that's part of a foreign
 * key ("Cannot change column 'x': used in a foreign key constraint") — seen
 * live on the platform_package_id column, which some deployments have an FK
 * on and some don't (it was added before FKs were consistently used here).
 * When that happens: look up the FK's exact definition (referenced table/
 * column, ON DELETE/ON UPDATE rules) via information_schema, drop it, apply
 * the column change, then recreate the FK identically — never regenerate it
 * with default rules, which would silently weaken referential integrity if
 * the original had CASCADE/SET NULL. If a database has no FK on this column
 * at all, the plain MODIFY just succeeds on the first try and none of this
 * runs.
 */
const _makeColumnNullableAroundForeignKey = async (sequelize, { table, column, columnType, logLabel }) => {
  const plainAlter = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${columnType} NULL;`;
  try {
    await sequelize.query(plainAlter);
    return;
  } catch (err) {
    const msg = err.original?.sqlMessage || err.message || '';
    if (!/foreign key constraint/i.test(msg)) {
      _logIfUnexpected(logLabel, err);
      return;
    }
  }

  // Column change failed because of an FK — find it and work around it.
  try {
    const [fkRows] = await sequelize.query(
      `SELECT kcu.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
              rc.UPDATE_RULE, rc.DELETE_RULE
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.COLUMN_NAME = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      { replacements: [table, column] }
    );

    if (fkRows.length === 0) {
      console.warn(`[Platform DB] Migration step "${logLabel}" failed with an FK error but no FK was found via information_schema — leaving as-is.`);
      return;
    }

    const fk = fkRows[0];
    await sequelize.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${fk.CONSTRAINT_NAME}\`;`);
    await sequelize.query(plainAlter);
    await sequelize.query(
      `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${fk.CONSTRAINT_NAME}\` FOREIGN KEY (\`${column}\`) ` +
        `REFERENCES \`${fk.REFERENCED_TABLE_NAME}\` (\`${fk.REFERENCED_COLUMN_NAME}\`) ` +
        `ON DELETE ${fk.DELETE_RULE} ON UPDATE ${fk.UPDATE_RULE};`
    );
    console.log(`[Platform DB] Migration step "${logLabel}" succeeded after dropping/recreating FK "${fk.CONSTRAINT_NAME}".`);
  } catch (err2) {
    console.error(
      `[Platform DB] Migration step "${logLabel}" failed while working around its foreign key — ` +
        `check whether the FK is still in place: ${err2.original?.sqlMessage || err2.message}`
    );
  }
};

/**
 * Authenticate and sync the platform database.
 * In development, uses `alter: true` to keep schema in sync with model changes.
 * In production, `sync` is a no-op — use migrations.
 */
const connect = async () => {
  await sequelize.authenticate();
  console.log('[Platform DB] Connected');

  // Ensure apple_id column exists on users table
  try {
    await sequelize.query('ALTER TABLE `users` ADD COLUMN `apple_id` VARCHAR(100) NULL;');
  } catch (err) {
    _logIfUnexpected('users.apple_id', err);
  }

  // Unbuilt branch capacity earmarked for an organization — see the comment
  // on GymListing.model.js#reservedSlots.
  try {
    await sequelize.query("ALTER TABLE `gym_listings` ADD COLUMN `reserved_slots` INT NOT NULL DEFAULT 0;");
  } catch (err) {
    _logIfUnexpected('gym_listings.reserved_slots', err);
  }

  // ── Billing: BillingPlan / BillingOffer tables + TenantSubscription's
  // store-verified-purchase columns. Additive and idempotent — safe to run on
  // every boot, in every environment, same as the block above. See
  // BillingPlan.model.js / BillingOffer.model.js / TenantSubscription.model.js
  // for what each column is for.
  //
  // The `id` columns below are pinned to utf8mb4_bin, matching exactly what
  // Sequelize generates for a DataTypes.UUID column (verified empirically —
  // it is NOT the table's default collation). A plain `CHAR(36)` here is
  // otherwise collation-incompatible with a `DataTypes.UUID` foreign key
  // column on another table's model-driven sync, and MySQL refuses to create
  // that FK ("... are incompatible"). Production never hits this (it never
  // calls sequelize.sync()), but any fresh dev/CI database bootstrapped via
  // sync({alter:true}) did, until this was pinned.
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS billing_plans (
        id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
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
        id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
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
  await _makeColumnNullableAroundForeignKey(sequelize, {
    table: 'tenant_subscriptions',
    column: 'platform_package_id',
    // Must match what Sequelize generates for a DataTypes.UUID column (see
    // the capacity_events/billing_plans note above) — a plain CHAR(36) here
    // silently drops the column back to the table's default collation on
    // every boot, which is how this was found: it left platform_package_id
    // collation-mismatched against platform_packages.id, invisible until
    // something tried to (re)create the FK against it via a stricter check.
    columnType: 'CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    logLabel: 'tenant_subscriptions.platform_package_id -> NULL',
  });
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

  // Set when a subscription downgrade leaves more real ACTIVE branches than
  // the new plan covers, after every unbuilt reservedSlots has already been
  // trimmed to zero — see subscription-quota.service.js#reconcileCapacity.
  // Real branches are NEVER auto-deleted to close this gap; it's surfaced to
  // the host instead and only new consumption (branches/restores) is blocked
  // until they upgrade or close branches themselves.
  try {
    await sequelize.query(
      'ALTER TABLE `tenant_subscriptions` ADD COLUMN `over_quota_count` INT NOT NULL DEFAULT 0;'
    );
  } catch (err) {
    _logIfUnexpected('tenant_subscriptions.over_quota_count', err);
  }

  // Append-only capacity audit/idempotency ledger — see CapacityEvent.model.js.
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS capacity_events (
        id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
        tenant_id CHAR(36) NOT NULL,
        listing_id CHAR(36) NULL,
        branch_id CHAR(36) NULL,
        action ENUM('BRANCH_DELETED','BRANCH_RESTORED','SLOT_TRANSFERRED','SLOT_TRIMMED_DOWNGRADE','SLOT_ATTRIBUTED_UPGRADE','SLOT_CONSUMED_BUILD','ORG_DELETED','ORG_BRANCHES_MOVED') NOT NULL,
        delta INT NOT NULL,
        reserved_slots_before INT NULL,
        reserved_slots_after INT NULL,
        actor_user_id CHAR(36) NULL,
        actor_type ENUM('HOST','ADMIN','SYSTEM') NOT NULL DEFAULT 'HOST',
        reason VARCHAR(255) NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE INDEX capacity_events_idempotency_key (idempotency_key),
        INDEX capacity_events_tenant_id (tenant_id),
        INDEX capacity_events_listing_id (listing_id)
      );
    `);
  } catch (err) {
    _logIfUnexpected('CREATE TABLE capacity_events', err);
  }
  // Widen the action ENUM if this table was already created (e.g. a local/
  // staging boot) before SLOT_CONSUMED_BUILD existed — CREATE TABLE IF NOT
  // EXISTS above never retroactively adds it.
  try {
    await sequelize.query(
      "ALTER TABLE `capacity_events` MODIFY COLUMN `action` ENUM('BRANCH_DELETED','BRANCH_RESTORED','SLOT_TRANSFERRED','SLOT_TRIMMED_DOWNGRADE','SLOT_ATTRIBUTED_UPGRADE','SLOT_CONSUMED_BUILD','ORG_DELETED','ORG_BRANCHES_MOVED') NOT NULL;"
    );
  } catch (err) {
    _logIfUnexpected('capacity_events.action widen ENUM', err);
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

module.exports = { sequelize, connect, _makeColumnNullableAroundForeignKey };
