/**
 * ZKTeco Phase 2: biometric encryption at rest (spec ZKTECO_PUSH_DEVICE_SYNC.md §6.2, §14 point 2).
 *
 * AES-256-GCM with versioned keys from BIOMETRIC_DATA_KEY ("<version>:<64 hex>", comma list, the
 * first one encrypts), so a key can be rotated: new data uses the new key, old rows stay readable
 * until src/scripts/rotate-biometric-key.js re-encrypts them.
 */
const crypto = require('crypto');
const bio = require('../../src/utils/biometric-crypto');

const hex = () => crypto.randomBytes(32).toString('hex');
const K1 = hex();
const K2 = hex();
let saved;
beforeEach(() => { saved = process.env.BIOMETRIC_DATA_KEY; });
afterEach(() => { if (saved === undefined) delete process.env.BIOMETRIC_DATA_KEY; else process.env.BIOMETRIC_DATA_KEY = saved; });

describe('biometric-crypto', () => {
  test('round trip; the ciphertext carries the key version and never the plaintext', () => {
    process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
    const plain = Buffer.from('TAlTUzIxAAAFSksECAUHCc7QAAAdS2kBAAAAhfcvU0o3AIAP-template');
    const enc = bio.encrypt(plain);
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(bio.versionOf(enc)).toBe(1);
    expect(enc.includes(plain)).toBe(false);
    expect(bio.decrypt(enc).equals(plain)).toBe(true);
    // A random IV per value: the same plaintext twice gives two ciphertexts.
    expect(bio.encrypt(plain).equals(enc)).toBe(false);
  });

  test('strings in, strings out (templates are base64 text)', () => {
    process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
    expect(bio.decryptText(bio.encrypt('abc=='))).toBe('abc==');
  });

  test('tampering is detected (GCM tag)', () => {
    process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
    const enc = bio.encrypt('secret-template');
    enc[enc.length - 1] ^= 0x01;
    expect(() => bio.decrypt(enc)).toThrow();
  });

  test('rotation: the first key encrypts, older keys still decrypt; a missing version is refused', () => {
    process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
    const old = bio.encrypt('old-template');
    process.env.BIOMETRIC_DATA_KEY = `2:${K2},1:${K1}`;
    const fresh = bio.encrypt('new-template');
    expect(bio.versionOf(fresh)).toBe(2);
    expect(bio.currentVersion()).toBe(2);
    expect(bio.decryptText(old)).toBe('old-template');
    expect(bio.decryptText(fresh)).toBe('new-template');
    const re = bio.reencrypt(old);
    expect(bio.versionOf(re)).toBe(2);
    expect(bio.decryptText(re)).toBe('old-template');
    process.env.BIOMETRIC_DATA_KEY = `2:${K2}`;
    expect(() => bio.decrypt(old)).toThrow(/key version 1/);
  });

  test('no key, a short key, a duplicate version: refused with a clear message (never a silent default)', () => {
    delete process.env.BIOMETRIC_DATA_KEY;
    expect(bio.isConfigured()).toBe(false);
    expect(() => bio.encrypt('x')).toThrow(/BIOMETRIC_DATA_KEY/);
    process.env.BIOMETRIC_DATA_KEY = '1:abcd';
    expect(() => bio.encrypt('x')).toThrow(/64 hex/);
    process.env.BIOMETRIC_DATA_KEY = `1:${K1},1:${K2}`;
    expect(() => bio.encrypt('x')).toThrow(/twice/);
    process.env.BIOMETRIC_DATA_KEY = `${K1}`;
    expect(() => bio.encrypt('x')).toThrow(/<version>:<64 hex>/);
  });

  test('the key never appears in an error message', () => {
    process.env.BIOMETRIC_DATA_KEY = `1:${K1}`;
    const enc = bio.encrypt('x');
    process.env.BIOMETRIC_DATA_KEY = `3:${K2}`;
    try {
      bio.decrypt(enc);
    } catch (err) {
      expect(err.message).not.toContain(K1);
      expect(err.message).not.toContain(K2);
    }
  });
});
