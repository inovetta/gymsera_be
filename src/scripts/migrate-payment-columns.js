/**
 * migrate-payment-columns.js
 *
 * One-time migration: adds new columns to the `payments` table in every
 * active tenant database. Safe to re-run.
 *
 * Run: node src/scripts/migrate-payment-columns.js
 */
require('dotenv').config();

const { Sequelize, QueryTypes } = require('sequelize');
const { decrypt } = require('../utils/crypto.utils');

const NEW_COLUMNS = [
  { name: 'created_by',         ddl: '`created_by` VARCHAR(36) NULL' },
  { name: 'created_by_role',    ddl: '`created_by_role` VARCHAR(30) NULL' },
  { name: 'branch_id',          ddl: '`branch_id` VARCHAR(36) NULL' },
  { name: 'staff_collected_by', ddl: '`staff_collected_by` VARCHAR(36) NULL' },
  { name: 'collected_at',       ddl: '`collected_at` DATETIME NULL' },
];

async function migrateTenant(gymName, connUrl) {
  const dbName = connUrl.replace(/\?.*$/, '').split('/').pop();

  const seq = new Sequelize(connUrl, {
    dialect: 'mysql',
    logging: false,
    dialectOptions: { connectTimeout: 20000 },
  });

  try {
    await seq.authenticate();

    const existing = await seq.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'payments'`,
      { replacements: [dbName], type: QueryTypes.SELECT }
    );
    const existingSet = new Set(existing.map((r) => r.COLUMN_NAME));

    const missing = NEW_COLUMNS.filter((c) => !existingSet.has(c.name));

    if (missing.length === 0) {
      console.log(`  ✅  ${gymName} — already up to date`);
    } else {
      for (const col of missing) {
        await seq.query(`ALTER TABLE payments ADD COLUMN ${col.ddl}`);
      }
      console.log(`  ✅  ${gymName} — added: ${missing.map((c) => c.name).join(', ')}`);
    }

    // Always ensure ENUM includes STAFF_COLLECTED
    await seq.query(
      `ALTER TABLE payments MODIFY COLUMN \`status\` ENUM('PENDING','STAFF_COLLECTED','COMPLETED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING'`
    );
  } catch (err) {
    console.error(`  ❌  ${gymName}: ${err.message}`);
  } finally {
    await seq.close();
  }
}

async function main() {
  // Connect directly to platform DB without sync
  const platformSeq = new Sequelize(
    process.env.PLATFORM_DB_NAME,
    process.env.PLATFORM_DB_USER,
    process.env.PLATFORM_DB_PASS,
    {
      host: process.env.PLATFORM_DB_HOST,
      port: Number(process.env.PLATFORM_DB_PORT) || 3306,
      dialect: 'mysql',
      logging: false,
      dialectOptions: { connectTimeout: 20000 },
    }
  );

  await platformSeq.authenticate();
  console.log('✅  Platform DB connected\n');

  const tenants = await platformSeq.query(
    `SELECT gym_name, connection_string_encrypted FROM tenants WHERE status = 'ACTIVE' AND connection_string_encrypted IS NOT NULL`,
    { type: QueryTypes.SELECT }
  );

  console.log(`📋  Found ${tenants.length} active tenant(s)\n`);

  for (const t of tenants) {
    const connUrl = decrypt(t.connection_string_encrypted);
    await migrateTenant(t.gym_name || '(unnamed)', connUrl);
  }

  await platformSeq.close();
  console.log('\n✅  Migration complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
