/**
 * ZKTeco Security PUSH protocol: pure functions only (no database, no I/O).
 * Spec: docs/ZKTECO_PUSH_DEVICE_SYNC.md §2, §5, §5.1, §7.1. Manual: protocol 3.1.2, doc 4.8.
 *
 * Parsers accept what devices and the manual both send: tab or space separators, keys in any
 * case, the table name glued to the first field (`biodatapin=`), CRLF, several records per body.
 * Command builders produce the manual's syntax; the router adds `C:<CmdID>:` on delivery.
 *
 * Never log a parsed record: use redact() on anything that may hold a template or photo.
 */
const crypto = require('crypto');

// ── Config (§5.1) ─────────────────────────────────────────────────────────────
const MULTI_BIO_DATA_SUPPORT = '0:1:1:0:0:0:1:0:1:1:1'; // finger, NIR face, palm print, palm, VL face, VL palm
const MULTI_BIO_PHOTO_SUPPORT = '0:0:0:0:0:0:0:0:0:1:1'; // VL face and VL palm photos

/**
 * The lines we answer on `GET cdata?options=all` (registered device, forCdata) and `POST push`.
 * style 'spec': spec §5.1. style 'gbs': the format GymBioSync uses on the owner's devices today
 * (its cdata answer skips registration), with this device's own codes and a real ServerName line.
 */
function configLines({ style = 'spec', registryCode, sessionId, requestDelay = 3, forCdata, sn = '' }) {
  if (style === 'gbs') {
    if (forCdata) {
      return [
        `GET OPTION FROM: ${sn}`, 'ATTLOGStamp=0', 'OPERLOGStamp=0', 'BIODATAStamp=0', 'ATTPHOTOStamp=0',
        'ErrorDelay=10', `Delay=${requestDelay}`, 'TransTimes=00:00;14:00', 'TransInterval=1',
        'TransTables=User Transaction', 'Realtime=1', 'ServerVer=3.0.1', 'ServerName=GymsEra', 'PushProtVer=2.4.1',
        'TransFlag=111111111111', 'SupportPing=1', 'PushOptionsFlag=1', 'registry=ok', `RegistryCode=${registryCode}`,
        `SessionID=${sessionId}`, 'TimeoutSec=10', 'BioPhotoFun=1', 'BioDataFun=1',
        `MultiBioDataSupport=${MULTI_BIO_DATA_SUPPORT}`, `MultiBioPhotoSupport=${MULTI_BIO_PHOTO_SUPPORT}`,
      ];
    }
    return [
      'ServerVersion=3.0.1', 'ServerName=GymsEra', 'PushProtVer=3.0.1', 'ErrorDelay=60', `RequestDelay=${requestDelay}`,
      'TransTimes=00:00;14:00', 'TransInterval=1', 'TransTables=User Transaction', 'Realtime=1',
      `SessionID=${sessionId}`, 'TimeoutSec=10', 'BioPhotoFun=1', 'BioDataFun=1',
      `MultiBioDataSupport=${MULTI_BIO_DATA_SUPPORT}`, `MultiBioPhotoSupport=${MULTI_BIO_PHOTO_SUPPORT}`,
    ];
  }
  const lines = [
    'ServerVersion=3.1.2', 'ServerName=GymsEra', 'PushProtVer=3.1.2', 'ErrorDelay=60', `RequestDelay=${requestDelay}`,
    'TransTimes=00:00;14:00', 'TransInterval=1', 'TransTables=User Transaction', 'Realtime=1',
    `SessionID=${sessionId}`, 'TimeoutSec=10', 'BioPhotoFun=1', 'BioDataFun=1',
    `MultiBioDataSupport=${MULTI_BIO_DATA_SUPPORT}`, `MultiBioPhotoSupport=${MULTI_BIO_PHOTO_SUPPORT}`, 'PushOptionsFlag=1',
  ];
  return forCdata ? ['registry=ok', `RegistryCode=${registryCode}`, ...lines] : lines;
}

