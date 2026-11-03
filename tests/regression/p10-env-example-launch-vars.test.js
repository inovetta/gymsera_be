/**
 * P10 item 8 (launch readiness): every setting the launch checklist names is in .env.example
 * (Prompt G rule 11). Before: SENTRY_DSN / SENTRY_ENVIRONMENT / SENTRY_RELEASE (OBS-02, R-32,
 * R-53), METRICS_KEY (R-33), LOG_FORMAT / LOG_LEVEL, SLOW_QUERY_MS (R-54), the SEC-06 flip
 * UNKNOWN_FIELDS_STAGE2_MODE (R-61), the grace days MEMBER_CHECKIN_GRACE_DAYS (R-2) and
 * OVERQUOTA_GRACE_DAYS (R-3), REDIS_URL and the discovery cache settings were read by the code
 * but not listed, so a server set up from the example could not know they exist.
 */
const fs = require('fs');
const path = require('path');

const LAUNCH_VARS = [
  'SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE', 'METRICS_KEY', 'LOG_FORMAT', 'LOG_LEVEL', 'SLOW_QUERY_MS',
  'UNKNOWN_FIELDS_STAGE2_MODE', 'MEMBER_CHECKIN_GRACE_DAYS', 'OVERQUOTA_GRACE_DAYS', 'REDIS_URL',
  'DISCOVERY_CDN_MAX_AGE_S', 'DISCOVERY_SNAPSHOT_TTL_MS', 'DISABLE_REDIS', 'SANDBOX_PURCHASES_GO_LIVE',
  'MIN_APP_VERSION_IOS', 'MIN_APP_VERSION_ANDROID', 'SCHEDULED_JOBS',
];

describe('P10: .env.example lists every launch setting', () => {
  const listed = new Set(
    fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8')
      .split('\n')
      .map((l) => (/^#?\s?([A-Z][A-Z0-9_]+)=/.exec(l) || [])[1])
      .filter(Boolean)
  );
  test.each(LAUNCH_VARS)('%s is in .env.example', (name) => {
    expect(listed.has(name)).toBe(true);
  });
  test('and every one of them is really read by the code', () => {
    const src = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? src(path.join(dir, e.name)) : e.name.endsWith('.js') ? [fs.readFileSync(path.join(dir, e.name), 'utf8')] : []);
    const code = src(path.join(__dirname, '../../src')).join('\n');
    for (const name of LAUNCH_VARS) expect({ name, read: code.includes(name) }).toEqual({ name, read: true });
  });
});
