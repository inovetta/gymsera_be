#!/usr/bin/env node
/**
 * Runs the read-only Play Console price check once (BILL-15). Same code as the daily job.
 *
 *   node src/scripts/run-price-verification.js
 *
 * Needs GOOGLE_PLAY_SERVICE_ACCOUNT_JSON and GOOGLE_PLAY_PACKAGE_NAME; without them it says so and exits.
 * It never changes a plan or a price.
 */
require('dotenv').config();
const { sequelize } = require('../database/platform');
const { runPriceVerification } = require('../services/price-verification.service');

async function main() {
  await sequelize.authenticate();
  const result = await runPriceVerification();
  console.log(JSON.stringify(result, null, 2));
  await sequelize.close().catch(() => {});
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Price verification failed:', err.message);
  process.exit(1);
});
