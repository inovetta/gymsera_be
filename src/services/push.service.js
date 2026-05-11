/**
 * push.service.js — Firebase Cloud Messaging stub (Sprint 7)
 *
 * Phase 2 will replace this with real firebase-admin SDK integration.
 * Until then, all push calls log to console and no-op gracefully.
 *
 * To activate: npm install firebase-admin, add FIREBASE_SERVICE_ACCOUNT_JSON env var,
 * then uncomment the initialisation block and replace the stub send().
 */

/*
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
*/

/**
 * Send a push notification to a single device token.
 * @param {string} fcmToken  Firebase device registration token
 * @param {string} title     Notification title
 * @param {string} body      Notification body
 * @param {object} [data]    Optional key-value data payload
 */
const send = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Push Stub] Would send FCM notification:');
    console.log(`  Token : ${fcmToken.slice(0, 20)}...`);
    console.log(`  Title : ${title}`);
    console.log(`  Body  : ${body}`);
    return;
  }

  // Production: uncomment when firebase-admin is configured
  // await admin.messaging().send({
  //   token: fcmToken,
  //   notification: { title, body },
  //   data,
  // });
  console.warn('[Push] firebase-admin not yet configured — push not sent');
};

/**
 * Send a push notification to multiple device tokens.
 * @param {string[]} fcmTokens
 * @param {string}   title
 * @param {string}   body
 * @param {object}   [data]
 */
const sendMulticast = async (fcmTokens, title, body, data = {}) => {
  if (!fcmTokens || fcmTokens.length === 0) return;
  await Promise.allSettled(fcmTokens.map((token) => send(token, title, body, data)));
};

module.exports = { send, sendMulticast };
