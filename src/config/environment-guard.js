/**
 * Staging must never run on the production platform database (NEW-131).
 *
 * apistaging.gymsera.com runs on the same server as production. PLATFORM_DB_NAME falls back to
 * `gymsera_platform` when unset (database.config.js) and .env.example paired that name with
 * APP_URL=https://apistaging.gymsera.com, so a staging API could serve production data with
 * staging's (older) code: approvals, provisioning, crons. A NEW-127 lead.
 *
 * Staging = NODE_ENV=staging, GYMSERA_ENV=staging, or an APP_URL host containing "staging".
 * Production platform database = PRODUCTION_PLATFORM_DB_NAME, else `gymsera_platform` (the
 * name the code falls back to). Checked by server.js and api/index.js before any connection;
 * `node src/scripts/check-environment.js` prints the same verdict without starting.
 */
const { URL } = require('url');
const { DEFAULT_PLATFORM_DB_NAME } = require('./database.config');

const appHost = (appUrl) => {
  try {
    return new URL(appUrl).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
};

/** Why this environment counts as staging (empty = it does not). */
const stagingSignals = (env) => {
  const signals = [];
  if (env.NODE_ENV === 'staging') signals.push('NODE_ENV=staging');
  if (env.GYMSERA_ENV === 'staging') signals.push('GYMSERA_ENV=staging');
  const host = env.APP_URL ? appHost(env.APP_URL) : null;
  if (host && host.includes('staging')) signals.push(`APP_URL host ${host}`);
  return signals;
};

/** { ok, signals, platformDb, productionPlatformDb, reason } for `env`. Pure. */
const checkEnvironment = (env = process.env) => {
  const signals = stagingSignals(env);
  const platformDb = env.PLATFORM_DB_NAME || DEFAULT_PLATFORM_DB_NAME;
  const productionPlatformDb = env.PRODUCTION_PLATFORM_DB_NAME || DEFAULT_PLATFORM_DB_NAME;
  const ok = signals.length === 0 || platformDb !== productionPlatformDb;
  return {
    ok,
    signals,
    platformDb,
    productionPlatformDb,
    reason: ok
      ? null
      : `staging (${signals.join(', ')}) is configured with the production platform database '${platformDb}'. ` +
        'Give staging its own PLATFORM_DB_NAME, or set PRODUCTION_PLATFORM_DB_NAME if production uses another name.',
  };
};

/** Throws (code STAGING_ON_PRODUCTION_DB) when staging points at the production platform database. */
const assertEnvironmentSafe = (env = process.env) => {
  const result = checkEnvironment(env);
  if (!result.ok) {
    const err = new Error(`Refusing to start: ${result.reason}`);
    err.code = 'STAGING_ON_PRODUCTION_DB';
    throw err;
  }
  return result;
};

module.exports = { checkEnvironment, assertEnvironmentSafe, stagingSignals };
