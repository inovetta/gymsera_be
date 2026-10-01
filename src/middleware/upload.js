const multer = require('multer');
const { createError } = require('../utils/response.utils');

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_MULTI_COUNT = 10;

const imageStorage = multer.memoryStorage();

const imageFileFilter = (_req, file, cb) => {
  if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(createError('Only JPEG, PNG and WebP images are accepted', 422), false);
  }
};

/** Single image upload — field name is configurable. */
const image = (fieldName = 'image') =>
  multer({
    storage: imageStorage,
    limits: { fileSize: MAX_IMAGE_SIZE },
    fileFilter: imageFileFilter,
  }).single(fieldName);

/** Multiple image upload — up to maxCount files in one request. */
const images = (fieldName = 'images', maxCount = MAX_MULTI_COUNT) =>
  multer({
    storage: imageStorage,
    limits: { fileSize: MAX_IMAGE_SIZE, files: maxCount },
    fileFilter: imageFileFilter,
  }).array(fieldName, maxCount);

const ALLOWED_DOC_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const docFileFilter = (_req, file, cb) => {
  if (ALLOWED_DOC_MIME.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(createError('Only PDF, JPEG, PNG and WebP files are accepted', 422), false);
  }
};

/** Single document upload (PDF or image). */
const document = (fieldName = 'document') =>
  multer({
    storage: imageStorage,
    limits: { fileSize: MAX_IMAGE_SIZE },
    fileFilter: docFileFilter,
  }).single(fieldName);

/** Multiple documents upload (PDF or image). */
const documents = (fieldName = 'documents', maxCount = 5) =>
  multer({
    storage: imageStorage,
    limits: { fileSize: MAX_IMAGE_SIZE, files: maxCount },
    fileFilter: docFileFilter,
  }).array(fieldName, maxCount);

const handleMulterError = (err, _req, _res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return next(createError('File size must not exceed 10 MB', 413));
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return next(createError(`You may upload at most ${MAX_MULTI_COUNT} files at once`, 413));
  }
  next(err);
};

module.exports = { image, images, document, documents, handleMulterError };