// RegistryCode characters: A-Z without I and O, a-z without l and o, 2-9. Built from ranges so the
// source holds no long literal a secret scanner reads as a key (pinned in zkteco-p1-device-key test).
const charRange = (first, last, skip = '') => {
  let out = '';
  for (let c = first.charCodeAt(0); c <= last.charCodeAt(0); c++) {
    const ch = String.fromCharCode(c);
    if (!skip.includes(ch)) out += ch;
  }
  return out;
};
const ALNUM = charRange('A', 'Z', 'IO') + charRange('a', 'z', 'lo') + charRange('2', '9');

/** RegistryCode: random, up to 32 characters (manual §4.2). Never the manual's example value. */
function newRegistryCode(length = 20) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

function newSessionId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// ── Token (spec §2: documented formula, unconfirmed on a device) ──────────────
function expectedToken({ registryCode, sn, sessionId }) {
  return crypto.createHash('md5').update(`${registryCode}${sn}${sessionId}`).digest('hex');
}

function tokenFromCookie(cookie) {
  const m = /(?:^|[\s;,])token=\s*([0-9a-fA-F]{32})/.exec(String(cookie || ''));
  return m ? m[1].toLowerCase() : null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────
/**
 * registry and options bodies: `DeviceType=acc,~DeviceName=SpeedFace V5L,…` (keys as sent, ~ dropped).
 * A comma separates two entries only when a `key=` follows it: `~OEMVendor=ZKTECO CO., LTD.` (T&A PUSH
 * options, Phase 5) keeps its comma.
 */
function parseRegistry(body) {
  const out = {};
  for (const part of String(body || '').split(/[\r\n]+|,(?=\s*~?[A-Za-z_][\w]*=)/)) {
    const clean = part.trim().replace(/^~/, '');
    const i = clean.indexOf('=');
    if (i > 0) out[clean.slice(0, i).trim()] = clean.slice(i + 1).trim();
  }
  return out;
}

const KEY_START = /\s+(?=[A-Za-z_~][\w~]*=)/;

/** One record line → { lower-case key: value }. Tabs when present, else whitespace before `key=`. */
function parseLine(line, table) {
  let text = String(line).replace(/\r$/, '').trim();
  if (table) {
    const prefix = new RegExp(`^${table}(?=\\s|[A-Za-z_]+=)`, 'i');
    text = text.replace(prefix, '').trim();
  }
  const parts = text.includes('\t') ? text.split('\t') : text.split(KEY_START);
  const out = {};
  for (const part of parts) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim().replace(/^~/, '').toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Several records (one per line). `table` strips that leading table name; `positional` names the
 * fields of a line without any `key=` (the ATTLOG fallback).
 */
function parseRecords(body, { table, positional } = {}) {
  const rows = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (positional && !raw.includes('=')) {
      const cols = raw.split('\t').map((c) => c.trim());
      rows.push(Object.fromEntries(positional.map((name, i) => [name, cols[i] ?? ''])));
      continue;
    }
    rows.push(parseLine(raw, table));
  }
  return rows;
}

/** ATTPHOTO `pin=20261110100000-9001.jpg` → '9001'. */
function attPhotoPin(value) {
  const base = String(value || '').replace(/\.jpe?g$/i, '');
  return base.includes('-') ? base.split('-').pop() : base;
}

/** devicecmd body: one `ID=…&Return=…&CMD=…` per line (`return` lower-case occurs too). */
function parseDevicecmd(body) {
  const out = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = {};
    for (const part of line.trim().split('&')) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    const id = Number(kv.id);
    const returnCode = Number(kv.return);
    if (Number.isInteger(id) && id > 0 && Number.isFinite(returnCode)) out.push({ id, returnCode, cmd: kv.cmd || '' });
  }
  return out;
}

