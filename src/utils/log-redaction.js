/**
 * Log redaction (SEC-07, spec §12.6).
 *
 * The one place that decides what may appear in a log line. Installed once at
 * startup (app.js) on `console.*` and on morgan's URL tokens, so every
 * existing `console.log(...)` call is covered without touching it.
 *
 *  - Secrets are replaced: authorization / cookies / tokens / OTPs / passwords,
 *    card numbers, bank accounts (IBAN), CNIC / national ID numbers, store
 *    receipts. Matched by object key and by pattern inside strings.
 *  - E-mails and phone numbers are replaced by a short hash, so one person's
 *    lines can still be correlated without the value itself being logged.
 *
 * Redaction must never throw and never break a log call: on any internal
 * error the argument is replaced by a placeholder.
 */
const crypto = require('crypto');

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

// Object keys whose value is always secret. Compared lowercase with `_`/`-` removed.
const SECRET_KEYS = new Set([
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey', 'apikey',
  'password', 'newpassword', 'currentpassword', 'oldpassword', 'confirmpassword', 'passwordhash',
  'otp', 'otpcode', 'verificationcode', 'resetcode', 'resettoken',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'identitytoken', 'authorizationcode',
  'fcmtoken', 'devicetoken', 'pushtoken', 'purchasetoken', 'signedpayload', 'signedtransactioninfo',
  'receipt', 'receiptdata', 'secret', 'clientsecret', 'privatekey', 'connectionstring', 'connectionstringencrypted',
  'cardnumber', 'cardno', 'pan', 'cvv', 'cvc', 'cardexpiry', 'expirydate',
  'iban', 'accountnumber', 'bankaccount', 'bankaccountnumber', 'accountno',
  'cnic', 'cnicnumber', 'nationalid', 'nationalidnumber', 'nic', 'passportnumber',
]);
const EMAIL_KEYS = new Set(['email', 'useremail', 'owneremail', 'to', 'from', 'replyto']);
const PHONE_KEYS = new Set(['phone', 'phonenumber', 'mobile', 'mobilenumber', 'contactphone', 'whatsapp']);

const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');

const shortHash = (value) =>
  crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex').slice(0, 12);

const hashEmail = (email) => `<email:${shortHash(email)}>`;
const hashPhone = (phone) => `<phone:${shortHash(String(phone).replace(/[^\d+]/g, ''))}>`;

const luhnValid = (digits) => {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

const SECRET_JSON_KEYS = [...SECRET_KEYS].join('|');

// Order matters: tokens and structured secrets first, then e-mail/phone.
const STRING_RULES = [
  // "password":"…" inside JSON text (e.g. a JSON.stringify'd object passed as a string)
  [new RegExp(`("(?:${SECRET_JSON_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${REDACTED}"`],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // JWT / JWS (three base64url segments starting with a JSON header)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],
  // Secret query / form parameters
  [/([?&;](?:token|access_token|id_token|refresh_token|code|otp|password|key|api_key|apikey|signature|sig|secret)=)[^&\s"'#]*/gi, `$1${REDACTED}`],
  // Pakistani CNIC 12345-1234567-1
  [/(?<![\w-])\d{5}-\d{7}-\d(?![\w-])/g, '[REDACTED_CNIC]'],
  // IBAN (country + check digits + bank code + account) — PK, GB and similar
  [/\b[A-Z]{2}\d{2}(?:[A-Z]{4}\d{10,26}|\d{12,30})\b/g, '[REDACTED_IBAN]'],
  // Card numbers: 13–19 digits, optionally grouped by spaces or dashes, Luhn-valid
  [/(?<![\w-])\d(?:[ -]?\d){12,18}(?![\w-])/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    const grouped = /[ -]/.test(m);
    // Bare 13-digit runs are usually millisecond timestamps; only treat them as cards when grouped.
    if (!grouped && digits.length < 15) return m;
    return luhnValid(digits) ? '[REDACTED_CARD]' : m;
  }],
  // E-mail addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => hashEmail(m)],
  // Phone numbers: international +CC… and Pakistani mobile 03xx…
  [/(?<![\w+])\+\d[\d -]{8,16}\d(?![\w-])/g, (m) => hashPhone(m)],
  [/(?<![\w-])03\d{2}[ -]?\d{7}(?![\w-])/g, (m) => hashPhone(m)],
];

const redactString = (str) => {
  let out = str;
  for (const [re, rep] of STRING_RULES) out = out.replace(re, rep);
  return out;
};

const redactValue = (value, depth = 0, seen = new WeakSet()) => {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Object]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const copy = new Error(redactString(value.message || ''));
    copy.name = value.name;
    copy.stack = value.stack ? redactString(value.stack) : undefined;
    if (value.code !== undefined) copy.code = value.code;
    if (value.statusCode !== undefined) copy.statusCode = value.statusCode;
    return copy;
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const nk = normKey(k);
    if (SECRET_KEYS.has(nk)) out[k] = v == null || v === '' ? v : REDACTED;
    else if (EMAIL_KEYS.has(nk) && typeof v === 'string' && v.includes('@')) out[k] = hashEmail(v);
    else if (PHONE_KEYS.has(nk) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) out[k] = hashPhone(v);
    else out[k] = redactValue(v, depth + 1, seen);
  }
  return out;
};

/** Returns a redacted copy of any log argument. Never throws. */
const redact = (value) => {
  try {
    return redactValue(value);
  } catch (_) {
    return '[unloggable value]';
  }
};

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
const INSTALLED = Symbol.for('gymsera.logRedaction.installed');

/**
 * Where redacted console output goes. Tests spy on `sink.write` to capture
 * exactly what would have been printed.
 */
const sink = {
  write: (target, method, original, args) => original.apply(target, args),
};

/** Wraps console.* so every argument is redacted before it is printed. Idempotent. */
const installConsoleRedaction = (target = console) => {
  if (target[INSTALLED]) return;
  for (const method of CONSOLE_METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function redactedConsole(...args) {
      sink.write(target, method, original, args.map(redact));
    };
  }
  Object.defineProperty(target, INSTALLED, { value: true, enumerable: false });
};

const isConsoleRedactionInstalled = (target = console) => Boolean(target[INSTALLED]);

/** Makes morgan print redacted URLs and referrers (query tokens, e-mails in paths). */
const installMorganRedaction = (morgan) => {
  morgan.token('url', (req) => redactString(req.originalUrl || req.url || ''));
  morgan.token('referrer', (req) => redactString(req.headers.referer || req.headers.referrer || ''));
};

module.exports = {
  redact,
  redactString,
  hashEmail,
  hashPhone,
  sink,
  installConsoleRedaction,
  isConsoleRedactionInstalled,
  installMorganRedaction,
  REDACTED,
};
