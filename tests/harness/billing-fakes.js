/**
 * Fake provider APIs for billing tests — no real Apple / Google / Stripe
 * account is ever contacted (spec §14 R-19, sandbox only).
 *
 * Each provider service groups its outbound calls in one object
 * (appleApi / playApi / stripeApi); these helpers replace them with jest
 * spies backed by an in-memory "store truth" the test controls.
 *
 * Apple "JWS" strings here are plain JSON — the fake verifyAndDecode parses
 * them, standing in for the real certificate-chain check.
 */
const appleBilling = require('../../src/services/apple-billing.service');
const googlePlayBilling = require('../../src/services/google-play-billing.service');
const stripeBilling = require('../../src/services/stripe-billing.service');

const DAY = 24 * 60 * 60 * 1000;

/** A decoded Apple transaction, as Apple's API would report it. */
const appleTransaction = ({
  originalTransactionId,
  transactionId = `${originalTransactionId}-1`,
  productId,
  expiresInDays = 30,
  revocationDate = null,
  appAccountToken = undefined,
  price = undefined, // milliunits, as Apple reports it (4990000 = 4990.00)
  currency = undefined,
}) => ({
  originalTransactionId,
  transactionId,
  productId,
  purchaseDate: Date.now() - DAY,
  expiresDate: Date.now() + expiresInDays * DAY,
  environment: 'Sandbox',
  ...(revocationDate ? { revocationDate } : {}),
  ...(appAccountToken ? { appAccountToken } : {}),
  ...(price !== undefined ? { price, currency } : {}),
});

/**
 * Installs fake Apple API calls. `truth` maps originalTransactionId → the
 * decoded transaction Apple currently reports; mutate it to change the truth.
 */
const installAppleFakes = (truth = {}) => {
  const lookup = (id) => {
    const tx = truth[id] || Object.values(truth).find((t) => String(t.transactionId) === String(id));
    if (!tx) throw Object.assign(new Error(`Apple: transaction ${id} not found`), { statusCode: 404 });
    return tx;
  };
  jest.spyOn(appleBilling.appleApi, 'verifyAndDecode').mockImplementation((jws) => JSON.parse(jws));
  jest.spyOn(appleBilling.appleApi, 'getTransactionInfo').mockImplementation(async (id) => lookup(id));
  const latest = jest.spyOn(appleBilling.appleApi, 'getLatestTransaction').mockImplementation(async (id) => lookup(id));
  return { truth, latest };
};

/** An App Store Server Notification body (signedPayload), fake-signed. */
const appleNotificationBody = ({ notificationUUID, notificationType = 'DID_RENEW', subtype, transaction }) => ({
  signedPayload: JSON.stringify({
    notificationUUID,
    notificationType,
    ...(subtype ? { subtype } : {}),
    data: transaction ? { signedTransactionInfo: JSON.stringify(transaction) } : {},
  }),
});

/** A subscriptionsv2 purchase, as the Play Developer API would report it. */
const googlePurchase = ({
  productId,
  basePlanId = 'monthly',
  state = 'SUBSCRIPTION_STATE_ACTIVE',
  expiresInDays = 30,
  latestOrderId = 'GPA.0000-0000-0000-00001',
  acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  obfuscatedExternalAccountId = undefined,
  recurringPrice = undefined, // { currencyCode, units, nanos }, as Play reports it
}) => ({
  subscriptionState: state,
  latestOrderId,
  startTime: new Date(Date.now() - DAY).toISOString(),
  testPurchase: {},
  acknowledgementState,
  ...(obfuscatedExternalAccountId ? { externalAccountIdentifiers: { obfuscatedExternalAccountId } } : {}),
  lineItems: [
    {
      productId,
      expiryTime: new Date(Date.now() + expiresInDays * DAY).toISOString(),
      offerDetails: { basePlanId },
      autoRenewingPlan: { autoRenewEnabled: true, ...(recurringPrice ? { recurringPrice } : {}) },
    },
  ],
});

/** Installs fake Play Developer API calls. `truth` maps purchaseToken → purchase. */
const installGoogleFakes = (truth = {}) => {
  const get = jest.spyOn(googlePlayBilling.playApi, 'getSubscriptionPurchase').mockImplementation(async (token) => {
    if (!truth[token]) throw new Error(`Google: purchase token ${token} not found`);
    return truth[token];
  });
  const ack = jest.spyOn(googlePlayBilling.playApi, 'acknowledgePurchaseIfNeeded').mockResolvedValue(undefined);
  return { truth, get, ack };
};

