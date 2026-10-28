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
 *
 * NEW-135: tenant databases are named `gymsera_<tenant code>` whatever the platform database is, so
 * staging must also not use production's tenant database server. Production tenant host =
 * PRODUCTION_TENANT_DB_HOST, else 209.209.42.64; the tenant host is the one provisioning resolves
 * (database.config.js#resolveTenantDbHost). Compared as host names (case and a trailing dot ignored):
 * another name or IP for the same machine is not caught, so the runbook rule still applies.
 */
const { URL } = require('url');
const { envSource, resolvePlatformDbName, resolveTenantDbHost } = require('./database.config');

/** The production platform database when PRODUCTION_PLATFORM_DB_NAME is unset (NEW-134). */
const DEFAULT_PRODUCTION_PLATFORM_DB_NAME = 'gymsera';

/** The production tenant database server when PRODUCTION_TENANT_DB_HOST is unset: TENANT_DB_HOST in production's .env (owner, 2026-10-28; NEW-135). */
const DEFAULT_PRODUCTION_TENANT_DB_HOST = '209.209.42.64';

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

const normalHost = (host) => String(host || '').trim().toLowerCase().replace(/\.$/, '');

/** `env[key]` with where it came from, else `fallback` with `fallbackSource`. */
const settingOrDefault = (key, env, dotenvParsed, fallback, fallbackSource) => {
  const source = envSource(key, env, dotenvParsed);
  return source ? { value: env[key], source } : { value: fallback, source: fallbackSource };
};

/**
 * { ok, signals, platformDb, platformDbSource, productionPlatformDb, productionPlatformDbSource,
 *   tenantDbHost, tenantDbHostSource, productionTenantDbHost, productionTenantDbHostSource, reason }.
 * `dotenvParsed` is the .env the process read (only used to say where a value came from).
 * Names and host names only, never a password.
 */
const checkEnvironment = (env = process.env, dotenvParsed) => {
  const signals = stagingSignals(env);
  const platform = resolvePlatformDbName(env, dotenvParsed);
  const productionPlatform = settingOrDefault('PRODUCTION_PLATFORM_DB_NAME', env, dotenvParsed,
    DEFAULT_PRODUCTION_PLATFORM_DB_NAME, 'built-in production name; PRODUCTION_PLATFORM_DB_NAME is not set');
  const tenant = resolveTenantDbHost(env, dotenvParsed);
  const productionTenant = settingOrDefault('PRODUCTION_TENANT_DB_HOST', env, dotenvParsed,
    DEFAULT_PRODUCTION_TENANT_DB_HOST, 'built-in production tenant host; PRODUCTION_TENANT_DB_HOST is not set');

  const problems = [];
  if (signals.length > 0) {
    if (platform.name === productionPlatform.value) {
      problems.push(`the production platform database '${platform.name}' (${platform.source})`);
    }
    if (normalHost(tenant.host) === normalHost(productionTenant.value)) {
      problems.push(`the production tenant database server '${tenant.host}' (${tenant.source})`);
    }
  }
  const ok = problems.length === 0;
  return {
    ok,
    signals,
    platformDb: platform.name,
    platformDbSource: platform.source,
    productionPlatformDb: productionPlatform.value,
    productionPlatformDbSource: productionPlatform.source,
    tenantDbHost: tenant.host,
    tenantDbHostSource: tenant.source,
    productionTenantDbHost: productionTenant.value,
    productionTenantDbHostSource: productionTenant.source,
    reason: ok
      ? null
      : `staging (${signals.join(', ')}) is configured with ${problems.join(' and with ')}. Give staging its own ` +
        'PLATFORM_DB_NAME and its own tenant database server (TENANT_DB_HOST), in its own .env (a value set in the ' +
        'host or IIS environment wins over .env), or set PRODUCTION_PLATFORM_DB_NAME / PRODUCTION_TENANT_DB_HOST if ' +
        'production uses other values.',
  };
};

/** Throws (code STAGING_ON_PRODUCTION_DB) when staging points at the production platform database or tenant server. */
const assertEnvironmentSafe = (env = process.env, dotenvParsed) => {
  const result = checkEnvironment(env, dotenvParsed);
  if (!result.ok) {
    const err = new Error(`Refusing to start: ${result.reason}`);
    err.code = 'STAGING_ON_PRODUCTION_DB';
    throw err;
  }
  return result;
};

module.exports = {
  checkEnvironment,
  assertEnvironmentSafe,
  stagingSignals,
  DEFAULT_PRODUCTION_PLATFORM_DB_NAME,
  DEFAULT_PRODUCTION_TENANT_DB_HOST,
};
