/**
 * ZKTeco Phase 1, device keys (spec ZKTECO_PUSH_DEVICE_SYNC.md §4.2): 8 characters with no
 * 0 / O / 1 / I / L, shown as XXXX-XXXX, stored upper case without the hyphen.
 *
 * The alphabet is built at load time from character ranges, so the source holds no long literal a
 * secret scanner reads as an API key (gitleaks generic-api-key on PR #221). The characters must stay
 * exactly the same: they are pinned here by a SHA-256 of the alphabet as first released.
 */
const fs = require('fs');
const crypto = require('crypto');
const devices = require('../../src/services/devices/device-registry.service');

const RELEASED_ALPHABET_SHA256 = '4ac2059e8d4b68c277801c880630011c2266478f26d170c986f102fef385204e';
const SOURCE = require.resolve('../../src/services/devices/device-registry.service');

describe('device key alphabet', () => {
  test('exactly the released characters: A-Z and 2-9 without O, I, L, 0, 1 (31, in order)', () => {
    expect(devices.KEY_ALPHABET).toHaveLength(31);
    expect(crypto.createHash('sha256').update(devices.KEY_ALPHABET).digest('hex')).toBe(RELEASED_ALPHABET_SHA256);
    expect(devices.KEY_ALPHABET).not.toMatch(/[0O1IL]/);
    expect(new Set(devices.KEY_ALPHABET).size).toBe(31);
  });

  test('the source holds no long literal of key characters (secret scanners read it as a key)', () => {
    const text = fs.readFileSync(SOURCE, 'utf8');
    expect(text).not.toMatch(/['"`[][A-Z0-9]{16,}/);
  });
});

describe('RegistryCode characters (push-protocol.js), same treatment', () => {
  const PROTOCOL_SOURCE = require.resolve('../../src/services/devices/push-protocol');
  const RELEASED_REGISTRY_CHARSET_SHA256 = 'f7e5c946a2291d037646fc504a47ad16cafcfa822a23c2fd40230f0210aa189e';

  test('exactly the released 56 characters, and no long literal in the source', () => {
    const { REGISTRY_CODE_CHARS } = require('../../src/services/devices/push-protocol');
    expect(REGISTRY_CODE_CHARS).toHaveLength(56);
    expect(crypto.createHash('sha256').update(REGISTRY_CODE_CHARS).digest('hex')).toBe(RELEASED_REGISTRY_CHARSET_SHA256);
    expect(fs.readFileSync(PROTOCOL_SOURCE, 'utf8')).not.toMatch(/['"`[][A-Za-z0-9]{16,}['"`\]]/);
  });
});

describe('device keys', () => {
  test('generated keys: 8 characters of the alphabet; shown as XXXX-XXXX', () => {
    for (let i = 0; i < 200; i++) {
      const key = devices.newDeviceKey();
      expect(key).toHaveLength(8);
      for (const ch of key) expect(devices.KEY_ALPHABET).toContain(ch);
      expect(devices.normalizeKey(key)).toBe(key);
      expect(devices.formatKey(key)).toBe(`${key.slice(0, 4)}-${key.slice(4)}`);
    }
  });

  test('normalizeKey: hyphen and case do not matter; anything else is not a key', () => {
    expect(devices.normalizeKey('k7qm-3xrt')).toBe('K7QM3XRT');
    expect(devices.normalizeKey('K7QM3XRT')).toBe('K7QM3XRT');
    for (const bad of ['K7QM3XR', 'K7QM3XRTA', 'K7QM3XR0', 'K7QM3XRO', 'K7QM3XR1', 'K7QM3XRI', 'K7QM3XRL', 'K7QM 3XRT', '', null, undefined]) {
      expect(devices.normalizeKey(bad)).toBeNull();
    }
  });
});
