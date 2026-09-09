/**
 * push.service.js — Firebase Cloud Messaging (FCM) push notification service
 *
 * Supports real-time push notifications to Android, iOS, and Web clients.
 * Reads credentials from FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH.
 * Gracefully logs and no-ops if credentials are not yet configured.
 */
let admin = null;
try {
  admin = require('firebase-admin');
} catch (loadErr) {
  console.warn('[PushService] firebase-admin is not installed on this host. Push notifications will run in stub mode.');
}
const fs = require('fs');

let _firebaseApp = null;
let _initAttempted = false;

const _getFirebaseApp = () => {
  if (!admin) return null;
  if (_firebaseApp) return _firebaseApp;
  if (_initAttempted) return null;
  _initAttempted = true;

  if (admin.apps && admin.apps.length > 0) {
    _firebaseApp = admin.apps[0];
    return _firebaseApp;
  }


  try {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
      if (raw.startsWith('{')) {
        serviceAccount = JSON.parse(raw);
      } else {
        // Handle base64 encoded JSON
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        serviceAccount = JSON.parse(decoded);
      }
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      if (fs.existsSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
        serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
      }
    }

    if (serviceAccount && serviceAccount.project_id) {
      _firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log(`[Push] Firebase Admin initialized for project '${serviceAccount.project_id}'`);
      return _firebaseApp;
    }

    // Try Google Application Default credentials
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      _firebaseApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      console.log('[Push] Firebase Admin initialized with GOOGLE_APPLICATION_CREDENTIALS');
      return _firebaseApp;
    }

    console.warn('[Push] Firebase Admin credentials not set (FIREBASE_SERVICE_ACCOUNT_JSON). Push notifications will run in stub mode.');
    return null;
  } catch (err) {
    console.warn('[Push] Failed to initialize Firebase Admin SDK:', err.message);
    return null;
  }
};

/**
 * Format data payload so all keys and values are strictly strings (FCM requirement).
 */
const _sanitizeDataPayload = (data = {}) => {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      try {
        result[key] = JSON.stringify(value);
      } catch (_) {
        result[key] = String(value);
      }
    } else {
      result[key] = String(value);
    }
  }
  return result;
};

/**
 * Send a push notification to a single device token.
 * @param {string} fcmToken  Firebase device registration token
 * @param {string} title     Notification title
 * @param {string} body      Notification body
 * @param {object} [data]    Optional key-value data payload
 */
const send = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return;
  const app = _getFirebaseApp();

  if (!app) {
    console.log(`[Push Stub] Notification to ${fcmToken.slice(0, 16)}... | Title: "${title}" | Body: "${body}"`);
    return;
  }

  const stringData = _sanitizeDataPayload(data);

  try {
    const message = {
      token: fcmToken,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'gymsera_high_importance',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            contentAvailable: true,
          },
        },
      },
    };

    const response = await admin.messaging(app).send(message);
    console.log(`[Push] Successfully sent FCM message to ${fcmToken.slice(0, 16)}... (ID: ${response})`);
  } catch (err) {
    console.warn(`[Push] Error sending FCM message to ${fcmToken.slice(0, 16)}...:`, err.message);
    // If token is dead, attempt to remove it from DB
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      _pruneDeadToken(fcmToken).catch(() => {});
    }
  }
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
  const validTokens = [...new Set(fcmTokens.filter(Boolean))];
  if (validTokens.length === 0) return;

  const app = _getFirebaseApp();
  if (!app) {
    console.log(`[Push Stub] Multicast to ${validTokens.length} devices | Title: "${title}" | Body: "${body}"`);
    return;
  }

  const stringData = _sanitizeDataPayload(data);

  try {
    const response = await admin.messaging(app).sendEachForMulticast({
      tokens: validTokens,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'gymsera_high_importance',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: 'default',
            contentAvailable: true,
          },
        },
      },
    });

    console.log(`[Push] Multicast result: ${response.successCount} succeeded, ${response.failureCount} failed`);

    // Prune expired/unregistered tokens
    if (response.failureCount > 0) {
      const deadTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            deadTokens.push(validTokens[idx]);
          }
        }
      });
      if (deadTokens.length > 0) {
        _pruneDeadTokens(deadTokens).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Push] Multicast batch failed:', err.message);
  }
};

/**
 * Send notification to all registered devices of a given user.
 * @param {string} userId
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.body
 * @param {object} [options.data]
 */
const sendToUser = async (userId, { title, body, data = {} }) => {
  if (!userId) return;
  try {
    const { DeviceToken, User } = require('../models/platform');
    const deviceRecords = await DeviceToken.findAll({
      where: { userId },
      attributes: ['token'],
    });

    const tokens = deviceRecords.map((d) => d.token);

    if (tokens.length === 0) {
      console.log(`[Push] User ${userId} has no registered FCM tokens. Push skipped.`);
      return;
    }

    await sendMulticast(tokens, title, body, data);
  } catch (err) {
    console.warn(`[Push] sendToUser error for user ${userId}:`, err.message);
  }
};

/**
 * Internal helper to remove invalid tokens from platform database
 */
const _pruneDeadToken = async (token) => {
  try {
    const { DeviceToken } = require('../models/platform');
    await DeviceToken.destroy({ where: { token } });
    console.log(`[Push] Pruned unregistered token: ${token.slice(0, 16)}...`);
  } catch (_) {}
};

const _pruneDeadTokens = async (tokens) => {
  try {
    const { DeviceToken } = require('../models/platform');
    const { Op } = require('sequelize');
    await DeviceToken.destroy({ where: { token: { [Op.in]: tokens } } });
    console.log(`[Push] Pruned ${tokens.length} unregistered tokens`);
  } catch (_) {}
};


module.exports = {
  send,
  sendMulticast,
  sendToUser,
};
