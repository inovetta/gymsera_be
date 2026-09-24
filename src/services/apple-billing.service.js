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
const { BillingPlan, Tenant } = require('../models/platform');
const { sequelize } = require('../database/platform');
const { createError } = require('../utils/response.utils');
const subscriptionQuotaService = require('./subscription-quota.service');
const subscriptionMigrationService = require('./subscription-migration.service');
const TenantDbManager = require('../database/TenantDbManager');

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

/**
 * Verify a certificate chain (leaf → ... → root) ends at our pinned Apple
 * root, and that every link's signature and validity period actually holds.
 * @param {string[]} x5cBase64 DER certs, leaf first, as Apple sends them.
 * @returns {crypto.X509Certificate} the leaf certificate, once trusted.
 */
const _verifyCertChain = (x5cBase64) => {
  if (!Array.isArray(x5cBase64) || x5cBase64.length === 0) {
    throw createError('Signed payload is missing its certificate chain', 401);
  }
  const chain = x5cBase64.map((b64) => new crypto.X509Certificate(Buffer.from(b64, 'base64')));
  const root = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);
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

  return chain[0];
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

const _appleApiBase = () =>
  process.env.APPLE_IAP_ENVIRONMENT === 'Production'
    ? 'https://api.storekit.itunes.apple.com'
    : 'https://api.storekit-sandbox.itunes.apple.com';

/**
 * Ask Apple directly "what is this transaction," rather than trusting
 * whatever the app claims — the whole point of server-side verification.
 * @returns {object} the decoded, chain-verified transaction payload.
 */
