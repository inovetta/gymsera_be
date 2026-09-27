/**
 * SEC-SMTP-FALLBACK — the server must refuse to start without SMTP settings,
 * never fall back to a built-in mailbox/password.
 *
 * The end-to-end check starts the real server.js in a child process with
 * SMTP_PASS empty (dotenv never overrides a key that exists), preloading the
 * test network jail so the child cannot reach anything outside this machine
 * even if the check were broken.
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const loadSmtpConfig = (env) => {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let config;
  try {
    jest.isolateModules(() => {
      config = require('../../src/config/smtp.config');
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return config;
};

describe('SMTP settings have no built-in fallback', () => {
  test('with SMTP settings empty, the config holds no host, account or password at all', () => {
    const config = loadSmtpConfig({ SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', SMTP_FROM: '' });
    expect(config.host).toBe('');
    expect(config.auth.user).toBe('');
    expect(config.auth.pass).toBe('');
    expect(config.from).toBe('');
  });

  test('assertSmtpConfigured names every missing setting, and passes when all are set', () => {
    const { assertSmtpConfigured, missingSmtpSettings } = loadSmtpConfig({});
    expect(missingSmtpSettings({})).toEqual(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']);
    expect(() => assertSmtpConfigured({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'u@example.test' })).toThrow(
      /missing SMTP_PASS/
    );
    expect(() => assertSmtpConfigured({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'u@example.test', SMTP_PASS: '"  "' }))
      .toThrow(/missing SMTP_PASS/);
    expect(() =>
      assertSmtpConfigured({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'u@example.test', SMTP_PASS: 'x' })
    ).not.toThrow();
  });

  test('starting server.js without SMTP_PASS fails clearly and never starts listening', async () => {
    const child = spawn(process.execPath, ['-r', './tests/harness/no-network.js', 'server.js'], {
      cwd: ROOT,
      env: { ...process.env, SMTP_PASS: '', PORT: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 20000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/SMTP is not configured: missing SMTP_PASS/);
    expect(stdout).not.toMatch(/GymsEra API running/);
    expect(stdout).not.toMatch(/\[Platform DB\] Connected/); // stopped before touching the database
  }, 30000);

  test('the Vercel entry point refuses to load without SMTP_PASS', () => {
    const saved = process.env.SMTP_PASS;
    process.env.SMTP_PASS = '';
    try {
      expect(() => jest.isolateModules(() => require('../../api/index'))).toThrow(/SMTP is not configured/);
    } finally {
      if (saved === undefined) delete process.env.SMTP_PASS;
      else process.env.SMTP_PASS = saved;
    }
  });
});
