#!/usr/bin/env node
/**
 * zk-capture-server.js: THROW-AWAY Phase 0 spike (docs/ZKTECO_PUSH_DEVICE_SYNC.md §15).
 *
 * A tiny ZKTeco Security PUSH server that answers the handshake (spec §5, §5.1),
 * records every request to captures/<start-time>.txt, and lets you queue test
 * commands from a local page or the CLI. No database, no dependencies, no network
 * calls. Run it on a Mac on the same LAN as the device:
 *
 *   node scripts/zk-capture-server.js --port 8088
 *   open http://127.0.0.1:8088/zkcap            (control page, this Mac only)
 *   node scripts/zk-capture-server.js queue user pin=9001 name="ZK Test"
 *   node scripts/zk-capture-server.js kinds     (list command kinds)
 *
 * Options: --port 8088  --host 0.0.0.0  --captures <dir>  --only-sn <SN[,SN]>
 *          --style spec|gbs  (gbs = answer cdata/push like GymBioSync, with random codes)
 *          --batch 10       (max commands per getrequest)
 *
 * Privacy: template and photo values are cut to their first 40 characters plus
 * the length before anything is written or printed. Wipes (`DELETE ... *`) are refused.
 * Enrol only a test person.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── Constants from the spec (§5.1) ─────────────────────────────────────────────
const SPEC_CONFIG = [
  ['ServerVersion', '3.1.2'],
  ['ServerName', 'GymsEra'],
  ['PushProtVer', '3.1.2'],
  ['ErrorDelay', '60'],
  ['RequestDelay', '3'],
  ['TransTimes', '00:00;14:00'],
  ['TransInterval', '1'],
  ['TransTables', 'User Transaction'],
  ['Realtime', '1'],
  ['SessionID', null], // filled per run
  ['TimeoutSec', '10'],
  ['BioPhotoFun', '1'],
  ['BioDataFun', '1'],
  ['MultiBioDataSupport', '0:1:1:0:0:0:1:0:1:1:1'],
  ['MultiBioPhotoSupport', '0:0:0:0:0:0:0:0:0:1:1'],
  ['PushOptionsFlag', '1'],
];

// The protocol manual's example values. GymBioSync hard-codes these; we never send them.
const MANUAL_EXAMPLE = { registryCode: 'Uy47fxftP3', sessionId: '30BFB04B2C8AECC72C01C03BFD549D15' };

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generateRegistryCode(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[bytes[i] % ALNUM.length];
  return out;
}

function generateSessionId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// ── Config bodies ──────────────────────────────────────────────────────────────
function buildConfigLines({ sessionId, registryCode, forCdata, style = 'spec', sn = '' }) {
  if (style === 'gbs') {
    // GymBioSync's working format (ZkPushController.cs), with our random codes.
    if (forCdata) {
      return [
        `GET OPTION FROM: ${sn}`, 'ATTLOGStamp=0', 'OPERLOGStamp=0', 'BIODATAStamp=0',
        'ATTPHOTOStamp=0', 'ErrorDelay=10', 'Delay=2', 'TransTimes=00:00;14:00',
        'TransInterval=1', 'TransTables=User Transaction', 'Realtime=1', 'ServerVer=3.0.1',
        'PushProtVer=2.4.1', 'TransFlag=111111111111', 'SupportPing=1', 'PushOptionsFlag=1',
        'registry=ok', `RegistryCode=${registryCode}`, `SessionID=${sessionId}`, 'TimeoutSec=10',
        'BioPhotoFun=1', 'BioDataFun=1', 'MultiBioDataSupport=0:1:1:0:0:0:0:0:0:1:0',
        'MultiBioPhotoSupport=0:1:1:0:0:0:0:0:0:1:0',
      ];
    }
    return [
      'ServerVersion=3.0.1', 'ServerName=ADMS', 'PushProtVer=3.0.1', 'ErrorDelay=60',
      'RequestDelay=2', 'TransTimes=00:00;14:00', 'TransInterval=1',
      'TransTables=User Transaction', 'Realtime=1', `SessionID=${sessionId}`, 'TimeoutSec=10',
      'BioPhotoFun=1', 'BioDataFun=1', 'MultiBioDataSupport=0:1:1:0:0:0:0:0:0:1:0',
      'MultiBioPhotoSupport=0:1:1:0:0:0:0:0:0:1:0',
    ];
  }
  const lines = SPEC_CONFIG.map(([k, v]) => `${k}=${k === 'SessionID' ? sessionId : v}`);
  if (forCdata) lines.unshift('registry=ok', `RegistryCode=${registryCode}`);
  return lines;
}

// ── ZKTeco time encoding (protocol Appendix 5 / 6) ─────────────────────────────
function encodeZkTime(y, mo, d, h = 0, mi = 0, s = 0) {
  return ((y - 2000) * 12 * 31 + (mo - 1) * 31 + d - 1) * 86400 + (h * 60 + mi) * 60 + s;
}

function decodeZkTime(tt) {
  const sec = tt % 60; tt = Math.floor(tt / 60);
  const min = tt % 60; tt = Math.floor(tt / 60);
  const hour = tt % 24; tt = Math.floor(tt / 24);
  const day = (tt % 31) + 1; tt = Math.floor(tt / 31);
  const mon = (tt % 12) + 1; tt = Math.floor(tt / 12);
  return { year: tt + 2000, mon, day, hour, min, sec };
}

/** 'now', '+5m', '-1d', '+2h', '+30s', 'YYYY-MM-DD', 'YYYY-MM-DD HH:mm[:ss]' → local Date. */
function parseWhen(value, now = new Date()) {
  const v = String(value).trim();
  if (v === 'now') return new Date(now);
  const rel = /^([+-])(\d+)([smhd])$/.exec(v);
  if (rel) {
    const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[3]];
    return new Date(now.getTime() + (rel[1] === '-' ? -1 : 1) * Number(rel[2]) * mult);
  }
  const abs = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (abs) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = abs;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  }
  throw new Error(`Cannot read time "${value}" (use now, +5m, -1d, YYYY-MM-DD or "YYYY-MM-DD HH:mm")`);
}

