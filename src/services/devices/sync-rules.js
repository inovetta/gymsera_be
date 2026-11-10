/**
 * ZKTeco sync rules: pure functions only (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §7.1 to §7.5, §8.1).
 * No database, no clock reads except where a `now` is passed. The reconciler
 * (device-sync.service.js) feeds them rows and writes what they return.
 *
 * The desired record never holds template data: templates appear as ids and SHA-256 hashes, so
 * the record and its hash can be stored next to the queue (device_member_sync.desired_json).
 */
const crypto = require('crypto');
const { startOfBusinessDay } = require('../../utils/business-date.utils');
const { parseRecords, resolveDateFormat } = require('./push-protocol');

// ── Events (§7.3, protocol Appendix 2 and 19) ─────────────────────────────────
function classifyEvent(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'other';
  if ((c >= 0 && c <= 19) || (c >= 200 && c <= 253)) return 'granted';
  if ((c >= 20 && c <= 99) || (c >= 5000 && c <= 5999)) return 'denied';
  if ((c >= 100 && c <= 199) || (c >= 6000 && c <= 6999)) return 'alarm';
  return 'other';
}

const DENIED_REASONS = { 22: 'wrong_time', 23: 'unauthorized', 27: 'not_registered', 29: 'expired' };
const deniedReason = (code) => DENIED_REASONS[Number(code)] || 'denied';

// ── Return codes (§8.1 table) ─────────────────────────────────────────────────
const TRANSIENT = new Set([-1, -2, -12, -725, -730]);
const STORAGE_FULL = new Set([-18, -3, -604]);

function returnAction(code) {
  const c = Number(code);
  if (c >= 0 || c === -7) return 'ok'; // -7 "repeated command": CmdIDs never repeat per device (Phase 1 correction 3)
  if (c === -26) return 'empty_template';
  if (c === -27) return 'unknown_pin';
  if (c === -30) return 'version_mismatch';
  if (STORAGE_FULL.has(c)) return 'storage_full';
  if (c === -708) return 'unsupported';
  if (TRANSIENT.has(c)) return 'transient';
  return 'unknown';
}

const BACKOFF = [30, 120, 600, 3600];
/** Seconds before retry number `attempt` (1-based); null = give up. */
const backoffSeconds = (attempt) => (attempt >= 1 && attempt <= BACKOFF.length ? BACKOFF[attempt - 1] : null);

// ── Device capabilities ───────────────────────────────────────────────────────
const bits = (s) => String(s || '').split(':');
const majorOf = (v) => {
  const m = /^\s*(\d+)/.exec(String(v ?? ''));
  return m ? String(Number(m[1])) : null;
};

/** What the device said it supports. Nothing reported → nothing supported (never guess). */
function bioSupport(caps = {}) {
  const data = bits(caps.MultiBioDataSupport);
  const photo = bits(caps.MultiBioPhotoSupport);
  const versions = bits(caps.MultiBioVersion);
  const types = new Set();
  const photoTypes = new Set();
  data.forEach((b, i) => { if (b === '1' && i > 0) types.add(i); });
  photo.forEach((b, i) => { if (b === '1' && i > 0) photoTypes.add(i); });
  const unsupported = new Set(Array.isArray(caps._unsupported) ? caps._unsupported : []);
  return {
    types,
    photoTypes: unsupported.has('bio_photo') ? new Set() : photoTypes,
    majorFor: (type) => {
      const v = versions[type];
      return v && v !== '0' ? majorOf(v) : null;
    },
    unsupported,
  };
}

