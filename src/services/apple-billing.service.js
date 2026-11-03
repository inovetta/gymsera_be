/**
 * Apple App Store Server API — StoreKit subscription verification.
 *
 * Two things happen here, both ending at the same place (TenantSubscription):
 *
 *   1. App-initiated sync — after a purchase completes on-device, the app
 *      sends us the transaction id; we ask Apple's own API to confirm it
 *      really happened (never trust the client's word alone — see the
 *      host_subscription_upsell_screen.dart bug fixed earlier this session,
 *      which is exactly the class of mistake this exists to prevent).
 *   2. Apple-initiated notifications — renewals, cancellations, refunds,
 *      billing-retry failures arrive at our webhook without the app's
 *      involvement, keeping TenantSubscription correct even when the host
 *      never opens the app again.
 *
 * Every payload Apple hands us — whether fetched by us or POSTed to our
 * webhook — arrives as a signed JWS. The webhook path is the one that
 * actually needs signature verification to matter (it's a public endpoint;
 * anyone could POST a forged "renewed" event to it), so both paths verify
 * through the same function rather than trusting one and not the other.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { BillingPlan } = require('../models/platform');
const { createError } = require('../utils/response.utils');
const subscriptionMigrationService = require('./subscription-migration.service');

// Apple Root CA - G3, fetched and fingerprint-verified against Apple's
// published SHA-1 (b5:2c:b0:2f:d5:67:e0:35:9f:e8:fa:4d:4c:41:03:79:70:fe:01:b0)
// at https://www.apple.com/certificateauthority/AppleRootCA-G3.cer — the
// anchor every signed payload below must chain up to. Valid until 2039;
// there is no rotation mechanism here because Apple's own root doesn't
// rotate on any schedule shorter than that.
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

// NEW-177 (P10, R-82): the markers Apple's App Store Server Library also requires. The leaf
// carries the App Store receipt-signing extension and is not a CA; the intermediate (Apple
// Worldwide Developer Relations) carries its own extension and is a CA. Revocation (OCSP) is not
// checked here: it would be a network call on every verification (spec §13 P10).
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

/** One DER TLV at `offset`: tag, content start, content end. */
const _derTlv = (buf, offset) => {
  const tag = buf[offset];
  let len = buf[offset + 1];
  let start = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[start + i];
    start += n;
  }
  return { tag, start, end: start + len };
};
const _derChildren = (buf, { start, end }) => {
  const out = [];
  for (let at = start; at < end; ) {
    const tlv = _derTlv(buf, at);
    out.push(tlv);
    at = tlv.end;
  }
  return out;
};
const _derOid = (buf, { start, end }) => {
  const parts = [Math.floor(buf[start] / 40), buf[start] % 40];
  let value = 0;
  for (let i = start + 1; i < end; i++) {
    value = value * 128 + (buf[i] & 0x7f);
    if (!(buf[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
};
/** The extension OIDs of an X.509 certificate (tbsCertificate [3] extensions). */
const _extensionOids = (cert) => {
  const der = cert.raw;
  const tbs = _derChildren(der, _derTlv(der, 0))[0];
  const extensions = _derChildren(der, tbs).find((t) => t.tag === 0xa3);
  if (!extensions) return [];
  const list = _derChildren(der, extensions)[0];
  return _derChildren(der, list).map((extension) => _derOid(der, _derChildren(der, extension)[0]));
};

/**
 * Verify a certificate chain (leaf, intermediate, root, as Apple sends it) ends at our pinned
 * Apple root, that every link's signature and validity period holds, and that the leaf and the
 * intermediate carry Apple's markers (NEW-177).
 * @param {string[]} x5cBase64 DER certs, leaf first, as Apple sends them.
 * @param {{rootPem?: string}} [opts] the pinned root; tests only. Production always pins Apple's.
 * @returns {crypto.X509Certificate} the leaf certificate, once trusted.
 */
const _verifyCertChain = (x5cBase64, { rootPem = APPLE_ROOT_CA_G3_PEM } = {}) => {
  if (!Array.isArray(x5cBase64) || x5cBase64.length !== 3) {
    throw createError('Signed payload is missing its certificate chain (leaf, intermediate, root)', 401);
  }
  const chain = x5cBase64.map((b64) => new crypto.X509Certificate(Buffer.from(b64, 'base64')));
  const root = new crypto.X509Certificate(rootPem);
  const now = new Date();

  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    const issuerCert = i + 1 < chain.length ? chain[i + 1] : root;
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
      throw createError('A certificate in the signed payload has expired or is not yet valid', 401);
    }
    if (!cert.verify(issuerCert.publicKey)) {
      throw createError('Certificate chain in signed payload does not verify', 401);
    }
  }
  // The last link in the chain must itself be issued by our pinned root.
  const lastLink = chain[chain.length - 1];
  if (!lastLink.checkIssued(root)) {
    throw createError('Signed payload does not chain to Apple\'s Root CA', 401);
  }
  const [leaf, intermediate] = chain;
  if (leaf.ca || !_extensionOids(leaf).includes(APPLE_LEAF_OID)) {
    throw createError('Signed payload is not signed by an App Store signing certificate', 401);
  }
  if (!intermediate.ca || !_extensionOids(intermediate).includes(APPLE_INTERMEDIATE_OID)) {
    throw createError('Signed payload\'s intermediate certificate is not Apple\'s', 401);
  }

  return leaf;
};

/**
 * Decode and verify one of Apple's signed JWS strings — used for both
 * signedTransactionInfo (from the transaction-lookup API) and
 * signedPayload (from App Store Server Notifications). Throws if the
 * signature or chain don't check out; never returns unverified data.
 */
const verifyAndDecode = (signedJws) => {
  const decodedHeader = jwt.decode(signedJws, { complete: true })?.header;
  if (!decodedHeader?.x5c) {
    throw createError('Signed payload has no x5c header — cannot verify', 401);
  }
  const leafCert = _verifyCertChain(decodedHeader.x5c);
  const leafPublicKeyPem = leafCert.publicKey.export({ type: 'spki', format: 'pem' });
  // jwt.verify re-checks the signature itself (not just the chain above) —
  // both steps matter: the chain proves the leaf cert is really Apple's,
  // this proves the leaf cert's key is what actually signed this payload.
  return jwt.verify(signedJws, leafPublicKeyPem, { algorithms: ['ES256'] });
};

/** Short-lived (20 min) JWT for authenticating our own calls to Apple's API. */
const _appleApiJwt = () => {
  const keyId = process.env.APPLE_IAP_KEY_ID;
  const issuerId = process.env.APPLE_IAP_ISSUER_ID;
  const bundleId = process.env.APPLE_IAP_BUNDLE_ID;
  const keyPath = process.env.APPLE_IAP_PRIVATE_KEY_PATH;
  if (!keyId || !issuerId || !bundleId || !keyPath) {
    throw createError('Apple IAP API credentials are not configured on the server', 500);
  }
  // Read from disk on every call rather than caching at module load — this
  // is a low-frequency operation (one JWT per verify call, not per request),
  // and it means rotating the key file never needs a server restart.
  const privateKey = require('fs').readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1', bid: bundleId },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: keyId, typ: 'JWT' } }
  );
};

const APPLE_API_BASE = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};
// App Store Server API errors for an id this environment doesn't know:
// TransactionIdNotFoundError, OriginalTransactionIdNotFoundError.
const APPLE_NOT_FOUND_CODES = [4040010, 4040005];

