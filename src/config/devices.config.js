/**
 * ZKTeco Push device settings (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md). Read on every call, so a
 * test or an operator can change one without a restart of anything that cached it.
 *
 * Phase 0 (spec §15 a-g) is not answered yet: every open point is a setting here with the spec's
 * recommended default, never a constant in code. An unknown value logs a warning and falls back
 * to the default, so a typo never takes the device endpoints down.
 *
 * | Variable                   | Default            | Values                     | Spec |
 * |----------------------------|--------------------|----------------------------|------|
 * | DEVICE_REGISTRATION_STYLE  | spec               | spec, gbs                  | §5, Phase 0 (b) |
 * | DEVICE_TOKEN_MODE          | log                | off, log, enforce          | §2, §6.1, Phase 0 (c) |
 * | DEVICE_ENDTIME_FORMAT      | auto               | auto, seconds, yyyymmdd    | §7.4, Phase 0 (e) |
 * | DEVICE_ENROLL_SEPARATOR    | space              | space, tab                 | §7.6, Phase 0 (f) |
 * | DEVICE_LINK_MODE           | host               | host, path, serial         | §4.2, D-1 |
 * | DEVICE_SERIAL_PAIRING      | off                | off, authkey, open         | §4.2 rule 4, D-2 |
 * | DEVICE_ALLOW_HTTP          | true               | true, false                | §4.3, D-3 |
 * | DEVICE_REQUEST_DELAY       | 3                  | 1 to 5                     | §5.1, §9.2 |
 * | DEVICE_PUSH_HOST           | push.gymsera.com   | host name                  | §4.3 |
 * | DEVICE_HOST_KEY_SUFFIXES   | .push.gymsera.com  | comma list                 | §4.3 (mode B) |
 * | DEVICE_PUSH_PORT           | 443                | port                       | §4.4 |
 * | DEVICE_PUSH_HTTPS          | true               | true, false                | §4.4 |
 * | DEVICE_PROXY_LOCAL_HOSTS   | 127.0.0.1:8085     | comma list of host:port    | §4.5 |
 *
 * Phase 2 (sync engine). Phase 0 points first, then the owner decisions D-4 to D-8. D-6: capture
 * photos (ATTPHOTO) are never stored in Phase 2; a branch opt-in with retention is Phase 3.
 * | DEVICE_SEND_USERAUTHORIZE  | true               | true, false                | §2, Phase 0 (d) |
 * | DEVICE_SEND_VALIDITY       | true               | true, false                | §7.4 layer 3, Phase 0 (e) |
 * | DEVICE_PHOTO_FALLBACK      | true               | true, false                | §2, §7.1, Phase 0 (g) |
 * | DEVICE_COUNT_RESULT        | return             | return, querydata          | §8.3 layer 3 (where DATA COUNT answers) |
 * | DEVICE_SEND_USERPIC        | false              | true, false                | §7.1 (optional profile photo) |
 * | DEVICE_EXIT_GRACE_HOURS    | 24                 | 0 to 72                    | §7.1 point 4, D-7 |
 * | DEVICE_BIO_RETENTION_DAYS  | 90                 | 1 to 3650                  | §14 point 6, D-4 |
 * | DEVICE_CONSENT_PENDING_DAYS| 7                  | 1 to 30                    | §7.5 |
 * | DEVICE_PIN_RETIRE_DAYS     | 180                | 30 to 3650                 | §6.3 |
 * | DEVICE_ACK_TIMEOUT_SECONDS | 60                 | 10 to 3600                 | §8.3 layer 1 |
 * | DEVICE_OFFLINE_MINUTES     | 10                 | 2 to 1440                  | §8.3 layer 1 |
 * | DEVICE_SWEEP_MINUTES       | 15                 | 5 to 1440                  | §8.3 layer 2 |
 * | DEVICE_AUDIT_HOUR          | 2                  | 0 to 23                    | §8.3 layer 3 (branch local hour) |
 * | DEVICE_PHOTOS_PER_POLL     | 5                  | 1 to 20                    | §13 |
 */
const ENUMS = {
  DEVICE_REGISTRATION_STYLE: { def: 'spec', values: ['spec', 'gbs'] },
  DEVICE_TOKEN_MODE: { def: 'log', values: ['off', 'log', 'enforce'] },
  DEVICE_ENDTIME_FORMAT: { def: 'auto', values: ['auto', 'seconds', 'yyyymmdd'] },
  DEVICE_ENROLL_SEPARATOR: { def: 'space', values: ['space', 'tab'] },
  DEVICE_LINK_MODE: { def: 'host', values: ['host', 'path', 'serial'] },
  DEVICE_SERIAL_PAIRING: { def: 'off', values: ['off', 'authkey', 'open'] },
};

const warned = new Set();
const warnOnce = (name, value, def) => {
  const key = `${name}=${value}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[devices.config] ${name}="${value}" is not a known value; using "${def}".`);
};

const enumOf = (name) => {
  const { def, values } = ENUMS[name];
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (values.includes(v)) return v;
  warnOnce(name, raw, def);
  return def;
};

const boolOf = (name, def) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  warnOnce(name, raw, String(def));
  return def;
};

const intOf = (name, def, min, max) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnOnce(name, raw, String(def));
  return def;
};

