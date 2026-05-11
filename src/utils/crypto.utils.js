const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

/**
 * Returns the 32-byte encryption key from the environment.
 * Throws at runtime (not module load) so the app can start and report the error clearly.
 */
const getKey = () => {
  const hex = process.env.TENANT_CONN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'TENANT_CONN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
        'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
};

/**
 * Encrypt a plaintext string.
 * A random 16-byte IV is generated per call and prepended to the output (hex:hex format).
 */
const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(16);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
};

/**
 * Decrypt a string produced by `encrypt`.
 */
const decrypt = (encryptedStr) => {
  const [ivHex, encrypted] = encryptedStr.split(':');
  if (!ivHex || !encrypted) {
    throw new Error('Invalid encrypted string format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

module.exports = { encrypt, decrypt };