/** The N of a `<table>=N` answer: the `count` query parameter when sent, else non-empty lines. */
function recordCount(body, countParam) {
  const n = Number(countParam);
  if (Number.isInteger(n) && n > 0) return n;
  return String(body || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

// ── T&A PUSH (DeviceType=att, Phase 5) ─────────────────────────────────────────
/**
 * The answer to `GET cdata?options=all` from an attendance-protocol device: GymBioSync's option lines
 * (GymBiosyncService ZkPushController.cs: the format these devices run on today), with this device's own
 * random RegistryCode / SessionID, our ServerName, the stamps it reported last (0 = send everything) and the
 * poll delay in every field of `delayFields` (`Delay` is the attendance protocol's getrequest interval and the
 * one GymBioSync sends; `RequestDelay` is the security protocol's).
 */
function attConfigLines({ registryCode, sessionId, sn = '', delay = 3, delayFields = ['Delay'], stamps = {} }) {
  const stamp = (t) => `${t}Stamp=${/^\d{1,12}$/.test(String(stamps[t] ?? '')) ? stamps[t] : 0}`;
  return [
    `GET OPTION FROM: ${sn}`, stamp('ATTLOG'), stamp('OPERLOG'), stamp('BIODATA'), stamp('ATTPHOTO'), 'ErrorDelay=10',
    ...delayFields.map((f) => `${f}=${delay}`), 'TransTimes=00:00;14:00', 'TransInterval=1', 'TransTables=User Transaction',
    'Realtime=1', 'ServerVer=3.0.1', 'ServerName=GymsEra', 'PushProtVer=2.4.1', 'TransFlag=111111111111', 'SupportPing=1',
    'PushOptionsFlag=1', 'registry=ok', `RegistryCode=${registryCode}`, `SessionID=${sessionId}`, 'TimeoutSec=10',
    'BioPhotoFun=1', 'BioDataFun=1', `MultiBioDataSupport=${MULTI_BIO_DATA_SUPPORT}`, `MultiBioPhotoSupport=${MULTI_BIO_PHOTO_SUPPORT}`,
  ];
}

// Units of the att options (ZAM180 Ver3.4.9: ~MaxUserCount=100 on a 10,000-user model, ~MaxFingerCount=60 for
// 6,000 fingerprints, ~MaxAttLogCount=20 for 200,000 records). Face, palm and photo maxima are plain counts.
const ATT_UNITS = { MaxUserCount: 100, MaxFingerCount: 100, MaxAttLogCount: 10000 };
const ATT_COUNT_KEYS = 'UserCount FPCount FaceCount PvCount FvCount TransactionCount UserPhotoCount'.split(' ');
// MultiBioDataSupport position → the option that holds its algorithm version / maximum.
const ATT_VERSION_OF = { 1: 'FPVersion', 2: 'FaceVersion', 7: 'FvVersion', 8: 'PvVersion', 9: 'FaceVersion', 10: 'PvVersion' };
const ATT_MAX_OF = { 1: 'MaxFingerCount', 2: 'MaxFaceCount', 7: 'MaxFvCount', 8: 'MaxPvCount', 9: 'MaxFaceCount', 10: 'MaxPvCount' };

/**
 * `table=options` of a T&A PUSH device → { capabilities, counts } in the registry's terms (an att device never
 * registers): DeviceName, FirmVer, PushVersion, MAC, MaxUserCount in users, MultiBioVersion and
 * MaxMultiBioDataCount by MultiBioDataSupport position. The original options are kept under `options`.
 */
function normalizeAttOptions(options = {}) {
  const num = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const scaled = (k) => (num(options[k]) === null ? null : num(options[k]) * (ATT_UNITS[k] || 1));
  const support = String(options.MultiBioDataSupport || '').split(':');
  const versions = support.map((b, i) => (b === '1' && ATT_VERSION_OF[i] && num(options[ATT_VERSION_OF[i]]) !== null ? String(num(options[ATT_VERSION_OF[i]])) : '0'));
  const maxima = support.map((b, i) => (b === '1' && ATT_MAX_OF[i] && scaled(ATT_MAX_OF[i]) !== null ? String(scaled(ATT_MAX_OF[i])) : '0'));
  // Unquoted names: the source must hold no long quoted literal (secret-scanner guard, zkteco-p1-device-key test).
  const o = options;
  const capabilities = {
    DeviceType: 'att', DeviceName: o.DeviceName, FirmVer: o.FWVersion, PushVersion: o.PushVersion, MAC: o.MAC,
    MultiBioDataSupport: o.MultiBioDataSupport, MultiBioPhotoSupport: o.MultiBioPhotoSupport, Platform: o.Platform,
    OEMVendor: o.OEMVendor, Language: o.Language,
  };
  for (const k of Object.keys(capabilities)) if (capabilities[k] === undefined) delete capabilities[k];
  for (const k of Object.keys(ATT_UNITS)) if (scaled(k) !== null) capabilities[k] = String(scaled(k));
  const plain = { MaxFaceCount: o.MaxFaceCount, MaxPvCount: o.MaxPvCount, MaxFvCount: o.MaxFvCount, MaxUserPhotoCount: o.MaxUserPhotoCount,
    FPVersion: o.FPVersion, FaceVersion: o.FaceVersion, PvVersion: o.PvVersion, FvVersion: o.FvVersion };
  for (const [k, v] of Object.entries(plain)) if (num(v) !== null) capabilities[k] = String(num(v));
  if (support.length > 1) {
    capabilities.MultiBioVersion = versions.join(':');
    capabilities.MaxMultiBioDataCount = maxima.join(':');
  }
  capabilities.options = { ...options };
  const counts = {};
  for (const k of ATT_COUNT_KEYS) if (options[k] !== undefined && options[k] !== '') counts[k] = String(options[k]);
  return { capabilities, counts };
}

/**
 * `getrequest?INFO=` (first poll and every few minutes): firmware, users, fingerprints, attendance records, IP,
 * fingerprint and face algorithm versions, (face templates per enrolment), faces, function flags, …
 * Only the documented positions are named; the whole string is kept in `raw`.
 */
function parseInfo(info) {
  const raw = String(info || '').trim();
  if (!raw) return null;
  const c = raw.split(',').map((v) => v.trim());
  const named = { firmware: 0, UserCount: 1, FPCount: 2, TransactionCount: 3, IPAddress: 4, FPVersion: 5, FaceVersion: 6, FaceCount: 8, FunctionFlags: 9 };
  const out = {};
  for (const [k, i] of Object.entries(named)) if (c[i] !== undefined && c[i] !== '') out[k] = c[i];
  out.raw = raw.slice(0, 255);
  return out;
}

/**
 * `table=OPERLOG` body: one record per line, `<TYPE> key=value⇥…`. USER (users with their names), FP
 * (fingerprint templates, no version: the device's FPVersion applies) and OPLOG (positional: op, operator,
 * time, four objects; admin operations, counted only). Other types (FACE, USERPIC, …) are counted.
 */
function parseOperlog(body) {
  const out = { users: [], fingerprints: [], oplog: [], other: {} };
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const sp = line.search(/[ \t]/);
    const type = (sp > 0 ? line.slice(0, sp) : line).toUpperCase();
    const rest = sp > 0 ? line.slice(sp + 1) : '';
    if (type === 'OPLOG') {
      const [op, admin, time, obj1, obj2, obj3, obj4] = rest.split('\t').map((v) => (v ?? '').trim());
      out.oplog.push({ op, admin, time, obj1, obj2, obj3, obj4 });
      continue;
    }
    const kv = {};
    for (const part of rest.split('\t')) {
      const i = part.indexOf('=');
      if (i > 0) kv[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1);
    }
    if (type === 'USER') {
      out.users.push({
        pin: String(kv.pin ?? '').trim(), name: String(kv.name ?? '').trim(), privilege: Number(kv.pri) || 0,
        cardno: String(kv.card ?? '').trim(), group: String(kv.grp ?? '').trim(),
        start: String(kv.startdatetime ?? '').trim(), end: String(kv.enddatetime ?? '').trim(),
      });
    } else if (type === 'FP') {
      out.fingerprints.push({ pin: String(kv.pin ?? '').trim(), fid: String(kv.fid ?? '').trim(), valid: String(kv.valid ?? '1').trim(), tmp: String(kv.tmp ?? '').trim() });
    } else {
      out.other[type] = (out.other[type] || 0) + 1;
    }
  }
  return out;
}

/**
 * `table=ATTLOG` (T&A PUSH): positional, tab separated: PIN, time, status, verify, workcode, then reserved
 * values and a trailing tab (ZAM180 Ver3.4.9). Space-separated lines (the time holds a space) and keyed
 * lines (`PIN=…⇥TIME=…`) are read too. → [{ pin, time, status, verify, workcode }]
 */
function parseAttlog(body) {
  const rows = [];
  for (const raw of String(body || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    let pin; let time; let status; let verify; let workcode;
    if (/^\s*[A-Za-z]+=/.test(line)) {
      const kv = parseLine(line);
      [pin, time, status, verify, workcode] = [kv.pin, kv.time, kv.status, kv.verify ?? kv.verifytype, kv.workcode];
    } else if (line.includes('\t')) {
      [pin, time, status, verify, workcode] = line.split('\t').map((v) => v.trim());
    } else {
      const t = line.trim().split(/\s+/);
      [pin, time, status, verify, workcode] = [t[0], `${t[1]} ${t[2]}`, t[3], t[4], t[5]];
    }
    const n = (v) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    rows.push({ pin: String(pin ?? '').trim(), time: String(time ?? '').trim(), status: n(status), verify: n(verify), workcode: String(workcode ?? '').trim() });
  }
  return rows;
}

// ── Redaction ─────────────────────────────────────────────────────────────────
const SECRET_KEYS = /(^|[\s&,;?])(tmp|template|content|photo|biophoto|pic)=([^\s&]+)/gi;
const LONG_RUN = /[A-Za-z0-9+/_-]{100,}={0,2}/g;
const cut = (v) => `${v.slice(0, 40)}…[len=${v.length}]`;

function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(SECRET_KEYS, (m, pre, key, val) => (val.length > 40 ? `${pre}${key}=${cut(val)}` : m))
    .replace(LONG_RUN, (m) => cut(m));
}

// ── Time (Appendix 5) and the EndTime format ──────────────────────────────────
function encodeZkTime(y, mo, d, h = 0, mi = 0, s = 0) {
  return ((y - 2000) * 12 * 31 + (mo - 1) * 31 + d - 1) * 86400 + (h * 60 + mi) * 60 + s;
}

/** parts: { year, month, day, hour, minute, second } in the device's local time. */
function formatZkTime(parts, dateFormat) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  if (dateFormat === 'yyyymmdd') return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  if (dateFormat === 'seconds') return String(encodeZkTime(year, month, day, hour, minute, second));
  // Phase 5: the form a T&A PUSH device writes its own ATTLOG times in (StartDatetime / EndDatetime candidate).
  if (dateFormat === 'datetime') {
    const z = (v) => String(v).padStart(2, '0');
    return `${year}-${z(month)}-${z(day)} ${z(hour)}:${z(minute)}:${z(second)}`;
  }
  throw new Error(`dateFormat must be seconds, yyyymmdd or datetime, got "${dateFormat}"`);
}

