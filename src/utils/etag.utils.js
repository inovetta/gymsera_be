const crypto = require('crypto');

/**
 * ETag for API responses (API-06, spec §4.1 / §10.3).
 *
 * Express's default ETag hashes the whole body, and our envelope carries
 * `meta.timestamp` and `meta.requestId`, so two identical reads never shared a
 * validator and a 304 could not happen. The tag is therefore a hash of the
 * response CONTENT only: `data` and `pagination` of a success envelope. Any
 * other body (errors, non-JSON, exports) is hashed whole.
 *
 * It is content-derived and computed per response, after authorization has
 * produced that user's body, so a validator can only match a body with the
 * same content; it carries no identity and is never shared between users.
 * Authenticated responses are additionally `Cache-Control: private`
 * (middleware/cachePolicy.js).
 */
const weak = (buf, label) =>
  `W/"${buf.length.toString(16)}-${crypto.createHash('sha1').update(label).update(buf).digest('base64').slice(0, 27)}"`;

const contentEtag = (body, encoding) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), encoding || 'utf8');
  try {
    const json = JSON.parse(buf.toString('utf8'));
    if (json && typeof json === 'object' && json.success === true && 'data' in json) {
      const content = Buffer.from(JSON.stringify({ data: json.data, pagination: json.pagination }));
      return weak(content, 'c');
    }
  } catch (_) { /* not JSON: hash the bytes */ }
  return weak(buf, 'b');
};

module.exports = { contentEtag };
