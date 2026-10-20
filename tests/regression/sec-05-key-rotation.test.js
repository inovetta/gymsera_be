/**
 * SEC-05: key rotation script. Pure logic only (no database): rotateValue and planRotation.
 */
const crypto = require('crypto');
const { encrypt, decrypt } = require('../../src/utils/crypto.utils');
const { rotateValue, planRotation } = require('../../src/scripts/rotate-encryption-key');

const key = () => crypto.randomBytes(32).toString('hex');

describe('SEC-05: rotate-encryption-key', () => {
  const oldKey = key();
  const newKey = key();

  test('a value encrypted with the old key reads with the new key after rotation, not before', () => {
    const original = encrypt('mysql://u:p@h/db', oldKey);
    const rotated = rotateValue(original, oldKey, newKey);
    expect(decrypt(rotated, newKey)).toBe('mysql://u:p@h/db');
    expect(() => decrypt(rotated, oldKey)).toThrow();
    expect(rotated).not.toBe(original);
  });

  test('a value the old key cannot read is reported, never half-converted', () => {
    const foreign = encrypt('x', key());
    const plan = planRotation([{ id: 'a', v: encrypt('ok', oldKey) }, { id: 'b', v: foreign }], 'v', () => false, oldKey, newKey);
    expect(plan.updates.map((u) => u.id)).toEqual(['a']);
    expect(plan.failures.map((f) => f.id)).toEqual(['b']);
  });

  test('empty values and the provisioning placeholder are skipped', () => {
    const plan = planRotation(
      [{ id: 'a', v: null }, { id: 'b', v: 'PENDING_PROVISIONING' }],
      'v', (v) => v === 'PENDING_PROVISIONING', oldKey, newKey
    );
    expect(plan).toEqual({ updates: [], skipped: 2, failures: [] });
  });

  test('without an explicit key, encrypt and decrypt still use the environment key', () => {
    const saved = process.env.TENANT_CONN_ENCRYPTION_KEY;
    process.env.TENANT_CONN_ENCRYPTION_KEY = key();
    try {
      expect(decrypt(encrypt('hello'))).toBe('hello');
    } finally {
      if (saved === undefined) delete process.env.TENANT_CONN_ENCRYPTION_KEY; else process.env.TENANT_CONN_ENCRYPTION_KEY = saved;
    }
  });
});
