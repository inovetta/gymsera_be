/**
 * File signatures ("magic bytes") for the upload types we accept (SEC-08).
 *
 * The client's Content-Type is a claim; the first bytes of the file are the fact. Used by the upload
 * middleware (images and documents) and by the KYC storage service, so there is one definition.
 */

const hasPrefix = (buf, bytes) => bytes.every((b, i) => buf[i] === b);

/** @returns {'image/jpeg'|'image/png'|'image/webp'|'application/pdf'|null} */
const sniffMime = (buffer) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (hasPrefix(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buffer.length >= 8 && hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // The signature must be at offset 0: a PDF header hidden after other bytes is how polyglots are made.
  if (hasPrefix(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
};

/** 'image/jpg' is a common wrong spelling of 'image/jpeg'. */
const normalizeMime = (mime) => {
  const m = String(mime || '').toLowerCase().trim();
  return m === 'image/jpg' ? 'image/jpeg' : m;
};

/** True when the bytes are what the declared type says they are. */
const matchesDeclared = (buffer, declaredMime) => {
  const sniffed = sniffMime(buffer);
  return sniffed !== null && sniffed === normalizeMime(declaredMime);
};

module.exports = { sniffMime, normalizeMime, matchesDeclared };
