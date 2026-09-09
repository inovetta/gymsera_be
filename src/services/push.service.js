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
const path = require('path');

let _firebaseApp = null;
let _initAttempted = false;

const _getFirebaseApp = () => {
  if (!admin) return null;
  if (_firebaseApp) return _firebaseApp;

  if (admin.apps && admin.apps.length > 0) {
    _firebaseApp = admin.apps[0];
    return _firebaseApp;
  }

  try {
    let serviceAccount = null;

    // 1. Try FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON, base64, or file path if mistakenly entered as path)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
      if (raw.startsWith('{')) {
        serviceAccount = JSON.parse(raw);
      } else if (fs.existsSync(raw)) {
        serviceAccount = JSON.parse(fs.readFileSync(raw, 'utf8'));
      } else {
        try {
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          if (decoded.trim().startsWith('{')) {
            serviceAccount = JSON.parse(decoded);
          }
        } catch (_) {}
      }
    }

    // 2. Try FIREBASE_SERVICE_ACCOUNT_PATH
    if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH.trim();
      if (fs.existsSync(p)) {
        serviceAccount = JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    }

    // 3. Try standard local fallback paths
    if (!serviceAccount) {
      const fallbackPaths = [
        path.join(process.cwd(), 'firebase-service-account.json'),
        path.join(process.cwd(), 'service-account.json'),
      ];
      for (const fp of fallbackPaths) {
        if (fs.existsSync(fp)) {
          try {
            serviceAccount = JSON.parse(fs.readFileSync(fp, 'utf8'));
            break;
          } catch (_) {}
        }
      }
    }

    if (serviceAccount && serviceAccount.project_id) {
      _firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log(`[Push] Firebase Admin initialized for project '${serviceAccount.project_id}'`);
      return _firebaseApp;
    }

    // 4. Try Google Application Default credentials
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      _firebaseApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      console.log('[Push] Firebase Admin initialized with GOOGLE_APPLICATION_CREDENTIALS');
      return _firebaseApp;
    }

    if (!_initAttempted) {
      _initAttempted = true;
      console.warn(
        '[Push] Firebase Admin credentials not configured (FIREBASE_SERVICE_ACCOUNT_JSON is empty).\n' +
        '       Push notifications are running in STUB mode (notifications will be logged to console only).\n' +
        '       To enable real FCM push notifications, set FIREBASE_SERVICE_ACCOUNT_JSON in .env with your\n' +
        '       Firebase Service Account private key JSON.'
      );
    }
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
 * Build standard FCM message configuration for single/multicast sends
 */
const _buildFcmPayload = ({ title, body, data = {} }) => {
  // Ensure title and body are available in data payload as well (for client background fallback)
  const enrichedData = {
    title: title || 'GymsEra',
    body: body || '',
    message: body || '',
    ...data,
  };

  const stringData = _sanitizeDataPayload(enrichedData);

  return {
    notification: {
      title: title || 'GymsEra',
      body: body || '',
    },
    data: stringData,
    android: {
      priority: 'high',
      notification: {
        channelId: 'gymsera_high_importance',
        priority: 'high',
        defaultSound: true,
        defaultVibrateTimings: true,
        visibility: 'public',
        notificationCount: 1,
      },
    },
    apns: {
      headers: {
        'apns-priority': '10',
      },
      payload: {
        aps: {
          alert: {
            title: title || 'GymsEra',
            body: body || '',
          },
          sound: 'default',
          badge: 1,
          contentAvailable: true,
        },
      },
    },
  };
};

/**
 * Send a push notification to a single device token.
 * @param {string} fcmToken  Firebase device registration token
 * @param {string} title     Notification title
 * @param {string} body      Notification body
 * @param {object} [data]    Optional key-value data payload
 */
const send = async (fcmToken, title, body, data = {}) => {
  if (!fcmToken) return { success: false, reason: 'no_token' };
  const app = _getFirebaseApp();

  if (!app) {
    console.log(`[Push Stub] Notification to ${fcmToken.slice(0, 16)}... | Title: "${title}" | Body: "${body}"`);
    return { success: true, stub: true };
  }

  try {
    const payload = _buildFcmPayload({ title, body, data });
    const message = {
      token: fcmToken,
      ...payload,
    };

    const response = await admin.messaging(app).send(message);
    console.log(`[Push] Successfully sent FCM message to ${fcmToken.slice(0, 16)}... (ID: ${response})`);
    return { success: true, messageId: response };
  } catch (err) {
    console.warn(`[Push] Error sending FCM message to ${fcmToken.slice(0, 16)}...:`, err.message);
    // If token is dead, attempt to remove it from DB
    if (
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token'
    ) {
      _pruneDeadToken(fcmToken).catch(() => {});
    }
    return { success: false, error: err.message, code: err.code };
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
  if (!fcmTokens || fcmTokens.length === 0) return { success: false, reason: 'no_tokens' };
  const validTokens = [...new Set(fcmTokens.filter(Boolean))];
  if (validTokens.length === 0) return { success: false, reason: 'no_valid_tokens' };

  const app = _getFirebaseApp();
  if (!app) {
    console.log(`[Push Stub] Multicast to ${validTokens.length} devices | Title: "${title}" | Body: "${body}"`);
    return { success: true, stub: true, count: validTokens.length };
  }

  try {
    const payload = _buildFcmPayload({ title, body, data });
    const response = await admin.messaging(app).sendEachForMulticast({
      tokens: validTokens,
      ...payload,
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

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
    };
  } catch (err) {
    console.warn('[Push] Multicast batch failed:', err.message);
    return { success: false, error: err.message };
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
  if (!userId) return { success: false, reason: 'no_user_id' };
  try {
    const { DeviceToken } = require('../models/platform');
    const deviceRecords = await DeviceToken.findAll({
      where: { userId },
      attributes: ['token'],
    });

    const tokens = deviceRecords.map((d) => d.token);

    if (tokens.length === 0) {
      console.log(`[Push] User ${userId} has no registered FCM tokens. Push skipped.`);
      return { success: false, reason: 'no_tokens_for_user' };
    }

    return await sendMulticast(tokens, title, body, data);
  } catch (err) {
    console.warn(`[Push] sendToUser error for user ${userId}:`, err.message);
    return { success: false, error: err.message };
  }
};

/**
 * Check if push service is live or stubbed
 */
const getPushStatus = () => {
  const app = _getFirebaseApp();
  return {
    isConfigured: !!app,
    mode: app ? 'live' : 'stub',
    projectId: app ? (app.options && app.options.credential && app.options.credential.projectId) || 'configured' : null,
  };
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
  getPushStatus,
};
