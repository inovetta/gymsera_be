/**
 * Platform alerts (OBS-06, OBS-09; spec §12.12).
 *
 * One function, `raise(code, details)`, for every "a human must look at this"
 * condition the backend detects (the nightly capacity audit first; the billing
 * event sweep and others reuse it). Channels, in order:
 *
 *   1. a structured log line (always),
 *   2. an in-app notification to every ACTIVE platform admin (`PLATFORM_ALERT`),
 *   3. a Sentry message, only when SENTRY_DSN is set (utils/error-tracker.js).
 *
 * Limits and rules:
 *   - One alert per alert code per hour. Callers aggregate (one alert for "3 tenants",
 *     not three alerts). The limit is read from the stored notifications as well as an
 *     in-process map, so it holds across restarts and a second instance, with or
 *     without Redis (spec §0.1 rule 10).
 *   - IDs and counts only. `details` keys must end in `Count` (a number), `Ids`
 *     (a list of up to 20 id strings) or `Id` (one id string); everything else is dropped.
 *     Names, e-mails and free text can never reach a notification or Sentry.
 *   - Every alert code has a runbook entry (docs/runbooks/, OBS-09); a test fails
 *     when a code is added without one.
 */
const { Sequelize } = require('sequelize');
const { Notification, User } = require('../models/platform');
const errorTracker = require('../utils/error-tracker');

const HOUR_MS = 60 * 60 * 1000;
const MAX_IDS = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NOTIFICATION_TYPE = 'PLATFORM_ALERT';

/** The registry. The anchor is the lower-cased code; the heading in the runbook file is the code. */
const ALERTS = Object.freeze({
  CAPACITY_DRIFT: {
    title: 'Capacity audit: drift found',
    runbook: 'docs/runbooks/capacity-audit.md#capacity_drift',
  },
  CAPACITY_EMPTY_ACTIVE_ORG: {
    title: 'Capacity audit: ACTIVE organization with no ACTIVE branch',
    runbook: 'docs/runbooks/capacity-audit.md#capacity_empty_active_org',
  },
  CAPACITY_AUDIT_FAILED: {
    title: 'Capacity audit could not run for some tenants',
    runbook: 'docs/runbooks/capacity-audit.md#capacity_audit_failed',
  },
  BILLING_EVENT_UNPROCESSED: {
    title: 'Billing events waiting for more than 10 minutes',
    runbook: 'docs/runbooks/billing-events.md#billing_event_unprocessed',
  },
  BILLING_EVENT_FAILED: {
    title: 'Billing events keep failing',
    runbook: 'docs/runbooks/billing-events.md#billing_event_failed',
  },
  BILLING_DUPLICATE_BILLING: {
    title: 'A superseded subscription is still billing a tenant',
    runbook: 'docs/runbooks/billing-events.md#billing_duplicate_billing',
  },
});

// code -> epoch ms of the last alert (or reservation) in this process
const lastRaised = new Map();

const sanitize = (details = {}) => {
  const out = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(details)) {
    if (/Count$/.test(key) && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (/Ids$/.test(key) && Array.isArray(value)) {
      const ids = value.map(String).filter((v) => ID_PATTERN.test(v)).slice(0, MAX_IDS);
      if (ids.length) out[key] = ids;
      else dropped += 1;
    } else if (/Id$/.test(key) && typeof value === 'string' && ID_PATTERN.test(value)) {
      out[key] = value;
    } else {
      dropped += 1;
    }
  }
  return { fields: out, dropped };
};

const describeFields = (fields) =>
  Object.entries(fields)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

/** True when a stored alert of this code is younger than an hour. */
const alertedWithinHour = async (code, nowMs) => {
  const codeOfRow = Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.alertCode'))");
  const row = await Notification.findOne({
    where: {
      type: NOTIFICATION_TYPE,
      createdAt: { [Sequelize.Op.gt]: new Date(nowMs - HOUR_MS) },
      [Sequelize.Op.and]: [Sequelize.where(codeOfRow, code)],
    },
    attributes: ['id'],
  });
  return Boolean(row);
};

/**
 * @param {string} code    a key of ALERTS
 * @param {object} details counts and ids (see the rules above)
 * @returns {Promise<{ sent: boolean, reason?: 'rate_limited' | 'not_delivered' }>}
 */
const raise = async (code, details = {}) => {
  const def = ALERTS[code];
  if (!def) throw new Error(`Unknown alert code "${code}": add it to ALERTS and write its runbook entry`);

  const nowMs = Date.now();
  const previous = lastRaised.get(code);
  if (previous !== undefined && nowMs - previous < HOUR_MS) {
    console.info(`[Alert] ${code} suppressed (already raised within the hour)`);
    return { sent: false, reason: 'rate_limited' };
  }
  // Reserve before any await so concurrent raises of the same code cannot both pass.
  lastRaised.set(code, nowMs);

  try {
    if (await alertedWithinHour(code, nowMs)) {
      console.info(`[Alert] ${code} suppressed (a stored alert is younger than an hour)`);
      return { sent: false, reason: 'rate_limited' };
    }

    const { fields, dropped } = sanitize(details);
    const summary = describeFields(fields);
    console.error(`[Alert] ${code}${summary ? ` ${summary}` : ''}${dropped ? ` (${dropped} field(s) dropped)` : ''}`);

    let delivered = 0;
    const metadata = { alertCode: code, runbook: def.runbook, ...fields };
    const notifications = require('./notifications.service');
    const admins = await User.findAll({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, attributes: ['id'] });
    for (const admin of admins) {
      try {
        await notifications.createNotification({
          userId: admin.id,
          role: 'admin',
          type: NOTIFICATION_TYPE,
          title: def.title,
          message: `${summary || 'See the runbook'}. Runbook: ${def.runbook}`,
          priority: 'high',
          metadataJson: metadata,
        });
        delivered += 1;
      } catch (err) {
        console.warn(`[Alert] Could not notify admin ${admin.id} about ${code}: ${err.message}`);
      }
    }

    const tracked = errorTracker.captureMessage(`${code}: ${def.title}`, {
      level: 'error',
      tags: { alertCode: code },
      extra: fields,
    });

    if (delivered === 0 && !tracked) {
      lastRaised.delete(code); // nothing reached anyone: do not spend the hour
      return { sent: false, reason: 'not_delivered' };
    }
    return { sent: true };
  } catch (err) {
    lastRaised.delete(code);
    console.error(`[Alert] Raising ${code} failed: ${err.message}`);
    return { sent: false, reason: 'not_delivered' };
  }
};

const _resetForTests = () => lastRaised.clear();

module.exports = { raise, ALERTS, NOTIFICATION_TYPE, _resetForTests };
