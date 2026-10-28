const { body, param, query } = require('express-validator');

const KINDS = ['city', 'area', 'address'];

// A Places session token: the app makes one per search (UUID); anything else is refused, not passed to Google.
const sessionToken = (required) => {
  const chain = query('sessionToken');
  return (required ? chain : chain.optional())
    .isString()
    .matches(/^[A-Za-z0-9_-]{1,64}$/)
    .withMessage('sessionToken must be 1-64 letters, digits, - or _');
};

const cityIdForArea = query('cityId')
  .if(query('kind').equals('area'))
  .isInt({ min: 1 })
  .withMessage('cityId is required to search areas');

// An address search may name the selected city (country and bias); a city search ignores it.
const optionalCityId = query('cityId')
  .if(query('kind').not().equals('area'))
  .optional()
  .isInt({ min: 1 })
  .withMessage('cityId must be a positive integer');

const placesValidators = {
  autocomplete: [
    query('input').isString().trim().isLength({ min: 2, max: 200 }).withMessage('input must be 2-200 characters'),
    query('kind').isIn(KINDS).withMessage('kind must be city, area or address'),
    sessionToken(true),
    cityIdForArea,
    optionalCityId,
  ],

  details: [
    param('placeId').matches(/^[A-Za-z0-9_-]{1,255}$/).withMessage('Invalid place id'),
    query('kind').isIn(KINDS).withMessage('kind must be city, area or address'),
    sessionToken(false),
    cityIdForArea,
  ],

  reverseGeocode: [
    query('lat').isFloat({ min: -90, max: 90 }).withMessage('lat must be between -90 and 90'),
    query('lng').isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180'),
  ],

  createArea: [
    body('cityId').isInt({ min: 1 }).withMessage('cityId must be a positive integer'),
    body('name').isString().trim().notEmpty().withMessage('Please enter the area name.')
      .isLength({ max: 100 }).withMessage('Area name must be 100 characters or fewer'),
  ],
};

module.exports = placesValidators;
