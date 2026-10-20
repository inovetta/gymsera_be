const multer = require('multer');
const { createError } = require('../utils/response.utils');
const { sniffMime, normalizeMime } = require('../utils/file-signature');
const { sanitizeImage } = require('../services/image-sanitizer');

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

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

/**
 * SEC-08: the client's Content-Type is only a claim. The bytes must be a type this route accepts and
 * agree with the claim. Images are then re-encoded (EXIF/GPS and anything hidden in the file is dropped)
 * and the file object is replaced with the clean bytes and the real type. Documents (KYC) are checked by
 * signature only and stored untouched, because they are evidence and live in private storage.
 */
const verifyFiles = ({ allowed, reencode }) => async (req, _res, next) => {
  try {
    const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : [];
    for (const file of files) {
      const real = sniffMime(file.buffer);
      if (!real || !allowed.includes(real) || real !== normalizeMime(file.mimetype)) {
        throw createError(
          reencode ? 'The file content is not a JPEG, PNG or WebP image (magic bytes check failed)' : 'The file content is not a PDF, JPEG, PNG or WebP document (magic bytes check failed)',
          422
        );
      }
      if (reencode) {
        const clean = await sanitizeImage(file.buffer, real);
        file.buffer = clean.buffer;
        file.size = clean.buffer.length;
      }
      file.mimetype = real;
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** Runs the multer middleware, then the signature check. One middleware, so call sites do not change. */
const withVerification = (multerMiddleware, options) => {
  const verify = verifyFiles(options);
  return (req, res, next) => multerMiddleware(req, res, (err) => (err ? next(err) : verify(req, res, next)));
};

/** Single image upload — field name is configurable. */
const image = (fieldName = 'image') =>
  withVerification(
    multer({
      storage: imageStorage,
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: imageFileFilter,
    }).single(fieldName),
    { allowed: IMAGE_TYPES, reencode: true }
  );

/** Multiple image upload — up to maxCount files in one request. */
const images = (fieldName = 'images', maxCount = MAX_MULTI_COUNT) =>
  withVerification(
    multer({
      storage: imageStorage,
      limits: { fileSize: MAX_IMAGE_SIZE, files: maxCount },
      fileFilter: imageFileFilter,
    }).array(fieldName, maxCount),
    { allowed: IMAGE_TYPES, reencode: true }
  );

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
  withVerification(
    multer({
      storage: imageStorage,
      limits: { fileSize: MAX_IMAGE_SIZE },
      fileFilter: docFileFilter,
    }).single(fieldName),
    { allowed: DOCUMENT_TYPES, reencode: false }
  );

/** Multiple documents upload (PDF or image). */
const documents = (fieldName = 'documents', maxCount = 5) =>
  withVerification(
    multer({
      storage: imageStorage,
      limits: { fileSize: MAX_IMAGE_SIZE, files: maxCount },
      fileFilter: docFileFilter,
    }).array(fieldName, maxCount),
    { allowed: DOCUMENT_TYPES, reencode: false }
  );

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