const COUNT_RESULTS = ['return', 'querydata'];
const countResultOf = () => {
  const raw = String(process.env.DEVICE_COUNT_RESULT || '').trim().toLowerCase();
  if (!raw) return 'return';
  if (COUNT_RESULTS.includes(raw)) return raw;
  warnOnce('DEVICE_COUNT_RESULT', raw, 'return');
  return 'return';
};

const listOf = (name, def) =>
  String(process.env[name] || def).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function getDeviceConfig() {
  const pushHost = String(process.env.DEVICE_PUSH_HOST || 'push.gymsera.com').trim().toLowerCase();
  return {
    registrationStyle: enumOf('DEVICE_REGISTRATION_STYLE'),
    tokenMode: enumOf('DEVICE_TOKEN_MODE'),
    endTimeFormat: enumOf('DEVICE_ENDTIME_FORMAT'),
    enrollSeparator: enumOf('DEVICE_ENROLL_SEPARATOR'),
    defaultLinkMode: enumOf('DEVICE_LINK_MODE'),
    serialPairing: enumOf('DEVICE_SERIAL_PAIRING'),
    allowHttp: boolOf('DEVICE_ALLOW_HTTP', true),
    requestDelay: intOf('DEVICE_REQUEST_DELAY', 3, 1, 5),
    pushHost,
    hostKeySuffixes: listOf('DEVICE_HOST_KEY_SUFFIXES', `.${pushHost}`),
    pushPort: intOf('DEVICE_PUSH_PORT', 443, 1, 65535),
    pushHttps: boolOf('DEVICE_PUSH_HTTPS', true),
    proxyLocalHosts: listOf('DEVICE_PROXY_LOCAL_HOSTS', '127.0.0.1:8085'),
    // Phase 2: Phase 0 open points.
    sendUserAuthorize: boolOf('DEVICE_SEND_USERAUTHORIZE', true),
    sendValidity: boolOf('DEVICE_SEND_VALIDITY', true),
    photoFallback: boolOf('DEVICE_PHOTO_FALLBACK', true),
    countResult: countResultOf(),
    // Phase 2: owner decisions and limits.
    sendUserPic: boolOf('DEVICE_SEND_USERPIC', false),
    exitGraceHours: intOf('DEVICE_EXIT_GRACE_HOURS', 24, 0, 72),
    bioRetentionDays: intOf('DEVICE_BIO_RETENTION_DAYS', 90, 1, 3650),
    consentPendingDays: intOf('DEVICE_CONSENT_PENDING_DAYS', 7, 1, 30),
    pinRetireDays: intOf('DEVICE_PIN_RETIRE_DAYS', 180, 30, 3650),
    ackTimeoutSeconds: intOf('DEVICE_ACK_TIMEOUT_SECONDS', 60, 10, 3600),
    offlineMinutes: intOf('DEVICE_OFFLINE_MINUTES', 10, 2, 1440),
    sweepMinutes: intOf('DEVICE_SWEEP_MINUTES', 15, 5, 1440),
    auditHour: intOf('DEVICE_AUDIT_HOUR', 2, 0, 23),
    photosPerPoll: intOf('DEVICE_PHOTOS_PER_POLL', 5, 1, 20),
    // Phase 3: manual push (§9), first-sync batching (§13), owner alerts, wipe on unpair (§10.3).
    pushTimeoutSeconds: intOf('DEVICE_PUSH_TIMEOUT_SECONDS', 15, 5, 60),
    enrollTimeoutSeconds: intOf('DEVICE_ENROLL_TIMEOUT_SECONDS', 60, 15, 300),
    pushOfflineSeconds: intOf('DEVICE_PUSH_OFFLINE_SECONDS', 30, 10, 600),
    pushBranchWindowSeconds: intOf('DEVICE_PUSH_BRANCH_WINDOW_SECONDS', 60, 10, 3600),
    bioBatchSize: intOf('DEVICE_BIO_BATCH_SIZE', 10, 1, 50), // Phase 0: multi-member biodata (1 = off)
    alertErrorsPerHour: intOf('DEVICE_ALERT_ERRORS_PER_HOUR', 20, 1, 10000),
    wipeWaitDays: intOf('DEVICE_WIPE_WAIT_DAYS', 7, 1, 60),
    // Not Phase 0 questions: fixed by the spec.
    pushMemberWindowSeconds: 10, // §9.2: 1 push per member per 10 s per user
    capturePhotoDays: 30, // D-6
    capacityAlertPercent: 90, // §13
    maxAttempts: 5, // §8.1: 4 retries (30 s, 2 min, 10 min, 1 h), then failed
    failedRetriesPerDay: 3, // §8.3 layer 2: failed rows retried after 1 h, at most 3 times a day
    failedRetryAfterMinutes: 60,
    maxBody: '10mb', // §4.3: photos
    maxPackageBytes: 1024 * 1024, // §8.1: min(MaxPackageSize, 1 MB)
    commandsPerPoll: 20, // §8.1
    onlineWindowSeconds: 60, // "online" on the device page: seen within a minute (RequestDelay ≤ 5)
    seenWriteSeconds: 10, // last_seen_at is written at most this often per device
    unclaimedThrottleSeconds: 10, // §5: unclaimed serials, one write per 10 s per contact
    unclaimedMaxRows: 10000, // §6.1: capped
    unclaimedDays: 7, // §6.1: rows expire after 7 days
  };
}

module.exports = { getDeviceConfig, ENUMS };
