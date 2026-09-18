/**
 * One-off diagnostic + fix for a migration that silently failed on some
 * deployments: tenant_subscriptions.platform_package_id was supposed to
 * become nullable (see database/platform.js), but the ALTER TABLE in that
 * try/catch block never surfaced its real error. Run this once against an
 * affected database to see exactly why it failed and apply it for real.
 *
 * Usage: node scripts/fix-platform-package-id-nullable.js
 */
// server.js is the only place that normally calls this — standalone scripts
// under scripts/ never go through it, so without this line every DB config
// value silently falls back to database.config.js's local-dev defaults
// (gymsera/gymsera_pass/localhost) instead of the real staging credentials.
require('dotenv').config();
const { sequelize } = require('../src/database/platform');

(async () => {
  let step = 'connecting to the database';
  try {
    await sequelize.authenticate();
    console.log('[Fix] Connected to platform DB.');

    step = 'reading current column state';
    const [before] = await sequelize.query(
      "SELECT IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'platform_package_id'"
    );
    console.log('[Fix] Current column state:', before);

    step = 'running ALTER TABLE';
    await sequelize.query('ALTER TABLE `tenant_subscriptions` MODIFY COLUMN `platform_package_id` CHAR(36) NULL;');
    console.log('[Fix] ALTER TABLE succeeded — platform_package_id is now nullable.');

    const [after] = await sequelize.query(
      "SELECT IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'platform_package_id'"
    );
    console.log('[Fix] Column state after fix:', after);
    process.exit(0);
  } catch (err) {
    console.error(`[Fix] Failed while ${step} — real error:`, err.message);
    if (err.original) console.error('[Fix] Underlying DB error:', err.original.sqlMessage || err.original);
    process.exit(1);
  }
})();
