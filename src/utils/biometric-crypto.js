/**
 * Biometric data at rest (spec docs/ZKTECO_PUSH_DEVICE_SYNC.md §6.2, §14 point 2): AES-256-GCM.
 *
 * Keys come from BIOMETRIC_DATA_KEY, a comma list of `<version>:<64 hex>`; the FIRST entry
 * encrypts, every entry decrypts. Rotation (docs/runbooks/secrets-rotation.md section 3c):
 * put the new key first and keep the old one after it, restart, run
 * `node src/scripts/rotate-biometric-key.js` (dry run, then --apply), then drop the old entry.
 *
 * A value is one Buffer: [0x01 format][version, 2 bytes BE][IV 12][tag 16][ciphertext].
 * Separate from crypto.utils.js (TENANT_CONN_ENCRYPTION_KEY, AES-CBC, one key): biometric data
 * needs its own key, authenticated encryption and rotation without downtime.
 *
 * Never log a plaintext, a key, or a ciphertext.
 */
const crypto = require('crypto');

const FORMAT = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER = 1 + 2 + IV_LEN + TAG_LEN;

const KEY_HELP =
  'BIOMETRIC_DATA_KEY must be "<version>:<64 hex>" (comma list, first one encrypts). ' +
  'Generate a key with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

/** [{ version, key }] in the order configured. Throws (without the key) when the setting is wrong. */
function keys() {
  const raw = String(process.env.BIOMETRIC_DATA_KEY || '').trim();
  if (!raw) throw new Error(`BIOMETRIC_DATA_KEY is not set. ${KEY_HELP}`);
  const seen = new Set();
  return raw.split(',').map((entry) => {
    const m = /^\s*(\d{1,5}):([0-9a-fA-F]*)\s*$/.exec(entry);
    if (!m) throw new Error(`BIOMETRIC_DATA_KEY entry is not <version>:<64 hex>. ${KEY_HELP}`);
    const version = Number(m[1]);
    if (version < 1 || version > 65535) throw new Error('BIOMETRIC_DATA_KEY versions are 1 to 65535.');
    if (m[2].length !== 64) throw new Error(`BIOMETRIC_DATA_KEY version ${version} is not 64 hex characters.`);
    if (seen.has(version)) throw new Error(`BIOMETRIC_DATA_KEY lists version ${version} twice.`);
    seen.add(version);
    return { version, key: Buffer.from(m[2], 'hex') };
  });
}

const isConfigured = () => {
  try {
    return keys().length > 0;
  } catch (_) {
    return false;
  }
};

const currentVersion = () => keys()[0].version;

/** Buffer or string (UTF-8) → Buffer. */
function encrypt(plain) {
  const { version, key } = keys()[0];
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), cipher.final()]);
  const head = Buffer.alloc(3);
  head[0] = FORMAT;
  head.writeUInt16BE(version, 1);
  return Buffer.concat([head, iv, cipher.getAuthTag(), body]);
}

function versionOf(value) {
  const buf = Buffer.from(value);
  if (buf.length < HEADER || buf[0] !== FORMAT) throw new Error('Not a biometric ciphertext.');
  return buf.readUInt16BE(1);
}

/** → Buffer. Throws when the key version is not configured or the value was changed. */
function decrypt(value) {
  const buf = Buffer.from(value);
  const version = versionOf(buf);
  const entry = keys().find((k) => k.version === version);
  if (!entry) throw new Error(`No BIOMETRIC_DATA_KEY for key version ${version}.`);
  const iv = buf.subarray(3, 3 + IV_LEN);
  const tag = buf.subarray(3 + IV_LEN, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', entry.key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(HEADER)), decipher.final()]);
}

const decryptText = (value) => decrypt(value).toString('utf8');

/** The same plaintext under the current key (rotation). */
const reencrypt = (value) => encrypt(decrypt(value));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { encrypt, decrypt, decryptText, reencrypt, versionOf, currentVersion, isConfigured, sha256 };
