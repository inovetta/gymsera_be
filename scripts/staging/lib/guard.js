/**
 * Staging-only guard (spec §16, §17.4). The staging checks create databases, call store sandboxes and read every
 * ACTIVE tenant, so they refuse to start unless the caller says it is staging AND the environment agrees:
 *   - `--env=staging` on the command line AND GYMSERA_ENV=staging in the environment;
 *   - NODE_ENV is not "production";
 *   - the platform database host is listed in STAGING_DB_HOSTS and is not in PRODUCTION_DB_HOSTS (and has no "prod" in its name);
 *   - Stripe is a test key and Apple points at the sandbox. Google Play purchases are checked per purchase (testPurchase).
 * Pure function: returns the reasons it refuses; the CLI exits 2 when there are any.
 */
const list = (value) => String(value || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const stagingRefusals = ({ argv = [], env = {}, platformHost = '' } = {}) => {
  const reasons = [];
  if (!argv.includes('--env=staging')) reasons.push('pass --env=staging to say this is the staging environment');
  if (env.GYMSERA_ENV !== 'staging') reasons.push('GYMSERA_ENV must be "staging"');
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV is "production"');

  const host = String(platformHost || '').trim().toLowerCase();
  const staging = list(env.STAGING_DB_HOSTS);
  const production = list(env.PRODUCTION_DB_HOSTS);
  if (!host) reasons.push('the platform database host is not set');
  if (staging.length === 0) reasons.push('STAGING_DB_HOSTS must list the staging database host(s)');
  if (host && staging.length > 0 && !staging.includes(host)) reasons.push(`database host ${host} is not in STAGING_DB_HOSTS`);
  if (host && production.includes(host)) reasons.push(`database host ${host} is listed in PRODUCTION_DB_HOSTS`);
  if (host && /prod/.test(host)) reasons.push(`database host ${host} looks like production`);

  if (/^sk_live_/.test(env.STRIPE_SECRET_KEY || '')) reasons.push('STRIPE_SECRET_KEY is a live key');
  if (env.APPLE_IAP_ENVIRONMENT === 'Production') reasons.push('APPLE_IAP_ENVIRONMENT is "Production"; staging uses the Apple sandbox');
  return reasons;
};

const assertStaging = (ctx) => {
  const reasons = stagingRefusals(ctx);
  if (reasons.length) {
    const err = new Error(`REFUSED (nothing was run): ${reasons.join('; ')}`);
    err.refusal = true;
    err.reasons = reasons;
    throw err;
  }
};

module.exports = { stagingRefusals, assertStaging };
