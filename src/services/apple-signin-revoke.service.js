'use strict';

/**
 * Sign in with Apple: revoking the user's token when their account is deleted
 * (AUTH-07; App Store guideline 5.1.1(v); owner decision spec §14 R-28 point 5).
 *
 * Needs a Sign in with Apple key from the Apple Developer account. No secret is in code:
 * everything comes from the environment (the R-25 pattern) and, when anything is missing,
 * revoking is SKIPPED, recorded, and deletion still completes.
 *
 *   APPLE_SIGNIN_TEAM_ID, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_CLIENT_ID (bundle id / services id),
 *   and the key itself as APPLE_SIGNIN_PRIVATE_KEY_PATH (a .p8 file path, like APPLE_IAP_PRIVATE_KEY_PATH)
 *   or APPLE_SIGNIN_PRIVATE_KEY (PEM, `\n` allowed).
 *
 * Flow: at Apple sign-in the app sends Apple's one-time `authorizationCode`; the server
 * exchanges it for a refresh token and keeps it encrypted (users.apple_refresh_token_encrypted).
 * At deletion that token is revoked at Apple and cleared.
 */
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { encrypt, decrypt } = require('../utils/crypto.utils');
const { PlatformAuditLog } = require('../models/platform');

/* global fetch, AbortSignal */ // Node 20 built-ins (the eslint config has no node globals)
const APPLE_AUTH_BASE = 'https://appleid.apple.com/auth';
const APPLE_TIMEOUT_MS = 8000;

const REQUIRED = ['APPLE_SIGNIN_TEAM_ID', 'APPLE_SIGNIN_KEY_ID', 'APPLE_SIGNIN_CLIENT_ID'];

/** The configuration, or null when Sign in with Apple revocation is not set up on this server. */
const getAppleSignInConfig = (env = process.env) => {
  if (REQUIRED.some((k) => !env[k] || String(env[k]).trim() === '')) return null;
  let privateKey = env.APPLE_SIGNIN_PRIVATE_KEY ? String(env.APPLE_SIGNIN_PRIVATE_KEY).replace(/\\n/g, '\n') : null;
  if (!privateKey && env.APPLE_SIGNIN_PRIVATE_KEY_PATH) {
    try {
      privateKey = fs.readFileSync(env.APPLE_SIGNIN_PRIVATE_KEY_PATH, 'utf8');
    } catch (_) {
      return null;
    }
  }
  if (!privateKey) return null;
  return { teamId: env.APPLE_SIGNIN_TEAM_ID, keyId: env.APPLE_SIGNIN_KEY_ID, clientId: env.APPLE_SIGNIN_CLIENT_ID, privateKey };
};

/** Apple's "client secret" is a short-lived ES256 JWT signed with the key. */
const buildClientSecret = (config) =>
  jwt.sign({}, config.privateKey, {
    algorithm: 'ES256',
    keyid: config.keyId,
    issuer: config.teamId,
    audience: 'https://appleid.apple.com',
    subject: config.clientId,
    expiresIn: '5m',
  });

const _post = async (endpoint, params) => {
  const res = await fetch(`${APPLE_AUTH_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {}; }
  if (!res.ok) {
    const err = new Error(`Apple ${endpoint} responded ${res.status}${body.error ? ` (${body.error})` : ''}`);
    err.appleError = body.error || null;
    err.status = res.status;
    throw err;
  }
  return body;
};

/** Provider calls, grouped so tests can substitute them (nothing here may reach Apple in a test). */
const appleApi = {
  exchangeAuthorizationCode: (config, code) =>
    _post('token', {
      client_id: config.clientId,
      client_secret: buildClientSecret(config),
      code,
      grant_type: 'authorization_code',
    }),
  revokeToken: (config, refreshToken) =>
    _post('revoke', {
      client_id: config.clientId,
      client_secret: buildClientSecret(config),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }),
};

/**
 * Keep the user's Apple refresh token for later revocation. Never blocks sign-in:
 * the caller ignores a failure. Does nothing when Apple revocation is not configured.
 */
const storeRefreshToken = async (user, authorizationCode, env = process.env) => {
  const config = getAppleSignInConfig(env);
  if (!config || !authorizationCode) return { stored: false, reason: !config ? 'not_configured' : 'no_code' };
  const tokens = await appleApi.exchangeAuthorizationCode(config, authorizationCode);
  if (!tokens.refresh_token) return { stored: false, reason: 'no_refresh_token' };
  await user.update({ appleRefreshTokenEncrypted: encrypt(tokens.refresh_token) });
  return { stored: true };
};

const _audit = (userId, status, detail) =>
  PlatformAuditLog.create({
    actorUserId: null,
    action: 'APPLE_SIGNIN_REVOKE',
    targetType: 'User',
    targetId: userId,
    details: { status, ...(detail ? { detail } : {}) },
    createdAt: new Date(),
  }).catch((err) => console.warn('[AppleRevoke] Could not write the audit row:', err.message));

/**
 * Revoke the user's Sign in with Apple token. Returns the outcome, and throws only when
 * Apple IS configured, a token exists, and Apple could not be reached/accepted — so the
 * deletion sweep retries instead of leaving the token alive.
 *
 *   revoked | already_revoked | skipped_not_linked | skipped_not_configured | skipped_no_token
 */
const revokeAppleSignIn = async (user, env = process.env) => {
  if (!user.appleId) return { status: 'skipped_not_linked' };

  const config = getAppleSignInConfig(env);
  if (!config) {
    await _audit(user.id, 'skipped_not_configured');
    return { status: 'skipped_not_configured' };
  }
  if (!user.appleRefreshTokenEncrypted) {
    // Signed in before this release, or the app never sent the code: nothing to revoke with.
    await _audit(user.id, 'skipped_no_token');
    return { status: 'skipped_no_token' };
  }

  const refreshToken = decrypt(user.appleRefreshTokenEncrypted);
  try {
    await appleApi.revokeToken(config, refreshToken);
  } catch (err) {
    // Apple says the token is already invalid / revoked: the goal is reached.
    if (err.appleError === 'invalid_grant' || err.appleError === 'invalid_request') {
      await user.update({ appleRefreshTokenEncrypted: null });
      await _audit(user.id, 'already_revoked');
      return { status: 'already_revoked' };
    }
    await _audit(user.id, 'failed', String(err.message).slice(0, 120));
    throw err;
  }
  await user.update({ appleRefreshTokenEncrypted: null });
  await _audit(user.id, 'revoked');
  return { status: 'revoked' };
};

module.exports = { getAppleSignInConfig, buildClientSecret, appleApi, storeRefreshToken, revokeAppleSignIn };