// ── Time ──────────────────────────────────────────────────────────────────────
function localParts(instant, timezone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(instant)) p[type] = Number(value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

const dateParts = (dateStr) => {
  const [year, month, day] = String(dateStr).slice(0, 10).split('-').map(Number);
  return { year, month, day, hour: 0, minute: 0, second: 0 };
};

/** The instant a package that ends on `endDate` stops: the branch's next local midnight. */
const packageEndsAt = (endDate, timezone) => {
  const [y, m, d] = String(endDate).slice(0, 10).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return startOfBusinessDay(next, timezone);
};

/**
 * The on-device validity window (§7.1): start date 00:00:00 to end date 23:59:59, branch local
 * time; OUT devices add `exitGraceHours` real hours to the end (D-7).
 */
function packageWindow({ startDate, endDate, timezone, direction, exitGraceHours = 0 }) {
  const lastSecond = new Date(packageEndsAt(endDate, timezone).getTime() - 1000);
  const end = direction === 'out' && exitGraceHours > 0 ? new Date(lastSecond.getTime() + exitGraceHours * 3600000) : lastSecond;
  return { start: dateParts(startDate), end: localParts(end, timezone) };
}

// ── Desired record (§7.1) ─────────────────────────────────────────────────────
const cleanName = (name) => String(name ?? '').replace(/[\t\r\n]+/g, ' ').trim().slice(0, 24);

/**
 * @param {object} o
 * @param {number|string} o.pin
 * @param {string} o.name
 * @param {string} [o.cardNo]
 * @param {object|null} o.window       packageWindow() or null (staff: no window)
 * @param {object} o.caps              device capabilities_json
 * @param {object} o.device            { timezone_id, door_mask }
 * @param {object} o.settings          { endTimeFormat, sendUserAuthorize, photoFallback, sendUserPic }
 * @param {Array}  o.biometrics        member_biometrics rows (usable ones only)
 * @param {Array}  o.photos            member_biometric_photos rows
 * @param {Array}  o.incompatible      member_biometrics ids this device refused with -30
 */
function desiredRecord({ pin, name, cardNo, window, caps = {}, device = {}, settings = {}, biometrics = [], photos = [], incompatible = [] }) {
  const support = bioSupport(caps);
  const refused = new Set(incompatible);
  const byType = new Map();
  for (const b of biometrics) {
    const type = Number(b.bio_type);
    if (!support.types.has(type) || refused.has(b.id) || Number(b.valid) === 0) continue;
    const want = support.majorFor(type);
    if (want !== null && majorOf(b.major_ver) !== want) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ id: b.id, no: Number(b.bio_no), index: Number(b.bio_index), sha: b.template_sha256 });
  }
  const bio = [...byType.entries()]
    .sort(([a], [b]) => a - b)
    .map(([type, items]) => ({ type, items: items.sort((x, y) => x.no - y.no || x.index - y.index || String(x.id).localeCompare(String(y.id))) }));

  const fallback = [];
  if (settings.photoFallback !== false) {
    for (const p of photos) {
      const type = Number(p.bio_type);
      if (p.kind !== 'biophoto' || !support.photoTypes.has(type) || byType.has(type)) continue;
      if (fallback.some((f) => f.type === type)) continue;
      fallback.push({ type, id: p.id, sha: p.sha256 });
    }
  }
  fallback.sort((a, b) => a.type - b.type);

  const pic = settings.sendUserPic ? photos.find((p) => p.kind === 'userpic') : null;
  return {
    pin: String(pin),
    name: cleanName(name),
    cardNo: String(cardNo ?? '').replace(/\s+/g, ''),
    dateFormat: resolveDateFormat(settings.endTimeFormat || 'auto', caps),
    window: window || null,
    auth: settings.sendUserAuthorize === false ? null : { timezoneId: Number(device.timezone_id ?? 1), doorMask: Number(device.door_mask ?? 1) },
    bio,
    photos: fallback,
    userpic: pic ? { id: pic.id, sha: pic.sha256 } : null,
  };
}

const hashOf = (record) => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');

// ── Command plan (§7.2) ───────────────────────────────────────────────────────
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * desired null = remove. `applied` = what the device last confirmed (null = unknown: send all).
 * → [{ kind, args }] in delivery order. Templates go one command per type (protocol §9.1.1).
 */
