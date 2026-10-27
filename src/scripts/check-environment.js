/**
 * Would this site's settings start? (NEW-131) Read-only: reads .env and the environment, connects
 * to nothing, prints no secret.
 *
 *   node src/scripts/check-environment.js
 *
 * Run it in each site's folder (production and apistaging) before deploying. It sees this shell's
 * environment: a value set only for an IIS application pool is not visible here, so the boot line
 * (`platformDb=... (source)`) of the running site is the final word (NEW-134).
 * Exit 0 = allowed, 2 = the API would refuse to start (staging on the production platform database).
 */
require('dotenv').config();
const { checkEnvironment } = require('../config/environment-guard');

const result = checkEnvironment(process.env);
const lines = [
  `NODE_ENV: ${process.env.NODE_ENV || '(unset)'}`,
  `GYMSERA_ENV: ${process.env.GYMSERA_ENV || '(unset)'}`,
  `APP_URL: ${process.env.APP_URL || '(unset)'}`,
  `platform database: ${result.platformDb} (${result.platformDbSource})`,
  `production platform database: ${result.productionPlatformDb} (${result.productionPlatformDbSource})`,
  `staging: ${result.signals.length ? result.signals.join(', ') : 'no'}`,
  result.ok ? 'OK: the API would start with these settings.' : `REFUSED: ${result.reason}`,
];
process.stdout.write(`${lines.join('\n')}\n`);
process.exitCode = result.ok ? 0 : 2;
