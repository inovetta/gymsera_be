'use strict';

/**
 * R-113 (owner 2026-11-18, build 27): a branch's opening hours as a weekly schedule.
 * Contract: spec §13 "R-113 API contract, revision 1" (H2 shape, H3 rules, H5 old clients, H6 reads).
 *
 * Shape (version 1), stored in branches.hours_json (tenant migration 029):
 *   { v: 1, days: { mon: { closed, slots: [{ open: "HH:MM", close: "HH:MM", for: "all|men|women" }] }, ... sun } }
 * Times are local to the branch's timezone. The old opening_time / closing_time pair stays, written
 * from the schedule as a summary, so clients up to build 26, the CMS and the website keep working.
 *
 * Pure functions only (no database); the "now" values take the clock as an argument.
 */
const { createError } = require('../utils/response.utils');

const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const AUDIENCES = Object.freeze(['all', 'men', 'women']);
const MAX_SLOTS = 4;
const DAY_MINUTES = 1440;
const MAX_AFTER_MIDNIGHT = 12 * 60;
const OPEN_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CLOSE_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (minutes) => {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const invalid = (errors) => {
  const err = createError('These opening hours are not valid.', 422, 'hours_invalid');
  err.errors = errors;
  return err;
};

/** A slot's end in minutes from its own day's midnight (after midnight = more than 1440). */
const _endOf = (s) => {
  const open = toMinutes(s.open);
  const close = s.close === '24:00' ? DAY_MINUTES : toMinutes(s.close);
  return close <= open && !(s.open === '00:00' && s.close === '24:00') ? close + DAY_MINUTES : close;
};

/**
 * H2 / H3: checks a schedule and returns it normalized (slots sorted by open). Throws 422
 * hours_invalid with errors [{ path, message }].
 */
const validate = (input) => {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid([{ path: 'hours', message: 'Send the hours for the whole week.' }]);
  if (input.v !== 1) add('v', 'Unknown hours version.');
  const days = input.days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw invalid([...errors, { path: 'days', message: 'Send all seven days.' }]);
  for (const key of Object.keys(days)) if (!DAYS.includes(key)) add(`days.${key}`, 'Unknown day.');

  const out = { v: 1, days: {} };
  for (const day of DAYS) {
    const d = days[day];
    if (!d || typeof d !== 'object') {
      add(`days.${day}`, 'Every day is required.');
      continue;
    }
    const closed = d.closed === true;
    const slots = Array.isArray(d.slots) ? d.slots : null;
    if (!slots) {
      add(`days.${day}.slots`, 'Slots are required.');
      continue;
    }
    if (closed) {
      if (slots.length) add(`days.${day}.slots`, 'A closed day has no hours.');
      out.days[day] = { closed: true, slots: [] };
      continue;
    }
    if (slots.length < 1 || slots.length > MAX_SLOTS) {
      add(`days.${day}.slots`, `An open day has 1 to ${MAX_SLOTS} time slots.`);
      continue;
    }
    let shapeOk = true;
    const clean = slots.map((s, i) => {
      const path = `days.${day}.slots[${i}]`;
      const open = s && typeof s.open === 'string' ? s.open : '';
      const close = s && typeof s.close === 'string' ? s.close : '';
      const forWho = s && s.for !== undefined ? s.for : 'all';
      if (!OPEN_RE.test(open)) { add(`${path}.open`, 'Opening time must be a real time, 00:00 to 23:59.'); shapeOk = false; }
      if (!CLOSE_RE.test(close)) { add(`${path}.close`, 'Closing time must be a real time, 00:00 to 24:00.'); shapeOk = false; }
      if (!AUDIENCES.includes(forWho)) { add(`${path}.for`, 'For must be all, men or women.'); shapeOk = false; }
      return { open, close, for: forWho, _i: i };
    });
    if (!shapeOk) continue;
    clean.sort((a, b) => toMinutes(a.open) - toMinutes(b.open));
    clean.forEach((s, k) => {
      const path = `days.${day}.slots[${s._i}]`;
      const open = toMinutes(s.open);
      if (s.open === s.close && !(s.open === '00:00' && s.close === '24:00')) {
        add(`${path}.close`, 'Opening and closing times are the same.');
        return;
      }
      const end = _endOf(s);
      if (end > DAY_MINUTES) {
        if (k !== clean.length - 1) add(`${path}.close`, 'Only the last slot of a day may go past midnight.');
        else if (end - DAY_MINUTES > MAX_AFTER_MIDNIGHT) add(`${path}.close`, 'A slot may end at most 12 hours after midnight.');
      }
      if (k > 0 && open < _endOf(clean[k - 1])) add(path, 'This slot overlaps another one.');
    });
    out.days[day] = { closed: false, slots: clean.map(({ open, close, for: f }) => ({ open, close, for: f })) };
  }

  // The after-midnight part of a day's last slot counts against the next day's first slot (sun → mon too).
  if (!errors.length) {
    DAYS.forEach((day, i) => {
      const today = out.days[day];
      const next = out.days[DAYS[(i + 1) % 7]];
      if (today.closed || next.closed || !today.slots.length || !next.slots.length) return;
      const spill = _endOf(today.slots[today.slots.length - 1]) - DAY_MINUTES;
      if (spill > 0 && toMinutes(next.slots[0].open) < spill) {
        const original = days[DAYS[(i + 1) % 7]].slots.findIndex((s) => s.open === next.slots[0].open);
        add(`days.${DAYS[(i + 1) % 7]}.slots[${original}]`, `This slot overlaps ${day}'s hours after midnight.`);
      }
    });
  }

  if (errors.length) throw invalid(errors);
  return out;
};

/** H5: every day open, one slot for everyone, the same times. */
const isUniform = (h) => {
  if (!h || !h.days) return false;
  const first = h.days.mon;
  return DAYS.every((d) => {
    const x = h.days[d];
    return x && !x.closed && x.slots.length === 1 && x.slots[0].for === 'all' &&
      first.slots.length === 1 && x.slots[0].open === first.slots[0].open && x.slots[0].close === first.slots[0].close;
  });
};

/** H5: the schedule an old pair stands for (every day, one slot for everyone), or null. */
const fromPair = (openingTime, closingTime) => {
  if (!openingTime || !closingTime) return null;
  const s = { open: String(openingTime).slice(0, 5), close: String(closingTime).slice(0, 5), for: 'all' };
  return { v: 1, days: Object.fromEntries(DAYS.map((d) => [d, { closed: false, slots: [{ ...s }] }])) };
};

/** H5: the old pair written from a schedule: the week's earliest open and latest close (clock time). */
const summaryPair = (h) => {
  const slots = h ? DAYS.flatMap((d) => (h.days[d] && !h.days[d].closed ? h.days[d].slots : [])) : [];
  if (!slots.length) return { openingTime: null, closingTime: null };
  const earliest = Math.min(...slots.map((s) => toMinutes(s.open)));
  const latestEnd = Math.max(...slots.map(_endOf));
  return {
    openingTime: toClock(earliest),
    closingTime: latestEnd === DAY_MINUTES ? '23:59' : toClock(latestEnd),
  };
};

const _pairEqual = (a, b) => (a || null) === (b || null);

/**
 * H4 / H5: the hours values a create or update stores, or null when the body has no hours field.
 * `stored` is the branch as it is now ({ hoursJson, openingTime, closingTime }; empty for a create).
 * - `hours` (a schedule) → the schedule and its summary pair; `hours: null` clears both;
 *   `hours` together with the old pair → 422 hours_invalid.
 * - the old pair only → accepted when nothing or a uniform schedule is stored (stored as a uniform
 *   schedule plus the pair); refused with 409 hours_schedule_newer on a weekly schedule, unless it is
 *   the same pair sent back unchanged (a form that resends every field).
 */
const resolveWrite = (body = {}, stored = {}) => {
  const hasHours = Object.prototype.hasOwnProperty.call(body, 'hours');
  const hasOpen = body.openingTime !== undefined;
  const hasClose = body.closingTime !== undefined;
  if (hasHours) {
    if (hasOpen || hasClose) {
      throw invalid([{ path: 'hours', message: 'Send the weekly hours or the opening / closing pair, not both.' }]);
    }
    if (body.hours === null) return { hoursJson: null, openingTime: null, closingTime: null };
    const h = validate(body.hours);
    return { hoursJson: h, ...summaryPair(h) };
  }
  if (!hasOpen && !hasClose) return null;

  const norm = (t) => (t === null || t === '' ? null : String(t));
  const openingTime = hasOpen ? norm(body.openingTime) : (stored.openingTime || null);
  const closingTime = hasClose ? norm(body.closingTime) : (stored.closingTime || null);
  const errors = [];
  if (openingTime !== null && !OPEN_RE.test(openingTime)) errors.push({ path: 'openingTime', message: 'Opening time must be a real time, 00:00 to 23:59.' });
  if (closingTime !== null && !CLOSE_RE.test(closingTime)) errors.push({ path: 'closingTime', message: 'Closing time must be a real time, 00:00 to 24:00.' });
  if (errors.length) throw invalid(errors);

  const current = stored.hoursJson || null;
  if (current && !isUniform(current)) {
    if (_pairEqual(openingTime, stored.openingTime) && _pairEqual(closingTime, stored.closingTime)) return null;
    const err = createError(
      'These hours have a different schedule for some days. Update the app (or ask GymsEra support) to change them.',
      409,
      'hours_schedule_newer'
    );
    throw err;
  }
  if (openingTime && closingTime) {
    const h = fromPair(openingTime, closingTime);
    try {
      validate(h);
    } catch (e) {
      throw invalid(e.errors.slice(0, 1).map((x) => ({ path: 'closingTime', message: x.message })));
    }
    return { hoursJson: h, openingTime, closingTime };
  }
  return { hoursJson: null, openingTime, closingTime };
};

/** The schedule a branch effectively has: its own, else the one its old pair stands for, else null. */
const effective = (hoursJson, openingTime, closingTime) => hoursJson || fromPair(openingTime, closingTime);

// ── H6: now, in the branch's timezone ─────────────────────────────────────────

const _localParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday').toLowerCase().slice(0, 3),
  };
};