/** Device-local wall time from a Date (the Mac's local clock is assumed to match the device). */
function formatZkTime(date, datefmt) {
  const p = [date.getFullYear(), date.getMonth() + 1, date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds()];
  if (datefmt === 'yyyymmdd') return `${p[0]}${String(p[1]).padStart(2, '0')}${String(p[2]).padStart(2, '0')}`;
  if (datefmt === 'seconds') return String(encodeZkTime(...p));
  throw new Error(`datefmt must be seconds or yyyymmdd, got "${datefmt}"`);
}

// ── Redaction: templates and photos never written in full ──────────────────────
const SECRET_KEYS = /(^|[\s&,;?])(tmp|template|content|photo|biophoto|pic)=([^\s&]+)/gi;
const LONG_RUN = /[A-Za-z0-9+/_-]{100,}={0,2}/g;

function cut(value) {
  return `${value.slice(0, 40)}…[len=${value.length}]`;
}

function redactText(text) {
  if (!text) return text;
  return String(text)
    .replace(SECRET_KEYS, (m, pre, key, val) => (val.length > 40 ? `${pre}${key}=${cut(val)}` : m))
    .replace(LONG_RUN, (m) => cut(m));
}

// ── Parsing helpers ────────────────────────────────────────────────────────────
/** key=value pairs; default separators tab, space or & (case kept). */
function parseKv(line, sep = /[\t &]+/) {
  const out = {};
  for (const part of String(line).split(sep)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** registry / options bodies: `DeviceType=acc,~DeviceName=SpeedFace V5L,FirmVer=…` */
function parseRegistry(body) {
  const out = {};
  for (const part of String(body || '').split(/[,\r\n]+/)) {
    const clean = part.trim().replace(/^~/, '');
    const i = clean.indexOf('=');
    if (i > 0) out[clean.slice(0, i)] = clean.slice(i + 1);
  }
  return out;
}

function parseDevicecmd(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const kv = {};
      for (const part of line.split('&')) {
        const i = part.indexOf('=');
        if (i > 0) kv[part.slice(0, i).toLowerCase()] = part.slice(i + 1);
      }
      return { id: Number(kv.id), returnCode: Number(kv.return), cmd: kv.cmd || '' };
    })
    .filter((r) => Number.isFinite(r.id));
}

function countRecords(body) {
  return String(body || '').split(/\r?\n/).filter((l) => l.trim()).length;
}

