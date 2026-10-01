'use strict';

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_KYC_BUCKET,
} = process.env;

// Dedicated private bucket name (decision R-27) or fallback
const KYC_BUCKET = R2_KYC_BUCKET || (R2_BUCKET ? `${R2_BUCKET}-kyc` : null);

// Private storage directory on local disk (completely outside public/uploads)
const PRIVATE_KYC_DIR = path.join(__dirname, '../../storage/private/kyc');

let _s3Client = null;

function getS3Client() {
  if (!_s3Client) {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
      return null;
    }
    _s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3Client;
}

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

/**
 * Validates file magic bytes against declared MIME type (SEC-08 / SEC-10).
 * Prevents disguised files (e.g. HTML/JS/EXE renamed to .jpg or .pdf).
 */
function validateMagicBytes(buffer, mimetype) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  // PDF: %PDF (0x25 0x50 0x44 0x46)
  if (mimetype === 'application/pdf') {
    return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
  }

  // JPEG / JPG: 0xFF 0xD8 0xFF
  if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  // PNG: 0x89 0x50 0x4E 0x47
  if (mimetype === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }

  // WEBP: 'RIFF' at 0..3 and 'WEBP' at 8..11
  if (mimetype === 'image/webp') {
    if (buffer.length < 12) return false;
    return (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }

  return false;
}

/**
 * Saves a buffer to private local disk storage.
 */
function saveLocalPrivate(buffer, key) {
  const safeKey = path.normalize(key).replace(/^(\.\.[\/\\])+/, '');
  const targetPath = path.join(PRIVATE_KYC_DIR, safeKey);
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

/**
 * Uploads a KYC document to private encrypted storage (R2 with SSE-AES256 or local private disk).
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.mimetype
 * @param {string} params.tenantId
 * @param {string} [params.originalName]
 * @param {string} [params.documentType]
 * @returns {Promise<object>} document descriptor
 */
async function uploadKycDocument({ buffer, mimetype, tenantId, originalName = 'document', documentType = 'BUSINESS_LICENSE' }) {
  const normMime = (mimetype || '').toLowerCase().trim();
  if (!ALLOWED_MIME_TYPES.has(normMime)) {
    const err = new Error(`Unsupported KYC document MIME type: ${normMime}. Allowed: PDF, JPEG, PNG, WEBP.`);
    err.status = 422;
    throw err;
  }

  if (!validateMagicBytes(buffer, normMime)) {
    const err = new Error('File content does not match the declared MIME type (magic bytes check failed).');
    err.status = 422;
    throw err;
  }

  const ext = normMime === 'application/pdf' ? 'pdf' : normMime.split('/')[1].replace('jpeg', 'jpg');
  const docId = `doc_${crypto.randomBytes(12).toString('hex')}`;
  const key = `tenants/${tenantId}/kyc/${docId}-${Date.now()}.${ext}`;

  const client = getS3Client();
  if (client && KYC_BUCKET && process.env.NODE_ENV !== 'test') {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: KYC_BUCKET,
          Key: key,
          Body: buffer,
          ContentType: normMime,
          ServerSideEncryption: 'AES256', // SSE-AES256 encryption at rest (decision R-27)
        })
      );
    } catch (err) {
      console.warn('[KYC Storage] Failed to upload to private R2 bucket, falling back to private local storage:', err.message);
      saveLocalPrivate(buffer, key);
    }
  } else {
    // Local development or test environment: private disk outside public web roots
    saveLocalPrivate(buffer, key);
  }

  return {
    documentId: docId,
    key,
    originalName: path.basename(originalName),
    mimetype: normMime,
    size: buffer.length,
    documentType,
    uploadedAt: new Date().toISOString(),
  };
}

/**
 * Retrieves a stream to read a private KYC document.
 *
 * @param {string} key
 * @returns {Promise<{ stream: import('stream').Readable, contentType: string, contentLength: number }>}
 */
async function getKycStream(key) {
  if (!key) throw new Error('Document key is required');

  const client = getS3Client();
  if (client && KYC_BUCKET && process.env.NODE_ENV !== 'test') {
    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: KYC_BUCKET,
          Key: key,
        })
      );
      return {
        stream: response.Body,
        contentType: response.ContentType || 'application/octet-stream',
        contentLength: response.ContentLength,
      };
    } catch (err) {
      // Check if file exists locally before throwing
      const localPath = path.join(PRIVATE_KYC_DIR, path.normalize(key).replace(/^(\.\.[\/\\])+/, ''));
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        return {
          stream: fs.createReadStream(localPath),
          contentType: 'application/octet-stream',
          contentLength: stat.size,
        };
      }
      throw err;
    }
  }

  // Local private storage
  const safeKey = path.normalize(key).replace(/^(\.\.[\/\\])+/, '');
  const localPath = path.join(PRIVATE_KYC_DIR, safeKey);
  if (!fs.existsSync(localPath)) {
    const err = new Error('KYC document file not found on storage');
    err.status = 404;
    throw err;
  }

  const stat = fs.statSync(localPath);
  return {
    stream: fs.createReadStream(localPath),
    contentType: 'application/octet-stream',
    contentLength: stat.size,
  };
}

/**
 * Deletes a KYC document from storage.
 *
 * @param {string} key
 */
async function deleteKycFile(key) {
  if (!key) return;

  const client = getS3Client();
  if (client && KYC_BUCKET && process.env.NODE_ENV !== 'test') {
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: KYC_BUCKET,
          Key: key,
        })
      );
    } catch (err) {
      console.warn('[KYC Storage] Failed to delete from R2:', err.message);
    }
  }

  // Also clean up local file if present
  try {
    const safeKey = path.normalize(key).replace(/^(\.\.[\/\\])+/, '');
    const localPath = path.join(PRIVATE_KYC_DIR, safeKey);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  } catch (err) {
    console.warn('[KYC Storage] Local delete error:', err.message);
  }
}

/**
 * Normalizes KYC documents array into a consistent structure.
 * Gracefully handles legacy strings or structured objects.
 */
function normalizeKycDocuments(docs) {
  if (!docs) return [];
  if (Array.isArray(docs)) {
    return docs.map((doc, idx) => {
      if (typeof doc === 'string') {
        return {
          documentId: `legacy_${idx}`,
          key: doc,
          originalName: path.basename(doc) || `document_${idx + 1}`,
          mimetype: 'application/octet-stream',
          size: 0,
          documentType: 'LEGACY_URL',
          uploadedAt: null,
          isLegacyUrl: true,
          url: doc,
        };
      }
      return doc;
    });
  }
  return [];
}

module.exports = {
  uploadKycDocument,
  getKycStream,
  deleteKycFile,
  validateMagicBytes,
  normalizeKycDocuments,
  PRIVATE_KYC_DIR,
  ALLOWED_MIME_TYPES,
};
