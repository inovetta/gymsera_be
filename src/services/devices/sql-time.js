/**
 * Dates in raw SQL replacements, written as UTC.
 *
 * Sequelize 6 formats a Date inside raw-query `replacements` in the SERVER's local zone (the
 * replacement path does not pass the connection's timezone), while the mysql2 connection reads
 * DATETIME back as UTC ('+00:00'). On a server not set to UTC every such value comes back shifted
 * (on a Pakistan-time machine, 5 hours in the future): a device would look online for hours after
 * its last poll, and a grace or backoff would be off by the offset. Every device query passes its
 * replacements through utc(), so what is written is the UTC wall time the reads assume.
 */
const pad = (n, w = 2) => String(n).padStart(w, '0');

const utcString = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;

/** Replacements (array, object or value) with every Date as a UTC 'YYYY-MM-DD HH:MM:SS.mmm' string. */
function utc(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : utcString(value);
  if (Array.isArray(value)) return value.map(utc);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, utc(v)]));
  }
  return value;
}

module.exports = { utc, utcString };