const getTransactionInfo = async (transactionId) => {
  const axios = require('axios');
  const response = await axios.get(`${_appleApiBase()}/inApps/v1/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${_appleApiJwt()}` },
  });
  return verifyAndDecode(response.data.signedTransactionInfo);
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
 * Upserts the tenant's TenantSubscription row from a verified Apple
 * transaction. Keyed on externalOriginalTransactionId — stable across
 * renewals and tier upgrades — so this is safe to call repeatedly (every
 * app-sync call, every webhook notification) without creating duplicates.
 *
 * Also this is the single choke point where branchCount ever changes for a
 * store-verified subscription, so it's where capacity reconciliation lives
 * too (subscription-quota.service.js#reconcileCapacity): a downgrade trims
 * unbuilt reservedSlots (or flags the account over-quota) and an upgrade
 * attributes the new headroom as a spendable slot, both inside the same
 * transaction as the branchCount write itself so the two can never drift
 * apart. `originListingId` — the organization the purchase was made from,
 * when the app-initiated sync call knows it — is where new capacity from an
 * upgrade lands; the webhook path (no such context) falls back to the
 * tenant's oldest organization inside reconcileCapacity.
 */
const syncSubscriptionFromTransaction = async (tenantId, decodedTransaction, { originListingId = null } = {}) => {
  const { TenantSubscription } = require('../models/platform');
  const plan = await findPlanForProductId(decodedTransaction.productId);

  const expiresAt = decodedTransaction.expiresDate ? new Date(Number(decodedTransaction.expiresDate)) : null;
  const isAnnual = decodedTransaction.productId === plan.iosAnnualProductId;
  const revoked = !!decodedTransaction.revocationDate;

  const platformTx = await sequelize.transaction();
  try {
    const existing = await TenantSubscription.findOne({
      where: { externalOriginalTransactionId: String(decodedTransaction.originalTransactionId) },
      transaction: platformTx,
      lock: true,
    });
    const previousMaxBranches = existing ? existing.branchCount : null;
    // A genuinely new row, or a real plan change (upgrade/downgrade) — as
    // opposed to a plain renewal of the same plan, which must NOT recompute
    // amount/billingCycle below (see that field's comment).
    const planChanged = !existing || existing.billingPlanId !== plan.id;

    const values = {
      tenantId,
      platform: 'IOS',
      billingPlanId: plan.id,
      branchCount: plan.branchCount,
      productId: decodedTransaction.productId,
      externalOriginalTransactionId: String(decodedTransaction.originalTransactionId),
      externalTransactionId: String(decodedTransaction.transactionId),
      environment: decodedTransaction.environment === 'Production' ? 'PRODUCTION' : 'SANDBOX',
      startDate: new Date(Number(decodedTransaction.purchaseDate)).toISOString().split('T')[0],
      endDate: expiresAt ? expiresAt.toISOString().split('T')[0] : null,
      // Captured only on a new row or a real plan change, then left alone on
      // every subsequent renewal sync — otherwise a later BillingPlan catalog
      // price edit would silently overwrite what this subscriber actually
      // locked in, even though Apple never re-charged them at the new rate.
      // This is what keeps "existing subscriber price" a real, distinct
      // concept from "current catalog price" (see BillingPlan.model.js).
      ...(planChanged
        ? { amount: isAnnual ? plan.annualPrice : plan.monthlyPrice, billingCycle: isAnnual ? 'YEARLY' : 'MONTHLY' }
        : {}),
      status: revoked ? 'CANCELLED' : expiresAt && expiresAt < new Date() ? 'EXPIRED' : 'ACTIVE',
      autoRenew: !revoked,
      paymentStatus: 'PAID',
      lastVerifiedAt: new Date(),
    };

    let subscription;
    // True whenever requestProviderChange handled this row (fresh signup or
    // a real cross-provider migration) — either way it already called
    // reconcileCapacity itself, so the shared block below must skip it.
    // Named for what it means here, not for whether a migration literally
    // happened; the post-commit Stripe-cancel hook below keys off
    // `migratedFrom` instead, which is only ever set for a real migration.
    let reconciledByActivation = false;
    let migratedFrom = null;
    if (existing) {
      // A renewal/resync for an originalTransactionId already on file —
      // never a migration decision (that only ever runs once, in the `else`
      // branch below, the first time a given id is seen). But Apple's own
      // report for THIS transaction could still say ACTIVE even after a
      // prior purchase superseded it locally, if that "supersession" wasn't
      // a real in-app replacement within the same subscription group and
      // this one genuinely kept billing — see subscription-
      // migration.service.js#reconcileRenewalStatus for why blindly
      // trusting that would resurrect a second ACTIVE row. (Confirmed
      // happening on Android's equivalent path during live testing; the two
      // services mirror each other function-for-function, so the same gap
      // applies here even though Apple's stable originalTransactionId makes
      // it rarer in practice.)
      const reconciledValues = await subscriptionMigrationService.reconcileRenewalStatus(
        tenantId,
        existing,
        values,
        { transaction: platformTx }
      );
      await existing.update(reconciledValues, { transaction: platformTx });
      subscription = existing;
    } else {
      // A brand-new Apple subscription for this tenant — first-ever signup
      // or a cross-provider migration. requestProviderChange decides which,
      // under a tenant-row lock so no concurrent purchase/webhook for this
      // same tenant can race this decision. See subscription-migration.service.js.
      let tenantDb = null;
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
      }
      const activation = await subscriptionMigrationService.requestProviderChange(
        tenantId,
        { newPlatform: 'IOS', newSubscriptionValues: values },
        {
          transaction: platformTx,
          tenantDb,
          originListingId,
          idempotencyPrefix: values.externalTransactionId,
          actorType: 'SYSTEM',
        }
      );
      subscription = activation.subscription;
      reconciledByActivation = true;
      migratedFrom = activation.migratedFrom;
    }

    // Only reconcile for an ACTIVE, store-verified entitlement with a real
    // branch-count change to react to — a cancellation/expiry/refund is
    // handled by the expiry cron (it doesn't shrink branchCount, it ends
    // the subscription entirely) and needs no slot trimming here. The
    // `!existing` branch above already reconciled via requestProviderChange,
    // so it's skipped here.
    // subscription.status, not values.status — reconcileRenewalStatus above
    // can override what was about to be written, and .update() leaves the
    // instance holding whatever was actually persisted. Reading values.status
    // here would reconcile capacity for a row that just got refused ACTIVE
    // status, double-counting a superseded row's branchCount.
    if (!reconciledByActivation && subscription.status === 'ACTIVE' && values.branchCount != null) {
      const tenant = await Tenant.findByPk(tenantId, { transaction: platformTx });
      if (tenant?.connectionStringEncrypted) {
        const tenantDb = await TenantDbManager.getConnection(tenantId, tenant.connectionStringEncrypted);
        await subscriptionQuotaService.reconcileCapacity(tenantId, tenantDb, values.branchCount, {
          transaction: platformTx,
          previousMaxBranches,
          originListingId,
          idempotencyPrefix: values.externalTransactionId,
          actorType: 'SYSTEM',
        });
      }
    }

    await platformTx.commit();

    // A real Stripe API call must never happen inside a DB transaction that
    // might still roll back — done here, only after commit, only when this
    // sync just migrated the tenant away from a Stripe subscription.
    if (migratedFrom?.platform === 'STRIPE' && migratedFrom.externalOriginalTransactionId) {
      try {
        const stripeBilling = require('./stripe-billing.service');
        await stripeBilling.cancelAtPeriodEnd(migratedFrom.externalOriginalTransactionId);
      } catch (err) {
        console.warn('[Apple Billing] Failed to schedule Stripe cancellation after migration:', err.message);
      }
    }

    return subscription;
  } catch (err) {
    await platformTx.rollback();
    throw err;
  }
};

/**
 * App Store Server Notifications V2 — Apple POSTing renewal/cancel/refund
 * events at us. `signedPayload` is the raw body Apple sent; verified the
 * same way as getTransactionInfo's response, since this arrives over the
 * public internet with nothing else authenticating it as really Apple.
 */
const handleNotification = async (signedPayload) => {
  const decoded = verifyAndDecode(signedPayload);
  const transactionInfoJws = decoded.data?.signedTransactionInfo;
  if (!transactionInfoJws) {
    // Some notification types (e.g. TEST) carry no transaction — nothing to sync.
    return null;
  }
  const decodedTransaction = verifyAndDecode(transactionInfoJws);

  const { TenantSubscription } = require('../models/platform');
  const existing = await TenantSubscription.findOne({
    where: { externalOriginalTransactionId: String(decodedTransaction.originalTransactionId) },
  });
  if (!existing) {
    // A renewal notification can arrive before the app ever called
    // /billing/ios/sync once (e.g. background renewal while the app isn't
    // open) — nothing to update yet; the next app-initiated sync will
    // create the row. Not an error.
    return null;
  }
  return syncSubscriptionFromTransaction(existing.tenantId, decodedTransaction);
};

module.exports = {
  verifyAndDecode,
  getTransactionInfo,
  findPlanForProductId,
  syncSubscriptionFromTransaction,
  handleNotification,
};