/** Candidate token formulas, so test (c) shows which one the device really uses. */
function tokenCandidates({ registryCode, sn, sessionId, timestamp }) {
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const parts = { RegistryCode: registryCode, SerialNumber: sn, SessionID: sessionId };
  const names = Object.keys(parts);
  const out = [];
  const orders = [];
  for (const a of names) for (const b of names) for (const c of names) {
    if (new Set([a, b, c]).size === 3) orders.push([a, b, c]);
  }
  for (const order of orders) {
    const base = order.map((n) => parts[n]).join('');
    out.push({ formula: `md5(${order.join('+')})`, token: md5(base) });
    out.push({ formula: `md5(${order.join('+')}, SessionID lower-case)`,
      token: md5(order.map((n) => (n === 'SessionID' ? parts[n].toLowerCase() : parts[n])).join('')) });
    if (timestamp) out.push({ formula: `md5(${order.join('+')}+timestamp)`, token: md5(base + timestamp) });
  }
  return out;
}

function checkToken(cookie, ctx) {
  const m = /token=\s*([0-9a-fA-F]{32})/.exec(cookie || '');
  if (!m) return null;
  const ts = /timestamp=\s*(\d+)/.exec(cookie || '');
  const token = m[1].toLowerCase();
  const sets = [
    { label: 'this run', registryCode: ctx.registryCode, sessionId: ctx.sessionId },
    { label: 'manual example codes (GymBioSync)', ...MANUAL_EXAMPLE },
  ];
  for (const set of sets) {
    const hit = tokenCandidates({ ...set, sn: ctx.sn, timestamp: ts && ts[1] }).find((c) => c.token === token);
    if (hit) return `MATCH ${hit.formula} with ${set.label}`;
  }
  return 'no candidate formula matched';
}

// ── Command builders (golden strings; the "C:<id>:" prefix is added on delivery) ──
const RTLOG_EVENTS = {
  0: 'normal verify open', 20: 'too short interval', 21: 'door inactive time zone',
  22: 'illegal time zone', 23: 'access denied', 27: 'not registered', 29: 'user expired (privilege expired)',
  34: 'illegal card / anti-passback?', 41: 'verify mode error',
};

const KINDS = {
  user: 'DATA UPDATE user: pin, name, card, window=none|zero|set, start, end, datefmt',
  userauthorize: 'DATA UPDATE userauthorize: pin, tz=1, door=1, devid, window=none|set, start, end, datefmt',
  'delete-user': 'DATA DELETE user Pin=<pin>',
  'delete-userauthorize': 'DATA DELETE userauthorize Pin=<pin>',
  'delete-biodata': 'DATA DELETE biodata [Type=<type>] Pin=<pin>',
  'query-user': 'DATA QUERY user: pin=<pin> (or all=1 for every user: avoid on a gym device)',
  'query-biodata': 'DATA QUERY biodata: type=9, pin=<pin> (or all=1)',
  'count-user': 'DATA COUNT user',
  'count-biodata': 'DATA COUNT biodata [Type=<type>]',
  'enroll-bio': 'ENROLL_BIO: pin, type=9, no=0, retry=3, overwrite=1, mode=1, sep=tab|space',
  biophoto: 'DATA UPDATE biophoto: pin, file=<jpg on this Mac>, type=9, format=base64|url, postback=1',
  info: 'INFO',
  check: 'CHECK',
  raw: 'any command text: text="..." (wipes refused)',
};

function req(params, key) {
  const v = params[key];
  if (v === undefined || v === null || String(v).trim() === '') throw new Error(`${key} is required`);
  return String(v).trim();
}

function pinOf(params) {
  const pin = req(params, 'pin');
  if (pin.includes('*')) throw new Error('pin=* is refused: this spike never wipes a device');
  if (!/^\d{1,9}$/.test(pin)) throw new Error('pin must be digits');
  return pin;
}

function windowFields(params, ctx) {
  const mode = params.window || (params.start || params.end ? 'set' : 'none');
  if (mode === 'none') return [];
  if (mode === 'zero') return ['StartTime=0', 'EndTime=0'];
  if (mode !== 'set') throw new Error('window must be none, zero or set');
  const datefmt = params.datefmt || ctx.datefmt || 'seconds';
  const now = ctx.now ? ctx.now() : new Date();
  const start = formatZkTime(parseWhen(params.start || 'now', now), datefmt);
  const end = formatZkTime(parseWhen(req(params, 'end'), now), datefmt);
  return [`StartTime=${start}`, `EndTime=${end}`];
}

