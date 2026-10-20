/**
 * Re-encodes uploaded images (SEC-08).
 *
 * Decoding and re-encoding with sharp drops everything that is not pixels: EXIF (including GPS position
 * and camera serial), XMP, embedded thumbnails, trailing bytes and scripts hidden in comment blocks.
 * The orientation tag is applied first (`rotate()`), so a phone photo still shows the right way up.
 * Quality is high (visually lossless for photos); PNG stays lossless.
 *
 * sharp is a native module. If it cannot be loaded on a host, uploads still pass the signature check and
 * are stored as they came (see `available()`), and one warning is logged at first use. The deploy notes
 * tell the owner to check that line.
 */
const { createError } = require('../utils/response.utils');

const MAX_PIXELS = 50 * 1000 * 1000; // 50 megapixels; blocks decompression bombs
const JPEG_QUALITY = 92;
const WEBP_QUALITY = 90;

let _sharp;
let _warned = false;

const loadSharp = () => {
  if (_sharp !== undefined) return _sharp;
  try {
    _sharp = require('sharp');
  } catch (err) {
    _sharp = null;
    if (!_warned) {
      _warned = true;
      console.warn(`[image-sanitizer] sharp is not available (${err.message}); images are checked by signature only, not re-encoded`);
    }
  }
  return _sharp;
};

const available = () => loadSharp() !== null;

/**
 * @param {Buffer} buffer  bytes whose signature already matched `mime`
 * @param {'image/jpeg'|'image/png'|'image/webp'} mime
 * @returns {Promise<{ buffer: Buffer, reencoded: boolean }>}
 * @throws 422 when the bytes have the right signature but are not a decodable image
 */
const sanitizeImage = async (buffer, mime) => {
  const sharp = loadSharp();
  if (!sharp) return { buffer, reencoded: false };
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
    let out;
    if (mime === 'image/jpeg') out = await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    else if (mime === 'image/png') out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    else if (mime === 'image/webp') out = await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer();
    else throw new Error(`not an image type: ${mime}`);
    return { buffer: out, reencoded: true };
  } catch (_) {
    throw createError('The file is not a valid image, or it is too large to process', 422);
  }
};

module.exports = { sanitizeImage, available, MAX_PIXELS };
