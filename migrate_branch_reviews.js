/**
 * Standalone migration: Add branch_id to gym_reviews for branch-level reviews
 * Uses raw mysql2 — no backend module imports needed.
 * Run: node migrate_branch_reviews.js
 */
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
    database: 'gymsera_platform',
  });

  console.log('[Migration] Connected to gymsera_platform');

  // 1. Add branch_id column if it doesn't exist
  const [cols] = await conn.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='gymsera_platform' AND TABLE_NAME='gym_reviews' AND COLUMN_NAME='branch_id'"
  );
  if (cols.length === 0) {
    await conn.query(
      "ALTER TABLE `gym_reviews` ADD COLUMN `branch_id` VARCHAR(36) NULL AFTER `gym_listing_id`"
    );
    console.log('[Migration] ✓ Added branch_id column');
  } else {
    console.log('[Migration] branch_id already exists, skipping.');
  }

  // 2. Add index on (branch_id, status) if not present
  const [idxRows] = await conn.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA='gymsera_platform' AND TABLE_NAME='gym_reviews' AND INDEX_NAME='idx_branch_status'"
  );
  if (idxRows.length === 0) {
    await conn.query(
      "ALTER TABLE `gym_reviews` ADD INDEX `idx_branch_status` (`branch_id`, `status`)"
    );
    console.log('[Migration] ✓ Added idx_branch_status index');
  } else {
    console.log('[Migration] idx_branch_status already exists, skipping.');
  }

  // 3. Drop old unique index (listing + user) if it exists
  const [oldIdx] = await conn.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA='gymsera_platform' AND TABLE_NAME='gym_reviews' AND INDEX_NAME='gym_reviews_listing_user_unique'"
  );
  if (oldIdx.length > 0) {
    await conn.query(
      "ALTER TABLE `gym_reviews` DROP INDEX `gym_reviews_listing_user_unique`"
    );
    console.log('[Migration] ✓ Dropped old gym_reviews_listing_user_unique index');
  } else {
    console.log('[Migration] Old unique index not found, skipping drop.');
  }

  // 4. Add new unique index (branch + user) — one review per user per branch
  const [newIdx] = await conn.query(
    "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA='gymsera_platform' AND TABLE_NAME='gym_reviews' AND INDEX_NAME='gym_reviews_branch_user_unique'"
  );
  if (newIdx.length === 0) {
    await conn.query(
      "ALTER TABLE `gym_reviews` ADD UNIQUE INDEX `gym_reviews_branch_user_unique` (`branch_id`, `user_id`)"
    );
    console.log('[Migration] ✓ Added gym_reviews_branch_user_unique index');
  } else {
    console.log('[Migration] gym_reviews_branch_user_unique already exists, skipping.');
  }

  console.log('\n[Migration] ✅ Branch-level reviews migration complete!');
  await conn.end();
}

main().catch((err) => {
  console.error('[Migration] ❌ Failed:', err.message);
  process.exit(1);
});