function buildCommand(kind, params = {}, ctx = {}) {
  const tab = '\t';
  switch (kind) {
    case 'user': {
      const name = String(params.name ?? 'ZK Test').slice(0, 24);
      return 'DATA UPDATE user ' + [
        `CardNo=${params.card ?? ''}`, `Pin=${pinOf(params)}`, 'Password=', 'Group=1',
        ...windowFields(params, ctx), `Name=${name}`, 'Privilege=0',
      ].join(tab);
    }
    case 'userauthorize': {
      const f = [`Pin=${pinOf(params)}`, `AuthorizeTimezoneId=${params.tz ?? 1}`,
        `AuthorizeDoorId=${params.door ?? 1}`];
      if (params.devid !== undefined) f.push(`DevID=${params.devid}`);
      return 'DATA UPDATE userauthorize ' + [...f, ...windowFields(params, ctx)].join(tab);
    }
    case 'delete-user': return `DATA DELETE user Pin=${pinOf(params)}`;
    case 'delete-userauthorize': return `DATA DELETE userauthorize Pin=${pinOf(params)}`;
    case 'delete-biodata': {
      const pin = pinOf(params);
      return params.type !== undefined
        ? `DATA DELETE biodata Type=${Number(params.type)}${tab}Pin=${pin}`
        : `DATA DELETE biodata Pin=${pin}`;
    }
    case 'query-user': {
      if (params.all === '1' || params.all === 1 || params.all === true) {
        return 'DATA QUERY tablename=user,fielddesc=*,filter=*';
      }
      return `DATA QUERY tablename=user,fielddesc=*,filter=Pin=${pinOf(params)}`;
    }
    case 'query-biodata': {
      // The manual: "Query conditions must include Type".
      const type = Number(params.type ?? 9);
      if (params.all === '1' || params.all === 1 || params.all === true) {
        return `DATA QUERY tablename=biodata,fielddesc=*,filter=Type=${type}`;
      }
      return `DATA QUERY tablename=biodata,fielddesc=*,filter=Type=${type}${tab}Pin=${pinOf(params)}`;
    }
    case 'count-user': return 'DATA COUNT user';
    case 'count-biodata':
      return params.type !== undefined ? `DATA COUNT biodata Type=${Number(params.type)}` : 'DATA COUNT biodata';
    case 'enroll-bio': {
      const sep = params.sep === 'space' ? ' ' : tab;
      return 'ENROLL_BIO ' + [
        `TYPE=${Number(params.type ?? 9)}`, `NO=${Number(params.no ?? 0)}`, `PIN=${pinOf(params)}`,
        `RETRY=${Number(params.retry ?? 3)}`, `OVERWRITE=${Number(params.overwrite ?? 1)}`,
        `MODE=${Number(params.mode ?? 1)}`,
      ].join(sep);
    }
    case 'biophoto': {
      const pin = pinOf(params);
      const file = req(params, 'file');
      const b64 = (ctx.readFile || fs.readFileSync)(file).toString('base64');
      const type = Number(params.type ?? 9);
      const postback = Number(params.postback ?? 1);
      if ((params.format || 'base64') === 'url') {
        if (!ctx.photoUrl) throw new Error('format=url needs the server to serve the photo');
        const url = ctx.photoUrl(file);
        return 'DATA UPDATE biophoto ' + [`PIN=${pin}`, `Type=${type}`, `Size=${b64.length}`,
          'Format=1', `Url=${url}`, `PostBackTmpFlag=${postback}`].join(tab);
      }
      return 'DATA UPDATE biophoto ' + [`PIN=${pin}`, `Type=${type}`, `Size=${b64.length}`,
        `Content=${b64}`, 'Format=0', `PostBackTmpFlag=${postback}`].join(tab);
    }
    case 'info': return 'INFO';
    case 'check': return 'CHECK';
    case 'raw': {
      const text = req(params, 'text');
      if (/DELETE\s+\S+\s+\*|\bCLEAR\b/i.test(text)) throw new Error('raw: wipes are refused in this spike');
      if (/filter=\*/i.test(text) && String(params.all) !== '1') {
        throw new Error('raw: a full-table query needs all=1 (avoid it on a device with real members)');
      }
      return text;
    }
    default:
      throw new Error(`Unknown kind "${kind}". Known: ${Object.keys(KINDS).join(', ')}`);
  }
}

