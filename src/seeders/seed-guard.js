/**
 * Seeder safety (SEC-05).
 *
 * The seeders create accounts with known passwords. They are for local, staging and test databases only,
 * so they refuse to run when NODE_ENV is production. Platform admin accounts never get a password written
 * in the repo: it comes from SEED_ADMIN_PASSWORD, or is generated for this run and printed once.
 */
const crypto = require('crypto');

const assertSeedingAllowed = (env = process.env) => {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Seeders are disabled when NODE_ENV=production (they create accounts with known passwords).');
  }
};

/** @returns {{ password: string, generated: boolean }} */
const platformAdminPassword = (env = process.env) => {
  const fromEnv = (env.SEED_ADMIN_PASSWORD || '').trim();
  if (fromEnv) return { password: fromEnv, generated: false };
  return { password: `${crypto.randomBytes(15).toString('base64url')}aA1!`, generated: true };
};

module.exports = { assertSeedingAllowed, platformAdminPassword };
