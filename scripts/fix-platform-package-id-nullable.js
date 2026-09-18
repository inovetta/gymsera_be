/**
 * One-off diagnostic + fix for a migration that silently failed on some
 * deployments: tenant_subscriptions.platform_package_id was supposed to
 * become nullable (see database/platform.js), but the ALTER TABLE in that
 * try/catch block never surfaced its real error. Run this once against an
 * affected database to see exactly why it failed and apply it for real.
 *
 * Usage: node scripts/fix-platform-package-id-nullable.js
 */
const { sequelize } = require('../src/database/platform');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[Fix] Connected to platform DB.');

    const [before] = await sequelize.query(
      "SELECT IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'platform_package_id'"
    );
    console.log('[Fix] Current column state:', before);

    await sequelize.query('ALTER TABLE `tenant_subscriptions` MODIFY COLUMN `platform_package_id` CHAR(36) NULL;');
    console.log('[Fix] ALTER TABLE succeeded — platform_package_id is now nullable.');

    const [after] = await sequelize.query(
      "SELECT IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS " +
      "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenant_subscriptions' AND COLUMN_NAME = 'platform_package_id'"
    );
    console.log('[Fix] Column state after fix:', after);
    process.exit(0);
  } catch (err) {
    console.error('[Fix] ALTER TABLE failed — real error:', err.message);
    if (err.original) console.error('[Fix] Underlying DB error:', err.original.sqlMessage || err.original);
    process.exit(1);
  }
})();
