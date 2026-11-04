/**
 * NEW-206: every environment variable the backend reads (src/, app.js, server.js) is listed in
 * .env.example with a comment (Prompt G rule 11), so a server set up from the example can know it
 * exists. P10 found 17 missing; the full scan found 20 (FRONTEND_URL, STORAGE_BASE_URL,
 * FIREBASE_SERVICE_ACCOUNT_PATH, GOOGLE_IOS_CLIENT_ID, DUPLICATE_CHECKIN_WINDOW_MINUTES,
 * ATTENDANCE_LEGACY_QR_UNTIL, AUDIT_LOG_PERSIST, ...).
 *
 * Not ours to set, so not listed: VERCEL (set by that host) and the generated socket.io bundle's
 * terminal and debug variables.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const NOT_OURS = new Set(['VERCEL']);
const SKIP_FILES = new Set([path.join(ROOT, 'src/socket/socket-bundle.js')]);

const jsFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') && !SKIP_FILES.has(p) ? [p] : [];
  });

const readByCode = () => {
  const names = new Set();
  const files = [...jsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'app.js'), path.join(ROOT, 'server.js')];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g, /\benv\.([A-Z][A-Z0-9_]{2,})/g]) {
      for (const m of src.matchAll(re)) names.add(m[1]);
    }
  }
  return names;
};

describe('NEW-206 .env.example lists every variable the backend reads', () => {
  const listed = new Set(
    fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
      .split('\n')
      .map((l) => (/^#?\s?([A-Z][A-Z0-9_]+)=/.exec(l) || [])[1])
      .filter(Boolean)
  );

  it('nothing read by the code is missing', () => {
    const missing = [...readByCode()].filter((n) => !listed.has(n) && !NOT_OURS.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('the example holds no real secret values for the new entries', () => {
    const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n');
    for (const name of ['APPLE_SIGNIN_PRIVATE_KEY', 'SEED_ADMIN_PASSWORD', 'TENANT_CONN_ENCRYPTION_KEY_OLD', 'TENANT_CONN_ENCRYPTION_KEY_NEW']) {
      const line = lines.find((l) => new RegExp(`^#?\\s?${name}=`).test(l));
      expect({ name, value: line && line.split('=').slice(1).join('=') }).toEqual({ name, value: '' });
    }
  });
});