/** Setting 'auto' follows the device's DateFmtFunOn (1 seconds, 0 YYYYMMDD); unknown → seconds. */
function resolveDateFormat(setting, capabilities = {}) {
  if (setting === 'seconds' || setting === 'yyyymmdd' || setting === 'datetime') return setting;
  return String(capabilities.DateFmtFunOn) === '0' ? 'yyyymmdd' : 'seconds';
}

// ── Command builders ──────────────────────────────────────────────────────────
const T = '\t';

function pinOf(pin) {
  const s = String(pin ?? '').trim();
  if (!/^\d{1,9}$/.test(s)) throw new Error(`PIN must be 1 to 9 digits, got "${s}"`);
  return s;
}

const cleanName = (name) => String(name ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 24);

/**
 * StartTime / EndTime (names: the USERINFO form uses StartDatetime / EndDatetime). No window: no fields,
 * or `=0` when clearWindow (Phase 5, att with validity "none": GymBioSync's exact string, and what the
 * device reports for a user without a window), so an old window on the device is cleared.
 */
function windowFields({ start, end, dateFormat, clearWindow = false }, names = ['StartTime', 'EndTime']) {
  if (!start && !end) return clearWindow ? [`${names[0]}=0`, `${names[1]}=0`] : [];
  if (!start || !end) throw new Error('a validity window needs both start and end');
  return [`${names[0]}=${formatZkTime(start, dateFormat)}`, `${names[1]}=${formatZkTime(end, dateFormat)}`];
}

