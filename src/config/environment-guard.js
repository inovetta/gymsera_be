/**
 * Staging must never run on the production platform database (NEW-131).
 *
 * apistaging.gymsera.com runs on the same server as production. PLATFORM_DB_NAME falls back to
 * `gymsera_platform` when unset (database.config.js) and .env.example paired that name with
 * APP_URL=https://apistaging.gymsera.com, so a staging API could serve production data with
 * staging's (older) code: approvals, provisioning, crons. A NEW-127 lead.
 *
 * Staging = NODE_ENV=staging, GYMSERA_ENV=staging, or an APP_URL host containing "staging".
 * Production platform database = PRODUCTION_PLATFORM_DB_NAME, else `gymsera`: production connects
 * to `gymsera`, set outside its .env (owner evidence 2026-10-27, NEW-134); it is not the code's
 * fallback `gymsera_platform`. The platform database is the name this process resolves
 * (database.config.js#resolvePlatformDbName), with where it came from. Checked by server.js and
 * api/index.js before any connection; `node src/scripts/check-environment.js` prints the same
 * verdict without starting.
 */
const { URL } = require('url');
const { envSource, resolvePlatformDbName } = require('./database.config');

/** The production platform database when PRODUCTION_PLATFORM_DB_NAME is unset (NEW-134). */
const DEFAULT_PRODUCTION_PLATFORM_DB_NAME = 'gymsera';

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

/**
 * { ok, signals, platformDb, platformDbSource, productionPlatformDb, productionPlatformDbSource, reason }.
 * `dotenvParsed` is the .env the process read (only used to say where a value came from).
 */
const checkEnvironment = (env = process.env, dotenvParsed) => {
  const signals = stagingSignals(env);
  const platform = resolvePlatformDbName(env, dotenvParsed);
  const productionSource = envSource('PRODUCTION_PLATFORM_DB_NAME', env, dotenvParsed);
  const productionPlatformDb = productionSource ? env.PRODUCTION_PLATFORM_DB_NAME : DEFAULT_PRODUCTION_PLATFORM_DB_NAME;
  const productionPlatformDbSource = productionSource || 'built-in production name; PRODUCTION_PLATFORM_DB_NAME is not set';
  const ok = signals.length === 0 || platform.name !== productionPlatformDb;
  return {
    ok,
    signals,
    platformDb: platform.name,
    platformDbSource: platform.source,
    productionPlatformDb,
    productionPlatformDbSource,
    reason: ok
      ? null
      : `staging (${signals.join(', ')}) is configured with the production platform database ` +
        `'${platform.name}' (${platform.source}). Give staging its own PLATFORM_DB_NAME (a value set ` +
        'in the host or IIS environment wins over .env), or set PRODUCTION_PLATFORM_DB_NAME if production uses another name.',
  };
};

/** Throws (code STAGING_ON_PRODUCTION_DB) when staging points at the production platform database. */
const assertEnvironmentSafe = (env = process.env, dotenvParsed) => {
  const result = checkEnvironment(env, dotenvParsed);
  if (!result.ok) {
    const err = new Error(`Refusing to start: ${result.reason}`);
    err.code = 'STAGING_ON_PRODUCTION_DB';
    throw err;
  }
  return result;
};

module.exports = { checkEnvironment, assertEnvironmentSafe, stagingSignals, DEFAULT_PRODUCTION_PLATFORM_DB_NAME };
