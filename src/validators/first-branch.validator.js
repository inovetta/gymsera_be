const { body } = require('express-validator');

const KEYS = new Set([
  'branchName', 'cityId', 'areaId', 'areaRequestId', 'address', 'addressLine1', 'addressLine2',
  'postalCode', 'country', 'googlePlaceId', 'latitude', 'longitude', 'phone', 'hours',
  'openingTime', 'closingTime', 'timezone', 'currency', 'tagline', 'description', 'category',
  'establishedYear', 'floorArea', 'facilitiesJson', 'facilities', 'imagesJson', 'packages',
]);

const fail = (message) => { throw new Error(message); };
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
const coordinate = (value, min, max) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

/** One submitted FirstBranch shape for Become a Host, Add Business, and the held-branch editor. */
const validateFirstBranch = (value, { partial = false } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('firstBranch must be an object');
  for (const key of Object.keys(value)) if (!KEYS.has(key)) fail(`Unknown firstBranch field: ${key}`);
  const present = (key) => Object.prototype.hasOwnProperty.call(value, key);
  if (!partial || present('branchName')) if (!text(value.branchName)) fail('branchName is required');
  if (!partial || present('cityId')) if (!integer(value.cityId)) fail('cityId is required');
  if (!partial || present('address')) if (!text(value.address)) fail('address is required');
  if (!partial || present('phone')) if (!text(value.phone)) fail('phone is required');
  if (!partial || present('latitude')) if (!coordinate(value.latitude, -90, 90)) fail('latitude must be between -90 and 90');
  if (!partial || present('longitude')) if (!coordinate(value.longitude, -180, 180)) fail('longitude must be between -180 and 180');
  if (present('googlePlaceId') && value.googlePlaceId != null && value.googlePlaceId !== '' &&
    (typeof value.googlePlaceId !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(value.googlePlaceId))) {
    fail('googlePlaceId is not a Google place id');
  }
  if (present('areaId') && value.areaId != null && !integer(value.areaId)) fail('areaId must be a positive integer');
  if (present('areaRequestId') && value.areaRequestId != null && !integer(value.areaRequestId)) fail('areaRequestId must be a positive integer');
  if (!partial || present('areaId') || present('areaRequestId')) {
    if (Number(present('areaId') && value.areaId != null) + Number(present('areaRequestId') && value.areaRequestId != null) !== 1) {
      fail('Choose exactly one of areaId or areaRequestId');
    }
  }
  if (!partial || present('imagesJson')) {
    if (!Array.isArray(value.imagesJson) || value.imagesJson.length < 3 || !value.imagesJson.every(text)) {
      fail('At least 3 branch images are required');
    }
  }
  if (!partial || present('packages')) {
    if (!Array.isArray(value.packages) || value.packages.length < 1 || !value.packages.every((p) => p && text(p.name) && Number.isFinite(Number(p.price)) && Number(p.price) >= 0)) {
      fail('At least one valid membership plan is required');
    }
  }
  for (const key of ['facilitiesJson', 'facilities']) {
    if (present(key) && (!Array.isArray(value[key]) || value[key].length > 50 || !value[key].every((name) => text(name) && name.trim().length <= 100))) fail(`${key} must be a list of amenity names`);
  }
  return true;
};

const nested = (options = {}) => body('firstBranch').custom((value) => validateFirstBranch(value, options));
const wholeBody = (options = {}) => body().custom((value) => validateFirstBranch(value, options));

module.exports = { KEYS, validateFirstBranch, nested, wholeBody };