/** 'Sandbox' | 'Production' | null, from Apple's spelling or the row's (SANDBOX / PRODUCTION). */
const _appleEnvironment = (value) => {
  const v = String(value || '').toUpperCase();
  if (v === 'SANDBOX') return 'Sandbox';
  if (v === 'PRODUCTION') return 'Production';
  return null;
};

/**
 * Which App Store Server API environments to ask, in order (P7c item 4, NEW-173, R-82).
 * Production first, then Sandbox when Production doesn't know the id — Apple's
 * documented order, so TestFlight and App Review purchases (always Sandbox) verify
 * on the production server. A known environment (a notification's own
 * `environment`, the stored row's) goes first. APPLE_IAP_ENVIRONMENT=Sandbox keeps
 * a staging server on Sandbox only (scripts/staging/lib/guard.js refuses Production).
 */
const _environmentOrder = (hint) => {
  if (_appleEnvironment(process.env.APPLE_IAP_ENVIRONMENT) === 'Sandbox') return ['Sandbox'];
  return _appleEnvironment(hint) === 'Sandbox' ? ['Sandbox', 'Production'] : ['Production', 'Sandbox'];
};

const _isNotFound = (err) =>
  err?.response?.status === 404 && APPLE_NOT_FOUND_CODES.includes(Number(err.response.data?.errorCode));

/**
 * Ask Apple directly "what is this transaction," rather than trusting
 * whatever the app claims — the whole point of server-side verification.
 * Only "not found" moves on to the next environment; any other error (auth,
 * outage) is thrown as it is.
 * @param {string} transactionId
 * @param {{ environment?: string|null }} [opts] - the environment to try first, when known.
 * @returns {object} the decoded, chain-verified transaction payload.
 */
