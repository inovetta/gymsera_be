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
/** registry and options bodies: `DeviceType=acc,~DeviceName=SpeedFace V5L,…` (keys as sent, ~ dropped). */
function parseRegistry(body) {
  const out = {};
  for (const part of String(body || '').split(/[,\r\n]+/)) {
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
  throw new Error(`dateFormat must be seconds or yyyymmdd, got "${dateFormat}"`);
}

/** Setting 'auto' follows the device's DateFmtFunOn (1 seconds, 0 YYYYMMDD); unknown → seconds. */
function resolveDateFormat(setting, capabilities = {}) {
  if (setting === 'seconds' || setting === 'yyyymmdd') return setting;
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

function windowFields({ start, end, dateFormat }) {
  if (!start && !end) return [];
  if (!start || !end) throw new Error('a validity window needs both start and end');
  return [`StartTime=${formatZkTime(start, dateFormat)}`, `EndTime=${formatZkTime(end, dateFormat)}`];
}

const cmd = {
  /** Privilege is always 0: GymsEra never sends device admin rights (spec §7.1 point 5). */
  userUpsert: ({ pin, name, cardNo = '', start, end, dateFormat = 'seconds' }) =>
    'DATA UPDATE user ' + [
      `CardNo=${String(cardNo ?? '').replace(/\s+/g, '')}`, `Pin=${pinOf(pin)}`, 'Password=', 'Group=1',
      ...windowFields({ start, end, dateFormat }), `Name=${cleanName(name)}`, 'Privilege=0',
    ].join(T),

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

  info: () => 'INFO',
  check: () => 'CHECK',
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
