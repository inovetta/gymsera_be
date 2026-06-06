const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const crypto = require('crypto');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL,
} = process.env;

let _client = null;

function getClient() {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

/**
 * Upload a file buffer to Cloudflare R2.
 * @param {Buffer} buffer      File buffer from multer memoryStorage
 * @param {string} mimetype    e.g. 'image/jpeg'
 * @param {string} folder      e.g. 'cities', 'gyms', 'profiles'
 * @param {string} [filename]  Optional filename override (without extension)
 * @returns {Promise<string>}  Public URL of the uploaded file
 */
const uploadImage = async (buffer, mimetype, folder, filename) => {
  const ext = mimetype.split('/')[1].replace('jpeg', 'jpg');
  const name = filename
    ? `${filename}.${ext}`
    : `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const key = `${folder}/${name}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  return `${R2_PUBLIC_URL}/${key}`;
};

/**
 * Delete a file from R2 by its public URL.
 * @param {string} url  Public URL previously returned by uploadImage
 */
const deleteImage = async (url) => {
  if (!url || !url.startsWith(R2_PUBLIC_URL)) return;
  const key = url.slice(R2_PUBLIC_URL.length + 1); // strip leading slash
  await getClient().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
};

/**
 * Upload multiple file buffers (from multer array) to R2.
 * @param {Array<{buffer: Buffer, mimetype: string}>} files  multer file objects
 * @param {string} folder  e.g. 'branches/images'
 * @returns {Promise<string[]>}  Array of public URLs
 */
const uploadImages = async (files, folder) => {
  return Promise.all(files.map((f) => uploadImage(f.buffer, f.mimetype, folder)));
};

module.exports = { uploadImage, uploadImages, deleteImage };