/** A Pub/Sub push body carrying an RTDN. */
const rtdnBody = ({ messageId, notification }) => ({
  message: {
    messageId,
    data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.test', ...notification })).toString('base64'),
  },
  subscription: 'projects/test/subscriptions/rtdn',
});

/**
 * RTDN push authentication (SEC-03). Pub/Sub push sends a Google-signed OIDC
 * token; here a local RSA key stands in for Google's, and the signing-cert
 * lookup is pointed at it, so the real verifier runs without network.
 */
const RTDN_TEST_AUDIENCE = 'https://api.gymsera.test/api/v1/billing/webhooks/google';
const RTDN_TEST_SERVICE_ACCOUNT = 'rtdn-push@gymsera-test.iam.gserviceaccount.com';
const RTDN_TEST_KID = 'rtdn-test-key';
let _rtdnKeys = null;

const installRtdnAuthFakes = () => {
  if (!_rtdnKeys) {
    _rtdnKeys = require('crypto').generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  process.env.GOOGLE_PLAY_RTDN_AUDIENCE = RTDN_TEST_AUDIENCE;
  process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT = RTDN_TEST_SERVICE_ACCOUNT;
  if (!jest.isMockFunction(googlePlayBilling.rtdnAuth.getSigningCerts)) {
    jest.spyOn(googlePlayBilling.rtdnAuth, 'getSigningCerts').mockResolvedValue({ [RTDN_TEST_KID]: _rtdnKeys.publicKey });
  }
  return _rtdnKeys;
};

/** `Authorization` header value for an RTDN push. `claims` overrides the token's payload. */
const rtdnAuthHeader = (claims = {}, { privateKey } = {}) => {
  const keys = installRtdnAuthFakes();
  const token = require('jsonwebtoken').sign(
    {
      iss: 'https://accounts.google.com',
      aud: RTDN_TEST_AUDIENCE,
      sub: '100000000000000000001',
      email: RTDN_TEST_SERVICE_ACCOUNT,
      email_verified: true,
      ...claims,
    },
    privateKey || keys.privateKey,
    { algorithm: 'RS256', keyid: RTDN_TEST_KID, expiresIn: '5m' }
  );
  return `Bearer ${token}`;
};

/** A Stripe subscription object, as Stripe's API would report it. */
const stripeSubscription = ({
  id, priceId, status = 'active', tenantId, cancelAtPeriodEnd = false, unitAmount = undefined, currency = 'pkr',
}) => ({
  id,
  object: 'subscription',
  status,
  cancel_at_period_end: cancelAtPeriodEnd,
  metadata: tenantId ? { tenantId } : {},
  items: {
    data: [
      {
        price: { id: priceId, ...(unitAmount !== undefined ? { unit_amount: unitAmount, currency } : {}) },
        quantity: 1,
        current_period_start: Math.floor((Date.now() - DAY) / 1000),
        current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000),
      },
    ],
  },
});

/**
 * Installs fake Stripe calls. `truth.subscriptions` maps id → subscription;
 * webhook "signatures" are skipped: the raw body is the event JSON.
 */
const installStripeFakes = (truth = { subscriptions: {} }) => {
  jest.spyOn(stripeBilling.stripeApi, 'verifyWebhookEvent').mockImplementation((rawBody) => JSON.parse(rawBody.toString()));
  const retrieve = jest.spyOn(stripeBilling.stripeApi, 'retrieveSubscription').mockImplementation(async (id) => {
    if (!truth.subscriptions[id]) throw new Error(`Stripe: subscription ${id} not found`);
    return truth.subscriptions[id];
  });
  return { truth, retrieve };
};

module.exports = {
  DAY,
  appleTransaction,
  installAppleFakes,
  appleNotificationBody,
  googlePurchase,
  installGoogleFakes,
  rtdnBody,
  RTDN_TEST_AUDIENCE,
  RTDN_TEST_SERVICE_ACCOUNT,
  installRtdnAuthFakes,
  rtdnAuthHeader,
  stripeSubscription,
  installStripeFakes,
};