const cmd = {
  /** Privilege is always 0: GymsEra never sends device admin rights (spec §7.1 point 5). */
  userUpsert: ({ pin, name, cardNo = '', start, end, dateFormat = 'seconds', clearWindow = false }) =>
    'DATA UPDATE user ' + [
      `CardNo=${String(cardNo ?? '').replace(/\s+/g, '')}`, `Pin=${pinOf(pin)}`, 'Password=', 'Group=1',
      ...windowFields({ start, end, dateFormat, clearWindow }), `Name=${cleanName(name)}`, 'Privilege=0',
    ].join(T),

  /**
   * Phase 5: the attendance-protocol form (T&A PUSH firmware), the field names the device uses in its own
   * OPERLOG USER uploads. Pri is always 0. Per device (`user_command_form`); the default for att devices since
   * checklist (i) (2026-11-14: Return 0 on the SpeedFace-V5L T&A PUSH firmware, where `DATA UPDATE user` is -1004).
   */
  userInfoUpsert: ({ pin, name, cardNo = '', start, end, dateFormat = 'datetime', clearWindow = false }) =>
    'DATA UPDATE USERINFO ' + [
      `PIN=${pinOf(pin)}`, `Name=${cleanName(name)}`, 'Pri=0', 'Passwd=', `Card=${String(cardNo ?? '').replace(/\s+/g, '')}`, 'Grp=1',
      ...windowFields({ start, end, dateFormat, clearWindow }, ['StartDatetime', 'EndDatetime']),
    ].join(T),
  userInfoDelete: (pin) => `DATA DELETE USERINFO PIN=${pinOf(pin)}`,
  /** The read a T&A PUSH device answers (checklist (i), #4065): Return 0, the user arrives as an OPERLOG USER upload. */
  queryUserInfo: (pin) => `DATA QUERY USERINFO PIN=${pinOf(pin)}`,

  userAuthorize: ({ pin, timezoneId = 1, doorMask = 1, devId, start, end, dateFormat = 'seconds' }) =>
    'DATA UPDATE userauthorize ' + [
      `Pin=${pinOf(pin)}`, `AuthorizeTimezoneId=${Number(timezoneId)}`, `AuthorizeDoorId=${Number(doorMask)}`,
      ...(devId !== undefined ? [`DevID=${Number(devId)}`] : []), ...windowFields({ start, end, dateFormat }),
    ].join(T),

  /** One biometric type per command, records joined by LF (manual §9.1.1). Version from the template. */
  bioUpsert: (records) => {
    if (!records.length) throw new Error('no biodata records');
    const type = Number(records[0].type);
    const lines = records.map((r) => {
      if (Number(r.type) !== type) throw new Error('bioUpsert takes one biometric type per command');
      if (r.majorVer === undefined || r.majorVer === null) throw new Error('a template needs its stored major version');
      return [
        `Pin=${pinOf(r.pin)}`, `No=${Number(r.no ?? 0)}`, `Index=${Number(r.index ?? 0)}`, `Valid=${r.valid === 0 ? 0 : 1}`,
        `Duress=${r.duress ? 1 : 0}`, `Type=${type}`, `Majorver=${r.majorVer}`, `Minorver=${r.minorVer ?? 0}`,
        `Format=${Number(r.format ?? 0)}`, `Tmp=${r.tmp}`,
      ].join(T);
    });
    return `DATA UPDATE biodata ${lines.join('\n')}`;
  },

  bioPhoto: ({ pin, type = 9, content, postBack = false }) =>
    'DATA UPDATE biophoto ' + [
      `PIN=${pinOf(pin)}`, `Type=${Number(type)}`, `Size=${String(content).length}`, `Content=${content}`,
      'Format=0', `PostBackTmpFlag=${postBack ? 1 : 0}`,
    ].join(T),

  /** Profile photo (§7.1, optional). Content is base64 JPEG. */
  userPic: ({ pin, content }) =>
    'DATA UPDATE userpic ' + [`pin=${pinOf(pin)}`, `size=${String(content).length}`, `content=${content}`].join(T),

  userDelete: (pin) => `DATA DELETE user Pin=${pinOf(pin)}`,
  authDelete: (pin) => `DATA DELETE userauthorize Pin=${pinOf(pin)}`,
  bioDelete: (pin, type) =>
    (type === undefined || type === null ? `DATA DELETE biodata Pin=${pinOf(pin)}` : `DATA DELETE biodata Type=${Number(type)}${T}Pin=${pinOf(pin)}`),
  picDelete: (pin) => `DATA DELETE userpic pin=${pinOf(pin)}`,
  bioPhotoDelete: (pin) => `DATA DELETE biophoto PIN=${pinOf(pin)}`,

  queryUsers: (pin) => `DATA QUERY tablename=user,fielddesc=*,filter=${pin === undefined || pin === null ? '*' : `Pin=${pinOf(pin)}`}`,
  /** The manual: biodata query conditions must include Type. */
  queryBio: (type, pin) =>
    `DATA QUERY tablename=biodata,fielddesc=*,filter=Type=${Number(type)}${pin === undefined || pin === null ? '' : `${T}Pin=${pinOf(pin)}`}`,
  count: (table, type) => {
    if (!['user', 'biodata', 'biophoto', 'userpic', 'userauthorize'].includes(table)) throw new Error(`count: unknown table ${table}`);
    return type === undefined || type === null ? `DATA COUNT ${table}` : `DATA COUNT ${table} Type=${Number(type)}`;
  },

  /** separator: 'space' (spec §2 / §7.6, the manual's example) or 'tab' (the manual's format line). */
  enrollBio: ({ pin, type = 9, no = 0, retry = 3, overwrite = 1, mode = 1, separator = 'space' }) =>
    'ENROLL_BIO ' + [
      `TYPE=${Number(type)}`, `NO=${Number(no)}`, `PIN=${pinOf(pin)}`, `RETRY=${Number(retry)}`,
      `OVERWRITE=${Number(overwrite)}`, `MODE=${Number(mode)}`,
    ].join(separator === 'tab' ? T : ' '),

  /**
   * Remove with wipe (§10.3): every record of a table. `DATA DELETE <table> *` per the spec;
   * biodata one type at a time (the manual: biodata conditions include Type). Phase 0 to confirm.
   */
  wipe: (table, type) => {
    if (!['user', 'userauthorize', 'biodata', 'biophoto', 'userpic'].includes(table)) throw new Error(`wipe: unknown table ${table}`);
    return table === 'biodata' ? `DATA DELETE biodata Type=${Number(type)}` : `DATA DELETE ${table} *`;
  },

  info: () => 'INFO',
  check: () => 'CHECK',
  /** Phase 5: `SET OPTION Delay=3` (attendance protocol); only the keys we set, digits only. */
  setOption: (args = {}) => {
    const pairs = Object.entries(args).filter(([k, v]) => /^[A-Za-z]+$/.test(k) && /^\d{1,6}$/.test(String(v)));
    if (!pairs.length) throw new Error('setOption needs a key and a number');
    return `SET OPTION ${pairs.map(([k, v]) => `${k}=${v}`).join('\t')}`;
  },
};