const getTransactionInfo = async (transactionId, { environment = null } = {}) => {
  const axios = require('axios');
  const order = _environmentOrder(environment);
  for (let i = 0; ; i++) {
    try {
      const response = await axios.get(`${APPLE_API_BASE[order[i]]}/inApps/v1/transactions/${transactionId}`, {
        headers: { Authorization: `Bearer ${_appleApiJwt()}` },
      });
      return appleApi.verifyAndDecode(response.data.signedTransactionInfo);
    } catch (err) {
      if (i + 1 < order.length && _isNotFound(err)) continue;
      throw err;
    }
  }
};

/**
 * A verified transaction's productId (e.g. "branches_7_annual") back to the
 * BillingPlan row it belongs to — the one place that mapping happens, so a
 * catalog change (new tier, renamed product) never needs a code change here.
 */
const findPlanForProductId = async (productId) => {
  const plan = await BillingPlan.findOne({
    where: {
      [require('sequelize').Op.or]: [{ iosMonthlyProductId: productId }, { iosAnnualProductId: productId }],
    },
  });
  if (!plan) throw createError(`No BillingPlan is configured for product "${productId}"`, 404);
  return plan;
};

/**
 * App Store Server API subscription status -> our status (BILL-04, spec §7.4):
 * 1 active, 2 expired, 3 billing retry (Apple has stopped access), 4 billing
 * grace period (Apple still gives access), 5 revoked.
 */
const APPLE_STATUS = { 1: 'ACTIVE', 2: 'EXPIRED', 3: 'ON_HOLD', 4: 'GRACE', 5: 'REVOKED' };

/**
 * Maps a verified Apple transaction to TenantSubscription values and applies
 * them through subscription-migration.service.js#applyVerifiedSubscription —
 * the one write path shared by every provider, the app's /sync and every
 * webhook. Keyed on externalOriginalTransactionId (stable across renewals and
 * tier upgrades), so it is safe to call repeatedly. `originListingId` — the
 * organization the purchase was made from, when the app knows it — is where
 * an upgrade's new capacity lands; without it reconcileCapacity falls back to
 * the tenant's oldest organization.
 */
const syncSubscriptionFromTransaction = async (tenantId, decodedTransaction, { originListingId = null } = {}) => {
  const plan = await findPlanForProductId(decodedTransaction.productId);

  const expiresAt = decodedTransaction.expiresDate ? new Date(Number(decodedTransaction.expiresDate)) : null;
  const isAnnual = decodedTransaction.productId === plan.iosAnnualProductId;
  const revoked = !!decodedTransaction.revocationDate;
  const renewalInfo = decodedTransaction.renewalInfo || null;
  // Apple's subscription status (from getLatestTransaction) decides; without
  // it (a plain transaction lookup) the expiry date does, as before.
  const status =
    revoked ? 'REVOKED'
      : APPLE_STATUS[decodedTransaction.subscriptionStatus] ||
        (expiresAt && expiresAt < new Date() ? 'EXPIRED' : 'ACTIVE');

  // BILL-03: the plan in effect is the transaction's product. An in-group
  // downgrade only takes effect at renewal; until then Apple names the next
  // product in renewalInfo.autoRenewProductId — recorded as pendingChange,
  // never applied early. No renewal info (plain lookup) = unknown (undefined).
  let upcomingChange;
  if (renewalInfo) {
    const nextProductId = renewalInfo.autoRenewProductId;
    const renews = renewalInfo.autoRenewStatus == null || Number(renewalInfo.autoRenewStatus) === 1;
    upcomingChange = null;
    if (renews && nextProductId && nextProductId !== decodedTransaction.productId) {
      const nextPlan = await findPlanForProductId(nextProductId).catch(() => null);
      if (nextPlan && nextPlan.id !== plan.id) {
        upcomingChange = {
          billingPlanId: nextPlan.id,
          branchCount: nextPlan.branchCount,
          productId: nextProductId,
          effectiveAt: expiresAt ? expiresAt.toISOString() : null,
        };
      }
    }
  }

  const values = {
    platform: 'IOS',
    billingPlanId: plan.id,
    branchCount: plan.branchCount,
    productId: decodedTransaction.productId,
    externalOriginalTransactionId: String(decodedTransaction.originalTransactionId),
    externalTransactionId: String(decodedTransaction.transactionId),
    environment: decodedTransaction.environment === 'Production' ? 'PRODUCTION' : 'SANDBOX',
    startDate: new Date(Number(decodedTransaction.purchaseDate)).toISOString().split('T')[0],
    endDate: expiresAt ? expiresAt.toISOString().split('T')[0] : null,
    // Catalog price: only a fallback when Apple reports no price — see
    // subscription-migration.service.js#applyVerifiedSubscription.
    amount: isAnnual ? plan.annualPrice : plan.monthlyPrice,
    currency: plan.currency,
    billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY',
    // What Apple actually charged (BILL-05): `price` in milliunits of `currency`.
    chargedAmount: decodedTransaction.price != null ? Math.round(Number(decodedTransaction.price) / 10) / 100 : null,
    chargedCurrency: decodedTransaction.price != null ? decodedTransaction.currency || null : null,
    upcomingChange,
    // revocationDate = Apple refunded or revoked it (REFUND / REVOKE
    // notifications): not entitled from now on (BILL-02).
    status,
    // Turning auto-renew off changes nothing else: entitled to the period end (§7.4).
    autoRenew: !revoked && (renewalInfo?.autoRenewStatus == null || Number(renewalInfo.autoRenewStatus) === 1),
    paymentStatus: 'PAID',
    lastVerifiedAt: new Date(),
  };

  return subscriptionMigrationService.applyVerifiedSubscription(tenantId, values, {
    originListingId,
    idempotencyPrefix: values.externalTransactionId,
    // The tenant id the app sent as applicationUserName (BILL-01).
    boundTenantId: decodedTransaction.appAccountToken || null,
    // Apple puts a refund on the transaction (revocationDate): no date = not refunded (NEW-175).
    revocationReported: true,
    logLabel: 'Apple Billing',
  });
};