/** Minutes the zone is ahead of UTC at `date`. */
const _offsetMinutes = (date, timeZone) => {
  const p = _localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

/** The UTC instant of local midnight (y, m, d) plus `minutes` in `timeZone`. */
const _zonedToUtc = (y, m, d, minutes, timeZone) => {
  const naive = Date.UTC(y, m - 1, d) + minutes * 60000;
  let guess = new Date(naive - _offsetMinutes(new Date(naive), timeZone) * 60000);
  guess = new Date(naive - _offsetMinutes(guess, timeZone) * 60000);
  return guess;
};

/**
 * H6: { hoursToday, openNow, openNowFor, nextChange, utcOffsetMinutes } for schedule `h` in `timeZone`
 * at `now`. hoursToday includes yesterday's slot that runs past midnight (startsYesterday: true).
 */
const computeNow = (h, timeZone = 'Asia/Karachi', now = new Date()) => {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch (_) {
    zone = 'Asia/Karachi';
  }
  const utcOffsetMinutes = _offsetMinutes(now, zone);
  if (!h || !h.days) return { hoursToday: null, openNow: null, openNowFor: null, nextChange: null, utcOffsetMinutes };

  const p = _localParts(now, zone);
  const todayIdx = DAYS.indexOf(p.weekday);
  const nowMin = p.hour * 60 + p.minute + p.second / 60;

  // Intervals in minutes from today's local midnight: yesterday (-1) to 7 days ahead.
  const intervals = [];
  for (let k = -1; k <= 7; k++) {
    const day = h.days[DAYS[(((todayIdx + k) % 7) + 7) % 7]];
    if (!day || day.closed) continue;
    for (const s of day.slots) {
      intervals.push({ start: k * DAY_MINUTES + toMinutes(s.open), end: k * DAY_MINUTES + _endOf(s), for: s.for });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  // Back-to-back slots for the same audience are one opening (00:00-24:00 every day never "closes").
  const merged = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.for === iv.for && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }

  const today = h.days[DAYS[todayIdx]];
  const yesterday = h.days[DAYS[(todayIdx + 6) % 7]];
  const spill = yesterday && !yesterday.closed && yesterday.slots.length
    ? yesterday.slots.filter((s) => _endOf(s) > DAY_MINUTES).map((s) => ({ ...s, startsYesterday: true }))
    : [];
  const hoursToday = {
    day: DAYS[todayIdx],
    closed: !!today.closed && spill.length === 0,
    slots: [...spill, ...(today.closed ? [] : today.slots)],
  };

  const current = merged.find((iv) => iv.start <= nowMin && nowMin < iv.end);
  const toIso = (minutes) => _zonedToUtc(p.year, p.month, p.day, minutes, zone).toISOString();
  let nextChange = null;
  if (current) {
    if (current.end - current.start < 8 * DAY_MINUTES && current.end <= 7 * DAY_MINUTES) {
      nextChange = { at: toIso(current.end), kind: 'closes', for: current.for };
    }
  } else {
    const next = merged.find((iv) => iv.start > nowMin);
    if (next) nextChange = { at: toIso(next.start), kind: 'opens', for: next.for };
  }
  // Open 24 hours every day: one interval covering the whole window has no next change.
  if (current && current.start <= -DAY_MINUTES + 1 && current.end >= 8 * DAY_MINUTES - 1) nextChange = null;

  return {
    hoursToday,
    openNow: !!current,
    openNowFor: current ? current.for : null,
    nextChange,
    utcOffsetMinutes,
  };
};

/**
 * H6: the read fields for one branch object ({ hoursJson, openingTime, closingTime, timezone }).
 * The raw `hoursJson` is not sent: `hours` is the schedule clients read.
 */
const readFields = (branch, now = new Date()) => {
  const h = effective(branch.hoursJson || null, branch.openingTime || null, branch.closingTime || null);
  const timezone = branch.timezone || 'Asia/Karachi';
  return { hours: h, timezone, ...computeNow(h, timezone, now) };
};

/**
 * H7: whether a branch matches audience filter ('women' or 'men').
 * women: organisation FEMALE_ONLY, or a branch with at least one women slot in its week;
 * men: organisation MALE_ONLY, or a branch with at least one men slot in its week.
 * MIXED-only branches with all slots match neither.
 */
const matchesAudience = (branch, audience) => {
  if (!audience) return true;
  const target = String(audience).toLowerCase();
  if (target !== 'women' && target !== 'men') return true;

  const orgGender = String(branch.genderType || '').toUpperCase();
  if (target === 'women' && (orgGender === 'FEMALE_ONLY' || orgGender === 'FEMALE')) {
    return true;
  }
  if (target === 'men' && (orgGender === 'MALE_ONLY' || orgGender === 'MALE')) {
    return true;
  }

  const hours = branch.hours || (branch.hoursJson ? branch.hoursJson : null);
  const days = hours?.days;
  if (!days || typeof days !== 'object') return false;

  for (const day of Object.values(days)) {
    if (!day || day.closed || !Array.isArray(day.slots)) continue;
    for (const slot of day.slots) {
      if (slot && slot.for === target) return true;
    }
  }

  return false;
};

module.exports = {
  readFields,
  DAYS,
  validate,
  isUniform,
  fromPair,
  summaryPair,
  resolveWrite,
  effective,
  computeNow,
  matchesAudience,
};
