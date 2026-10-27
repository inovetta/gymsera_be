/**
 * Would this site's settings start? (NEW-131) Read-only: reads .env and the environment, connects
 * to nothing, prints no secret.
 *
 *   node src/scripts/check-environment.js
 *
 * Run it in each site's folder (production and apistaging) before deploying.
 * Exit 0 = allowed, 2 = the API would refuse to start (staging on the production platform database).
 */
require('dotenv').config();
const { checkEnvironment } = require('../config/environment-guard');

const result = checkEnvironment(process.env);
const lines = [
  `NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`,
  `GYMSERA_ENV: ${process.env.GYMSERA_ENV || '(unset)'}`,
  `APP_URL: ${process.env.APP_URL || '(unset)'}`,
  `platform database: ${result.platformDb}${process.env.PLATFORM_DB_NAME ? '' : ' (PLATFORM_DB_NAME unset: the built-in name)'}`,
  `production platform database: ${result.productionPlatformDb}${process.env.PRODUCTION_PLATFORM_DB_NAME ? '' : ' (PRODUCTION_PLATFORM_DB_NAME unset: the built-in name)'}`,
  `staging: ${result.signals.length ? result.signals.join(', ') : 'no'}`,
  result.ok ? 'OK: the API would start with these settings.' : `REFUSED: ${result.reason}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
process.exitCode = result.ok ? 0 : 2;
