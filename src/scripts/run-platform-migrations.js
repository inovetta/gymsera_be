/**
 * CLI runner for PLATFORM database migrations (sibling of run-tenant-migrations.js).
 *
 * Usage:
 *   node src/scripts/run-platform-migrations.js --dry-run   # preview, zero writes
 *   node src/scripts/run-platform-migrations.js             # apply
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { runPlatformMigrations, PLATFORM_TARGET_VERSION } = require('../database/platform-migrations');

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log(`🚀 Platform database migrations (target version: v${PLATFORM_TARGET_VERSION}, mode: ${isDryRun ? 'DRY-RUN' : 'LIVE'})...\n`);

  // authenticate() only — platform.js#connect runs its boot-time ALTERs, which
  // would make a --dry-run write.
  await sequelize.authenticate();

  const result = await runPlatformMigrations(sequelize, { dryRun: isDryRun });

  console.log('=========================================');
  console.log(`       PLATFORM MIGRATION REPORT (${isDryRun ? 'DRY-RUN' : 'LIVE'})`);
  console.log('=========================================');
  if (isDryRun) {
    const wouldRun = result.wouldRun || [];
    console.log(`At v${result.initialVersion}, target v${PLATFORM_TARGET_VERSION}`);
    console.log(wouldRun.length > 0 ? `WOULD RUN ${wouldRun.length} migration(s): ${wouldRun.join(', ')}` : 'UP TO DATE (no migrations needed)');
  } else {
    console.log(`From v${result.initialVersion} to v${result.finalVersion}`);
    console.log(result.applied.length > 0 ? `Applied: ${result.applied.join(', ')}` : 'UP TO DATE (0 applied)');
  }
  console.log('=========================================\n');

  await sequelize.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal platform migration error:', err);
  process.exit(1);
});