// ── Server ─────────────────────────────────────────────────────────────────────
function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createCaptureServer(opts = {}) {
  const state = {
    registryCode: opts.registryCode || generateRegistryCode(),
    sessionId: opts.sessionId || generateSessionId(),
    style: opts.style || 'spec',
    onlySn: opts.onlySn ? new Set(opts.onlySn) : null,
    batch: opts.batch || 10,
    devices: new Map(), // SN → { registered, registry, options, host, pathKey, ip, lastSeen, lastToken }
    queue: [], // { id, sn, kind, text, status, createdAt, sentAt, returnCode, cmd }
    scans: [],
    photos: new Map(), // name → absolute path (served for biophoto Format=1)
    nextId: 1000 + crypto.randomInt(8000),
    seq: 0,
    port: opts.port,
  };
  const log = opts.log || ((line) => console.log(line));
  const capturesDir = opts.capturesDir || path.join(process.cwd(), 'captures');
  fs.mkdirSync(capturesDir, { recursive: true });
  const captureFile = path.join(capturesDir, `${stamp()}.txt`);
  state.captureFile = captureFile;
  fs.appendFileSync(captureFile,
    `# zk-capture-server run ${new Date().toISOString()} style=${state.style}\n` +
    `# RegistryCode=${state.registryCode} SessionID=${state.sessionId} (random for this run)\n`);

  function device(sn) {
    if (!state.devices.has(sn)) state.devices.set(sn, { registered: false, registry: null, options: {} });
    return state.devices.get(sn);
  }

  function datefmtFor(sn) {
    const d = sn && state.devices.get(sn);
    const v = d && ((d.registry && d.registry.DateFmtFunOn) ?? d.options.DateFmtFunOn);
    if (v === '0') return 'yyyymmdd';
    return 'seconds';
  }

  function enqueue(kind, params = {}) {
    const sn = params.sn || (state.devices.size === 1 ? [...state.devices.keys()][0] : null);
    if (!sn && state.devices.size > 1) throw new Error('More than one device seen: pass sn=<serial>');
    const ctx = {
      datefmt: datefmtFor(sn),
      photoUrl: (file) => {
        const name = `p${state.photos.size + 1}.jpg`;
        state.photos.set(name, path.resolve(file));
        return `http://${opts.publicHost || lanAddress()}:${state.port}/zkcap/photo/${name}`;
      },
    };
    const text = buildCommand(kind, params, ctx);
    const item = { id: state.nextId++, sn, kind, text, status: 'queued', createdAt: new Date().toISOString() };
    state.queue.push(item);
    log(`QUEUED #${item.id} ${redactText(text)}${sn ? '' : '  (for the first device that polls)'}`);
    return item;
  }

  function takeCommands(sn) {
    const out = [];
    for (const item of state.queue) {
      if (out.length >= state.batch) break;
      if (item.status !== 'queued') continue;
      if (item.sn && item.sn !== sn) continue;
      item.sn = sn;
      item.status = 'sent';
      item.sentAt = new Date().toISOString();
      out.push(`C:${item.id}:${item.text}`);
    }
    return out;
  }

  function handleIclock(route, q, body, ctx) {
    const sn = q.SN || q.sn || '';
    const dev = sn ? device(sn) : null;
    if (dev) {
      dev.lastSeen = new Date().toISOString();
      dev.ip = ctx.ip;
      dev.host = ctx.host;
      if (ctx.pathKey) dev.pathKey = ctx.pathKey;
      if (q.pushver) dev.pushver = q.pushver;
    }
    const table = q.tablename || q.table || '';
    switch (route) {
      case 'cdata':
        if (ctx.method === 'GET') {
          if (dev && dev.registered) {
            return buildConfigLines({ ...state, sn, forCdata: true });
          }
          if (dev && state.style === 'gbs') {
            dev.registered = true;
            return buildConfigLines({ ...state, sn, forCdata: true });
          }
          return ['OK'];
        }
        if ((q.type || '').toLowerCase() === 'biodata') {
          log(`ENROLL RESULT (type=BioData) from ${sn}: ${redactText(body).slice(0, 300)}`);
          return ['OK'];
        }
        if ((q.table || '').toLowerCase() === 'tabledata') {
          const n = Number(q.count) || countRecords(body);
          log(`UPLOAD tablename=${table} records=${n} bytes=${Buffer.byteLength(body || '')}`);
          return [`${table}=${n}`];
        }
        if (/^(rtlog|attlog)$/i.test(table)) {
          for (const line of String(body).split(/\r?\n/).filter((l) => l.trim())) {
            const r = parseKv(line, /\t+/);
            const ev = Number(r.event);
            const scan = { at: new Date().toISOString(), time: r.time, pin: r.pin, event: r.event,
              meaning: RTLOG_EVENTS[ev] || '', verifytype: r.verifytype, inoutstatus: r.inoutstatus, index: r.index };
            state.scans.push(scan);
            log(`SCAN pin=${r.pin} event=${r.event} ${scan.meaning} verifytype=${r.verifytype} inout=${r.inoutstatus} index=${r.index}`);
          }
          return ['OK'];
        }
        if (/^options$/i.test(table) && dev) {
          Object.assign(dev.options, parseRegistry(body));
        }
        return ['OK'];
      case 'registry': {
        if (!sn || (state.onlySn && !state.onlySn.has(sn))) {
          log(`REGISTRY REFUSED (406) SN=${sn || '(none)'}`);
          return { status: 406, lines: ['Not Acceptable'] };
        }
        dev.registry = parseRegistry(body);
        dev.registryRaw = body;
        dev.registered = true;
        const r = dev.registry;
        log(`REGISTERED ${sn}: DeviceType=${r.DeviceType} FirmVer=${r.FirmVer} DeviceName=${r.DeviceName} ` +
          `DateFmtFunOn=${r.DateFmtFunOn} authKey=${'authKey' in r ? 'sent' : 'not sent'} ` +
          `MultiBioVersion=${r.MultiBioVersion} MultiBioDataSupport=${r.MultiBioDataSupport}`);
        return [`RegistryCode=${state.registryCode}`];
      }
      case 'push':
        return buildConfigLines({ ...state, sn, forCdata: false });
      case 'getrequest': {
        const cmds = sn ? takeCommands(sn) : [];
        if (cmds.length) log(`SENT ${cmds.length} command(s) to ${sn}: ${cmds.map((c) => redactText(c).slice(0, 120)).join(' | ')}`);
        return cmds.length ? cmds : ['OK'];
      }
      case 'devicecmd':
        for (const r of parseDevicecmd(body)) {
          const item = state.queue.find((c) => c.id === r.id);
          if (item) Object.assign(item, { status: r.returnCode >= 0 ? 'acked' : 'failed', returnCode: r.returnCode, cmd: r.cmd, ackedAt: new Date().toISOString() });
          log(`RESULT #${r.id} Return=${r.returnCode} CMD=${r.cmd}${item ? ` (${item.kind})` : ' (unknown id)'}`);
        }
        return ['OK'];
      case 'querydata': {
        const n = Number(q.count) || countRecords(body);
        log(`QUERYDATA cmdid=${q.cmdid} type=${q.type} tablename=${table} count=${n} pack=${q.packidx}/${q.packcnt} bytes=${Buffer.byteLength(body || '')}`);
        if (q.type === 'count') log(`  COUNT ${redactText(body).trim()}`);
        return [`${table}=${n}`];
      }
      case 'ping':
        return ['OK'];
      default:
        log(`UNKNOWN iclock path /iclock/${route} (answered OK)`);
        return ['OK'];
    }
  }

  function send(res, status, text, type = 'text/plain; charset=utf-8') {
    const buf = Buffer.from(text, 'utf8');
    res.writeHead(status, {
      Date: new Date().toUTCString(),
      'Content-Type': type,
      'Content-Length': buf.length,
      Server: 'GymsEra-capture',
    });
    res.end(buf);
    return text;
  }

  function writeCapture(entry) {
    const headerLines = Object.entries(entry.headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
    fs.appendFileSync(captureFile, [
      `\n==== #${entry.seq} ${entry.at} from ${entry.ip}`,
      `${entry.method} ${entry.path}`,
      `query: ${JSON.stringify(entry.query)}`,
      'headers:', headerLines,
      ...(entry.token ? [`token check: ${entry.token}`] : []),
      `body (${entry.bodyBytes} bytes):`, redactText(entry.body),
      `---- response ${entry.status} (${Buffer.byteLength(entry.response)} bytes):`, redactText(entry.response),
    ].join('\n') + '\n');
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 20 * 1024 * 1024) chunks.push(c);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://local');
      const q = Object.fromEntries(url.searchParams);
      const ip = req.socket.remoteAddress;
      let status = 200;
      let response = '';
      let pathKey = null;
      let p = url.pathname;
      const keyed = /^\/d\/([A-Za-z0-9]{4,32})(\/iclock\/.*)$/.exec(p);
      if (keyed) { pathKey = keyed[1]; p = keyed[2]; }

      try {
        if (p.startsWith('/zkcap')) {
          return handleControl(req, res, p, body, ip);
        }
        const m = /^\/iclock\/([^/]+)\/?$/i.exec(p);
        if (m) {
          const result = handleIclock(m[1].toLowerCase(), q, body, { method: req.method, ip, host: req.headers.host, pathKey });
          const lines = Array.isArray(result) ? result : result.lines;
          status = Array.isArray(result) ? 200 : result.status;
          response = send(res, status, lines.join('\n') + '\n');
        } else {
          log(`NON-ICLOCK path ${req.method} ${p} (answered OK)`);
          response = send(res, 200, 'OK\n');
        }
      } catch (err) {
        log(`ERROR ${err.message} (answered OK)`);
        response = send(res, 200, 'OK\n');
      }
      const sn = q.SN || q.sn || '';
      const token = checkToken(req.headers.cookie, { ...state, sn });
      if (sn && token) device(sn).lastToken = token;
      const entry = { seq: ++state.seq, at: new Date().toISOString(), ip, method: req.method,
        path: req.url, query: q, headers: req.headers, token, body, bodyBytes: size, status, response };
      writeCapture(entry);
      if (!/getrequest/i.test(p) || response.trim() !== 'OK') {
        log(`${entry.at.slice(11, 19)} ${req.method} ${p}${pathKey ? ` [path key ${pathKey}]` : ''} SN=${sn} host=${req.headers.host} → ${status} ${redactText(response).split('\n')[0]}`);
      }
    });
  });

  function handleControl(req, res, p, body, ip) {
    const photo = /^\/zkcap\/photo\/(p\d+\.jpg)$/.exec(p);
    if (photo && state.photos.has(photo[1])) {
      const buf = fs.readFileSync(state.photos.get(photo[1]));
      res.writeHead(200, { Date: new Date().toUTCString(), 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
      log(`PHOTO served ${photo[1]} to ${ip}`);
      return res.end(buf);
    }
    if (!isLoopback(ip)) return send(res, 404, 'Not Found\n');
    if (p === '/zkcap' || p === '/zkcap/') return send(res, 200, CONTROL_PAGE, 'text/html; charset=utf-8');
    if (p === '/zkcap/state') {
      const devices = Object.fromEntries([...state.devices].map(([sn, d]) => [sn, { ...d, registryRaw: undefined }]));
      return send(res, 200, JSON.stringify({
        registryCode: state.registryCode, sessionId: state.sessionId, style: state.style,
        captureFile, devices, kinds: KINDS,
        queue: state.queue.map((c) => ({ ...c, text: redactText(c.text) })), scans: state.scans.slice(-30),
      }, null, 2), 'application/json');
    }
    if (p === '/zkcap/queue' && req.method === 'POST') {
      try {
        const { kind, ...params } = JSON.parse(body || '{}');
        const item = enqueue(kind, params);
        return send(res, 200, JSON.stringify({ ok: true, id: item.id, text: redactText(item.text) }), 'application/json');
      } catch (err) {
        return send(res, 400, JSON.stringify({ ok: false, error: err.message }), 'application/json');
      }
    }
    return send(res, 404, 'Not Found\n');
  }

  return {
    server, state, enqueue, captureFile,
    listen: (port = opts.port ?? 8088, host = opts.host ?? '0.0.0.0') =>
      new Promise((resolve) => server.listen(port, host, () => {
        state.port = server.address().port;
        resolve(state.port);
      })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const CONTROL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ZK capture</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px system-ui;margin:16px;max-width:900px}input,select,button{font:inherit;margin:2px}
pre{background:#f4f4f4;padding:8px;overflow:auto;max-height:420px}label{display:inline-block;margin-right:8px}</style>
</head><body><h1>ZK capture server</h1>
<p>Enrol only a test person. Commands are delivered on the device's next poll (about 3 s).</p>
<form id="f"><select id="kind"></select>
<label>pin <input name="pin" size="7" value="9001"></label>
<label>name <input name="name" value="ZK Test"></label>
<label>card <input name="card" size="10"></label>
<label>window <select name="window"><option>none</option><option>zero</option><option>set</option></select></label>
<label>start <input name="start" size="16" placeholder="now"></label>
<label>end <input name="end" size="16" placeholder="+2m"></label>
<label>datefmt <select name="datefmt"><option value="">auto</option><option>seconds</option><option>yyyymmdd</option></select></label>
<label>type <input name="type" size="3"></label>
<label>sep <select name="sep"><option>tab</option><option>space</option></select></label>
<label>file <input name="file" size="30" placeholder="/Users/you/test-face.jpg"></label>
<label>format <select name="format"><option>base64</option><option>url</option></select></label>
<label>text <input name="text" size="40"></label>
<button>Queue</button></form><pre id="out"></pre><h2>State</h2><pre id="st"></pre>
<script>
const st=document.getElementById('st'),out=document.getElementById('out'),kind=document.getElementById('kind');
async function load(){const s=await (await fetch('/zkcap/state')).json();
if(!kind.options.length)for(const k of Object.keys(s.kinds)){const o=document.createElement('option');o.value=k;o.textContent=k+' ('+s.kinds[k]+')';kind.appendChild(o)}
st.textContent=JSON.stringify(s,null,2)}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const body={kind:kind.value};
for(const el of e.target.elements){if(el.name&&el.value)body[el.name]=el.value}
const r=await fetch('/zkcap/queue',{method:'POST',body:JSON.stringify(body)});out.textContent=await r.text();load()};
load();setInterval(load,3000);
</script></body></html>`;

// ── CLI ────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else rest.push(argv[i]);
  }
  return { flags, rest };
}

async function cliQueue(kind, pairs, port) {
  const params = { kind };
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i)] = p.slice(i + 1);
  }
  const body = JSON.stringify(params);
  await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/zkcap/queue', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => { console.log(t); resolve(); });
    });
    r.on('error', (e) => { console.error(`Is the server running on port ${port}? ${e.message}`); process.exitCode = 1; resolve(); });
    r.end(body);
  });
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const port = Number(flags.port || 8088);
  if (rest[0] === 'kinds') {
    for (const [k, v] of Object.entries(KINDS)) console.log(`${k.padEnd(22)} ${v}`);
    return;
  }
  if (rest[0] === 'queue') return cliQueue(rest[1], rest.slice(2), port);

  const cap = createCaptureServer({
    port, host: flags.host || '0.0.0.0',
    capturesDir: flags.captures ? path.resolve(flags.captures) : path.join(__dirname, '..', 'captures'),
    onlySn: typeof flags['only-sn'] === 'string' ? flags['only-sn'].split(',') : null,
    style: flags.style === 'gbs' ? 'gbs' : 'spec',
    batch: Number(flags.batch || 10),
  });
  const p = await cap.listen(port, flags.host || '0.0.0.0');
  const ip = lanAddress();
  console.log([
    '',
    `ZK capture server listening on port ${p} (style ${cap.state.style})`,
    `  Device settings:  Server address ${ip}   Port ${p}   HTTPS off   Domain name off   Proxy off`,
    `  Control page:     http://127.0.0.1:${p}/zkcap  (this Mac only)`,
    `  Capture file:     ${cap.captureFile}`,
    `  RegistryCode=${cap.state.registryCode}  SessionID=${cap.state.sessionId}  (random for this run)`,
    '  Ctrl+C to stop.',
    '',
  ].join('\n'));
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  SPEC_CONFIG, MANUAL_EXAMPLE, KINDS,
  generateRegistryCode, generateSessionId, buildConfigLines,
  encodeZkTime, decodeZkTime, parseWhen, formatZkTime,
  redactText, parseKv, parseRegistry, parseDevicecmd, tokenCandidates, checkToken,
  buildCommand, isLoopback, createCaptureServer,
};
