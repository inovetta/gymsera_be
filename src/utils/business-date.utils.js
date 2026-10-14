/**
 * Branch-timezone date helpers (GLB-01, spec §6.4).
 *
 * Business dates are 'YYYY-MM-DD' strings in the branch's IANA timezone. All calendar maths here is done in
 * UTC on the date string, so the result never depends on the server's own timezone or its DST rules.
 * `computeBusinessDate` (ledger.service.js) stays the single "instant -> branch date" authority; this file only
 * adds what is built on top of it.
 */

const DEFAULT_TIMEZONE = 'Asia/Karachi';

const _parts = (dateStr) => {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return { y, m, d };
};

const _fmt = (date) => date.toISOString().slice(0, 10);

/** `dateStr` ('YYYY-MM-DD') plus one membership-plan duration, as 'YYYY-MM-DD'. Unknown type = one month. */
const addPlanDuration = (dateStr, durationType, durationValue) => {
  const { y, m, d } = _parts(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const n = Number(durationValue) || 1;
  switch (durationType) {
    case 'DAILY': dt.setUTCDate(dt.getUTCDate() + n); break;
    case 'WEEKLY': dt.setUTCDate(dt.getUTCDate() + n * 7); break;
    case 'MONTHLY': dt.setUTCMonth(dt.getUTCMonth() + n); break;
    case 'QUARTERLY': dt.setUTCMonth(dt.getUTCMonth() + n * 3); break;
    case 'YEARLY': dt.setUTCFullYear(dt.getUTCFullYear() + n); break;
    default: dt.setUTCMonth(dt.getUTCMonth() + 1);
  }
  return _fmt(dt);
};

/** `dateStr` plus `days` calendar days. */
const addDays = (dateStr, days) => addPlanDuration(dateStr, 'DAILY', days);

/** First day of the month containing `dateStr`. */
const monthStartOf = (dateStr) => `${String(dateStr).slice(0, 7)}-01`;

/** Last day of the month containing `dateStr`. */
const monthEndOf = (dateStr) => {
  const { y, m } = _parts(dateStr);
  return _fmt(new Date(Date.UTC(y, m, 0)));
};

// Offset (ms) of `timezone` from UTC at the instant `ms`: local wall time read as UTC, minus the instant.
const _offsetMs = (ms, timezone) => {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/** The UTC instant at which local 00:00 of `dateStr` happens in `timezone` (handles DST days). */
const startOfBusinessDay = (dateStr, timezone = DEFAULT_TIMEZONE) => {
  const { y, m, d } = _parts(dateStr);
  const guess = Date.UTC(y, m - 1, d);
  let ms = guess - _offsetMs(guess, timezone);
  // One refinement: the offset at the first answer may differ from the one at the guess across a DST change.
  ms = guess - _offsetMs(ms, timezone);
  return new Date(ms);
};

/** [start, end) UTC instants of the local day `dateStr`. End is the next local midnight. */
const businessDayRange = (dateStr, timezone = DEFAULT_TIMEZONE) => ({
  start: startOfBusinessDay(dateStr, timezone),
  end: startOfBusinessDay(addDays(dateStr, 1), timezone),
});

module.exports = {
  DEFAULT_TIMEZONE,
  addPlanDuration,
  addDays,
  monthStartOf,
  monthEndOf,
  startOfBusinessDay,
  businessDayRange,
};
