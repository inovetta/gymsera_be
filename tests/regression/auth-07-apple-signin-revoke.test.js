/**
 * AUTH-07 (Prompt 1I, spec §14 R-28 point 5): Sign in with Apple is revoked when the account
 * is deleted — behind configuration, with no secret in code.
 *
 *   - not configured: deletion still completes; "skipped_not_configured" is recorded.
 *   - configured: the stored (encrypted) refresh token is revoked at Apple and cleared.
 *   - Apple failing: the sweep retries instead of leaving the token alive.
 * Nothing reaches Apple (appleApi is replaced; the network is jailed).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { setupTestDatabases, teardownTestDatabases, factories } = require('../harness');
const { installMailFake } = require('../harness/mail-fake');
const { User, PlatformAuditLog } = require('../../src/models/platform');
const apple = require('../../src/services/apple-signin-revoke.service');
const accountDeletionService = require('../../src/services/account-deletion.service');
const { runDeletionFinalizeSweep } = require('../../src/services/account-deletion-finalize.service');
const { encrypt } = require('../../src/utils/crypto.utils');

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'Test@12345';
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC_PEM = ec.publicKey.export({ type: 'spki', format: 'pem' });

const ENV = {
  APPLE_SIGNIN_TEAM_ID: 'TEAM123456',
  APPLE_SIGNIN_KEY_ID: 'KEY1234567',
  APPLE_SIGNIN_CLIENT_ID: 'com.inovettatech.gymsera',
};
const KEYS = [...Object.keys(ENV), 'APPLE_SIGNIN_PRIVATE_KEY', 'APPLE_SIGNIN_PRIVATE_KEY_PATH'];

describe('AUTH-07: Sign in with Apple revoke on deletion', () => {
  let saved;
  let keyFile;

  const configure = () => {
    Object.assign(process.env, ENV, { APPLE_SIGNIN_PRIVATE_KEY_PATH: keyFile });
    delete process.env.APPLE_SIGNIN_PRIVATE_KEY;
  };
  const unconfigure = () => KEYS.forEach((k) => delete process.env[k]);

  /** An Apple-linked member who has asked to be deleted, 31 days ago. */
  const pendingAppleUser = async ({ withToken = true } = {}) => {
    const user = await factories.createUser({
      role: 'MEMBER',
      appleId: `001.${uuidv4().slice(0, 12)}.0101`,
      appleRefreshTokenEncrypted: withToken ? encrypt('apple-refresh-token-abc') : null,
    });
    await accountDeletionService.requestDeletion(user.id, { password: PASSWORD });
    return user;
  };
  const afterWindow = () => new Date(Date.now() + 31 * DAY);
  const revokeAudit = (id) => PlatformAuditLog.findAll({ where: { action: 'APPLE_SIGNIN_REVOKE', targetId: id } });

  beforeAll(async () => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apple-key-')), 'AuthKey.p8');
    fs.writeFileSync(keyFile, PRIVATE_PEM);
    await setupTestDatabases();
  });

  afterAll(async () => {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
    await teardownTestDatabases();
  });

  beforeEach(() => {
    installMailFake();
    unconfigure();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('NOT configured: deletion still completes and the skip is recorded; Apple is never called', async () => {
    const user = await pendingAppleUser();
    const revoke = jest.spyOn(apple.appleApi, 'revokeToken');

    const res = await runDeletionFinalizeSweep({ now: afterWindow() });

    expect(res.failed).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
    const u = await User.findByPk(user.id);
    expect(u.status).toBe('DELETED');
    expect([u.appleId, u.appleRefreshTokenEncrypted]).toEqual([null, null]);
    const audit = await revokeAudit(user.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].details.status).toBe('skipped_not_configured');
  });

  test('configured: the stored token is decrypted, revoked at Apple, cleared; recorded as revoked', async () => {
    configure();
    const user = await pendingAppleUser();
    const revoke = jest.spyOn(apple.appleApi, 'revokeToken').mockResolvedValue({});

    await runDeletionFinalizeSweep({ now: afterWindow() });

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0][1]).toBe('apple-refresh-token-abc');
    expect(revoke.mock.calls[0][0]).toMatchObject({ clientId: ENV.APPLE_SIGNIN_CLIENT_ID });
    const u = await User.findByPk(user.id);
    expect(u.status).toBe('DELETED');
    expect(u.appleRefreshTokenEncrypted).toBeNull();
    expect((await revokeAudit(user.id))[0].details.status).toBe('revoked');
  });

  test('configured but no stored token (signed in before this release): recorded as skipped_no_token, deletion completes', async () => {
    configure();
    const user = await pendingAppleUser({ withToken: false });
    const revoke = jest.spyOn(apple.appleApi, 'revokeToken');

    await runDeletionFinalizeSweep({ now: afterWindow() });

    expect(revoke).not.toHaveBeenCalled();
    expect((await User.findByPk(user.id)).status).toBe('DELETED');
    expect((await revokeAudit(user.id))[0].details.status).toBe('skipped_no_token');
  });

  test('Apple unreachable: the user stays PENDING_DELETION (token not lost), the next run completes it', async () => {
    configure();
    const user = await pendingAppleUser();
    jest.spyOn(apple.appleApi, 'revokeToken').mockRejectedValueOnce(Object.assign(new Error('Apple revoke responded 503'), { status: 503 }));

    const first = await runDeletionFinalizeSweep({ now: afterWindow() });

    expect(first.failed.map((f) => f.id)).toContain(user.id);
    const mid = await User.findByPk(user.id);
    expect(mid.status).toBe('PENDING_DELETION');
    expect(mid.appleRefreshTokenEncrypted).toBeTruthy();
    expect(mid.appleId).toBeTruthy();

    jest.spyOn(apple.appleApi, 'revokeToken').mockResolvedValue({});
    const second = await runDeletionFinalizeSweep({ now: afterWindow() });
    expect(second.failed).toEqual([]);
    expect((await User.findByPk(user.id)).status).toBe('DELETED');
  });

  test('Apple saying the token is already invalid counts as revoked (no endless retry)', async () => {
    configure();
    const user = await pendingAppleUser();
    jest.spyOn(apple.appleApi, 'revokeToken').mockRejectedValue(Object.assign(new Error('Apple revoke responded 400 (invalid_grant)'), { appleError: 'invalid_grant', status: 400 }));

    const res = await runDeletionFinalizeSweep({ now: afterWindow() });

    expect(res.failed).toEqual([]);
    expect((await User.findByPk(user.id)).status).toBe('DELETED');
    expect((await revokeAudit(user.id))[0].details.status).toBe('already_revoked');
  });

  describe('configuration and storing the token', () => {
    test('config needs team id, key id, client id AND a key; anything missing → null (no partial guess)', () => {
      expect(apple.getAppleSignInConfig({})).toBeNull();
      expect(apple.getAppleSignInConfig({ ...ENV })).toBeNull(); // no key
      expect(apple.getAppleSignInConfig({ ...ENV, APPLE_SIGNIN_PRIVATE_KEY_PATH: '/does/not/exist.p8' })).toBeNull();
      expect(apple.getAppleSignInConfig({ ...ENV, APPLE_SIGNIN_PRIVATE_KEY: PRIVATE_PEM.replace(/\n/g, '\\n') })).toMatchObject({ teamId: 'TEAM123456' });
      expect(apple.getAppleSignInConfig({ ...ENV, APPLE_SIGNIN_PRIVATE_KEY_PATH: keyFile })).toMatchObject({ keyId: 'KEY1234567' });
    });

    test('the client secret is the ES256 JWT Apple documents: iss=team, sub=client, aud=Apple, kid=key id, 5 minutes', () => {
      const cfg = apple.getAppleSignInConfig({ ...ENV, APPLE_SIGNIN_PRIVATE_KEY_PATH: keyFile });
      const decoded = jwt.verify(apple.buildClientSecret(cfg), PUBLIC_PEM, { algorithms: ['ES256'], complete: true });
      expect(decoded.header.kid).toBe('KEY1234567');
      expect(decoded.payload).toMatchObject({ iss: 'TEAM123456', sub: ENV.APPLE_SIGNIN_CLIENT_ID, aud: 'https://appleid.apple.com' });
      expect(decoded.payload.exp - decoded.payload.iat).toBeLessThanOrEqual(300);
    });

    test('at sign-in the code is exchanged and the refresh token is stored ENCRYPTED', async () => {
      configure();
      const user = await factories.createUser({ role: 'MEMBER', appleId: `001.${uuidv4().slice(0, 12)}.0101` });
      jest.spyOn(apple.appleApi, 'exchangeAuthorizationCode').mockResolvedValue({ refresh_token: 'r-token-xyz' });

      const res = await apple.storeRefreshToken(user, 'one-time-code');

      expect(res.stored).toBe(true);
      const stored = (await User.findByPk(user.id)).appleRefreshTokenEncrypted;
      expect(stored).toBeTruthy();
      expect(stored).not.toContain('r-token-xyz');
      expect(require('../../src/utils/crypto.utils').decrypt(stored)).toBe('r-token-xyz');
    });

    test('not configured → nothing is exchanged or stored; the sign-in path is not affected', async () => {
      const user = await factories.createUser({ role: 'MEMBER', appleId: `001.${uuidv4().slice(0, 12)}.0101` });
      const exchange = jest.spyOn(apple.appleApi, 'exchangeAuthorizationCode');
      expect(await apple.storeRefreshToken(user, 'one-time-code')).toMatchObject({ stored: false, reason: 'not_configured' });
      expect(exchange).not.toHaveBeenCalled();
    });

    test('the Apple sign-in route accepts an optional authorizationCode (and still requires the identity token)', () => {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src/validators/auth.validator.js'), 'utf8');
      expect(src).toMatch(/body\('authorizationCode'\)\.optional\(\)/);
    });
  });

  test('no private key is committed: no tracked file (outside tests) contains a PEM private key', () => {
    const root = path.resolve(__dirname, '../..');
    const tracked = require('child_process').execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const offenders = tracked.filter(
      (f) => !f.startsWith('tests/') && fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile() &&
        /\.(js|json|example|md|yml|yaml|txt|env)$/.test(f) && /-----BEGIN (EC |RSA )?PRIVATE KEY-----/.test(fs.readFileSync(path.join(root, f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