function planCommands({ desired, applied, pin, supportedTypes = [], photoTypes = [] }) {
  if (!desired) {
    const p = String(pin ?? applied?.pin);
    const types = new Set(supportedTypes.map(Number));
    for (const b of applied?.bio || []) types.add(b.type);
    const out = [...types].sort((a, b) => a - b).map((type) => ({ kind: 'bio_delete', args: { pin: p, type } }));
    if (photoTypes.length || applied?.photos?.length) out.push({ kind: 'photo_delete', args: { pin: p } });
    if (applied?.userpic) out.push({ kind: 'pic_delete', args: { pin: p } });
    if (!applied || applied.auth) out.push({ kind: 'auth_delete', args: { pin: p } });
    out.push({ kind: 'user_delete', args: { pin: p } });
    return out;
  }
  if (applied && same(desired, applied)) return [];

  const p = desired.pin;
  const out = [];
  const userChanged = !applied || ['pin', 'name', 'cardNo', 'window', 'dateFormat'].some((k) => !same(desired[k], applied[k]));
  const authChanged = !applied || !same(desired.auth, applied.auth) || !same(desired.window, applied.window);
  if (userChanged || authChanged) out.push({ kind: 'user_upsert', args: { pin: p } });
  if (desired.auth && (userChanged || authChanged)) out.push({ kind: 'user_authorize', args: { pin: p } });
  if (!desired.auth && applied?.auth) out.push({ kind: 'auth_delete', args: { pin: p } });

  const appliedBio = new Map((applied?.bio || []).map((b) => [b.type, b]));
  for (const b of desired.bio) {
    if (applied && same(b, appliedBio.get(b.type))) continue;
    out.push({ kind: 'bio_upsert', args: { pin: p, type: b.type, ids: b.items.map((i) => i.id) } });
  }
  for (const [type] of appliedBio) {
    if (!desired.bio.some((b) => b.type === type)) out.push({ kind: 'bio_delete', args: { pin: p, type } });
  }

  const appliedPhotos = applied?.photos || [];
  if (appliedPhotos.length && !desired.photos.length) out.push({ kind: 'photo_delete', args: { pin: p } });
  for (const ph of desired.photos) {
    if (applied && appliedPhotos.some((a) => same(a, ph))) continue;
    out.push({ kind: 'bio_photo', args: { pin: p, type: ph.type, id: ph.id } });
  }

  if (desired.userpic && !same(desired.userpic, applied?.userpic)) out.push({ kind: 'user_pic', args: { pin: p, id: desired.userpic.id } });
  if (!desired.userpic && applied?.userpic) out.push({ kind: 'pic_delete', args: { pin: p } });
  return out;
}

// ── Uploaded data (§7.5) ──────────────────────────────────────────────────────
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PIN = /^\d{1,9}$/;
const int = (v, d = 0) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/**
 * Templates from `biodata`, `templatev10` (fingerprint v10) or an ENROLL_BIO result (`BioData`).
 * A record without a numeric PIN, a type, a version or valid base64 is dropped.
 */
function templatesFrom(table, body) {
  const t = String(table).toLowerCase();
  const rows = t === 'templatev10' ? parseRecords(body, { table: 'templatev10' }) : parseRecords(body, { table: 'biodata' });
  const out = [];
  for (const r of rows) {
    let rec;
    if (t === 'templatev10') {
      rec = { pin: r.pin, type: 1, no: int(r.fingerid), index: 0, valid: int(r.valid, 1), duress: 0, majorVer: '10', minorVer: '0', format: 0, tmp: r.template };
    } else {
      rec = {
        pin: r.pin, type: int(r.type, NaN), no: int(r.no), index: int(r.index), valid: int(r.valid, 1), duress: int(r.duress),
        majorVer: r.majorver ?? r.major_ver, minorVer: r.minorver ?? r.minor_ver ?? '0', format: int(r.format), tmp: r.tmp,
      };
    }
    if (!PIN.test(String(rec.pin || '')) || !Number.isInteger(rec.type) || rec.type < 1) continue;
    if (majorOf(rec.majorVer) === null || !rec.tmp || rec.tmp.length < 8 || !BASE64.test(rec.tmp)) continue;
    rec.majorVer = String(rec.majorVer);
    rec.minorVer = String(rec.minorVer);
    out.push(rec);
  }
  return out;
}

/** Photos from `biophoto` (comparison photo, with its type) or `userpic` (profile photo, type 0). */
function photosFrom(table, body) {
  const kind = String(table).toLowerCase() === 'userpic' ? 'userpic' : 'biophoto';
  const out = [];
  for (const r of parseRecords(body, { table: kind })) {
    const content = r.content;
    if (!PIN.test(String(r.pin || '')) || !content || !BASE64.test(content)) continue;
    out.push({ pin: r.pin, type: kind === 'userpic' ? 0 : int(r.type, 9), kind, content });
  }
  return out;
}

module.exports = {
  classifyEvent,
  deniedReason,
  returnAction,
  backoffSeconds,
  bioSupport,
  majorOf,
  localParts,
  packageEndsAt,
  packageWindow,
  desiredRecord,
  hashOf,
  planCommands,
  templatesFrom,
  photosFrom,
};