/**
 * Delivery: `C:<id>:<text>` lines joined by LF, in order, while the body stays within `limit` bytes.
 * The first command always goes (alone, if it is bigger than the limit). The rest wait for the next poll.
 */
function packCommands(rows, limit) {
  const sentIds = [];
  const heldIds = [];
  let body = '';
  for (const row of rows) {
    const line = `C:${row.id}:${row.text}`;
    const next = body ? `${body}\n${line}` : line;
    const fits = heldIds.length === 0 && Buffer.byteLength(next) <= limit;
    if (sentIds.length === 0 || fits) {
      body = next;
      sentIds.push(row.id);
    } else {
      heldIds.push(row.id);
    }
  }
  return { body, sentIds, heldIds };
}

module.exports = {
  attConfigLines,
  normalizeAttOptions,
  parseInfo,
  parseOperlog,
  parseAttlog,
  MULTI_BIO_DATA_SUPPORT,
  REGISTRY_CODE_CHARS: ALNUM,
  MULTI_BIO_PHOTO_SUPPORT,
  configLines,
  newRegistryCode,
  newSessionId,
  expectedToken,
  tokenFromCookie,
  parseRegistry,
  parseRecords,
  parseLine,
  attPhotoPin,
  parseDevicecmd,
  recordCount,
  redact,
  encodeZkTime,
  formatZkTime,
  resolveDateFormat,
  cmd,
  packCommands,
};
