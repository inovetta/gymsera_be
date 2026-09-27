/**
 * SMTP settings — read ONLY from the environment. There is deliberately no
 * built-in host, account or password to fall back to: a missing setting must
 * stop the server at startup (assertSmtpConfigured, called by server.js and
 * api/index.js), never silently switch to a default mailbox. (A hard-coded
 * fallback password used to live here — see spec §13 SEC-SMTP-FALLBACK.)
 */
const cleanStr = (val) => (val || '').replace(/^["']|["']$/g, '').trim();

const REQUIRED_SMTP_SETTINGS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'];

/** The required SMTP settings that are missing or empty in `env`. */
const missingSmtpSettings = (env = process.env) => REQUIRED_SMTP_SETTINGS.filter((key) => !cleanStr(env[key]));

/**
 * Throws a clear error naming every missing SMTP setting. Run at startup so a
 * misconfigured server refuses to start instead of starting with a hidden default.
 */
const assertSmtpConfigured = (env = process.env) => {
  const missing = missingSmtpSettings(env);
  if (missing.length > 0) {
    const err = new Error(
      `SMTP is not configured: missing ${missing.join(', ')}. Set them in the environment ` +
        '(there is no built-in fallback). The server will not start without them.'
    );
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
};

const host = cleanStr(process.env.SMTP_HOST);
const user = cleanStr(process.env.SMTP_USER);
const pass = cleanStr(process.env.SMTP_PASS);
const from = cleanStr(process.env.SMTP_FROM);
const port = parseInt(process.env.SMTP_PORT || '587', 10);
const secure = process.env.SMTP_SECURE === 'true' || port === 465;

module.exports = {
  host,
  port,
  secure,
  auth: {
    user,
    pass,
  },
  from: from || (user ? `GymsEra <${user}>` : ''),
  tls: {
    rejectUnauthorized: false,
  },
  REQUIRED_SMTP_SETTINGS,
  missingSmtpSettings,
  assertSmtpConfigured,
};
