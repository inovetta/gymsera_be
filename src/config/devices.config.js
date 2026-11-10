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
    // Not Phase 0 questions: fixed by the spec.
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
