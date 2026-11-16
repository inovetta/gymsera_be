const { Router } = require('express');
const placesController = require('../controllers/places.controller');
const placesValidators = require('../validators/places.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const { sendError } = require('../utils/response.utils');
const { AREA_NOT_LISTED_MESSAGE } = require('../services/places.service');

// NEW-259 (R-107): a typed area is added by a platform administrator only (CMS › Cities & Areas uses
// POST /cities/:id/areas). Anyone else is told to pick from the list, with the same code the area
// checks use, so app builds that still offer "Use what you typed" show that message.
const platformAdminOnly = (req, res, next) => (req.user && req.user.role === 'PLATFORM_ADMIN'
  ? next()
  : sendError(res, 403, AREA_NOT_LISTED_MESSAGE, 'area_not_listed'));

// Phase 7 P3: Google Places through the API (services/places.service.js). Any signed-in person: hosts
// in onboarding and the branch editors, travellers for "Use current location". Rate limited per user
// (rateLimiters.js PLACES_USER), since every call is billed by Google.
const router = Router();

router.use(authenticate);

router.get('/autocomplete', validate(placesValidators.autocomplete), placesController.autocomplete);

router.get('/details/:placeId', validate(placesValidators.details), placesController.details);

router.get('/reverse-geocode', validate(placesValidators.reverseGeocode), placesController.reverseGeocode);

router.post('/areas', platformAdminOnly, validate.strict(placesValidators.createArea, { stage: 2 }), placesController.createArea);

module.exports = router;