/**
 * Apple's current truth for a subscription, given any of its transaction ids:
 * the latest signed transaction from the App Store Server API's subscription
 * status endpoint — never what a notification payload claims (BILL-12). The
 * same response's `status` and signed renewal info are attached as
 * `subscriptionStatus` / `renewalInfo` (grace, billing retry, auto-renew —
 * BILL-04; the upcoming product — BILL-03).
 */
const getLatestTransaction = async (transactionId, { environment = null } = {}) => {
  const axios = require('axios');
  const known = await appleApi.getTransactionInfo(transactionId, { environment });
  const originalId = String(known.originalTransactionId);
  // The environment that found the transaction answers for its subscription too.
  const base = APPLE_API_BASE[_appleEnvironment(known.environment) || _environmentOrder(environment)[0]];
  const response = await axios.get(`${base}/inApps/v1/subscriptions/${encodeURIComponent(originalId)}`, {
    headers: { Authorization: `Bearer ${_appleApiJwt()}` },
  });
  for (const group of response.data?.data || []) {
    for (const last of group.lastTransactions || []) {
      if (String(last.originalTransactionId) === originalId && last.signedTransactionInfo) {
        return {
          ...appleApi.verifyAndDecode(last.signedTransactionInfo),
          subscriptionStatus: last.status ?? null,
          renewalInfo: last.signedRenewalInfo ? appleApi.verifyAndDecode(last.signedRenewalInfo) : null,
        };
      }
    }
  }
  // Not an auto-renewable subscription status Apple can report — the
  // transaction lookup itself is still Apple-verified truth.
  return known;
};

/**
 * Provider API calls, grouped so a test can substitute them — nothing else in
 * this file talks to Apple directly.
 */
const appleApi = { verifyAndDecode, getTransactionInfo, getLatestTransaction };

/**
 * The one entry point both POST /billing/ios/sync and the App Store
 * notification processor (billing-event.service.js) use: re-fetch Apple's
 * truth, then apply it through syncSubscriptionFromTransaction.
 *
 * `tenantId` is the caller's tenant for /sync. Without one (a notification,
 * the daily sweep) the owner is resolved from the existing row or the
 * transaction's appAccountToken; returns null when no tenant owns it.
 * `environment` (a notification's, a stored row's) is asked first, when known.
 */
const syncFromApple = async ({ transactionId, tenantId = null, originListingId = null, environment = null }) => {
  const decodedTransaction = await appleApi.getLatestTransaction(transactionId, { environment });
  const owner =
    tenantId ||
    (await subscriptionMigrationService.resolveSubscriptionOwner(
      'IOS',
      decodedTransaction.originalTransactionId,
      decodedTransaction.appAccountToken
    ));
  if (!owner) return null;
  return syncSubscriptionFromTransaction(owner, decodedTransaction, { originListingId });
};

module.exports = {
  appleApi,
  verifyAndDecode,
  _verifyCertChain, // tests only (NEW-177)
  getTransactionInfo,
  findPlanForProductId,
  syncSubscriptionFromTransaction,
  syncFromApple,
};
