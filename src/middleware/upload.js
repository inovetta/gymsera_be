const multer = require('multer');
const path = require('path');
const { createError } = require('../utils/response.utils');

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * In-memory storage — we pass the buffer directly to the cloud storage layer.
 * No temp files are written to disk, which avoids path-traversal and leftover
 * file vulnerabilities.
 */
const imageStorage = multer.memoryStorage();

const imageFileFilter = (_req, file, cb) => {
  if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(createError('Only JPEG, PNG and WebP images are accepted', 422), false);
  }
};

/**
 * Single image upload — field name is configurable.
 * Usage: upload.image('avatar')
 */
const image = (fieldName = 'image') =>
  multer({
    storage: imageStorage,
    limits: { fileSize: MAX_IMAGE_SIZE },
    fileFilter: imageFileFilter,
  }).single(fieldName);

/**
 * Multer error handler — converts multer errors to our standard error shape.
 * Mount AFTER the multer middleware in a route handler.
 */
const handleMulterError = (err, _req, _res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return next(createError('File size must not exceed 10 MB', 413));
  }
  next(err);
};

module.exports = { image, handleMulterError };
