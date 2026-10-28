const { Router } = require('express');
const placesController = require('../controllers/places.controller');
const placesValidators = require('../validators/places.validator');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');

// Phase 7 P3: Google Places through the API (services/places.service.js). Any signed-in person: hosts
// in onboarding and the branch editors, travellers for "Use current location". Rate limited per user
// (rateLimiters.js PLACES_USER), since every call is billed by Google.
const router = Router();

router.use(authenticate);

router.get('/autocomplete', validate(placesValidators.autocomplete), placesController.autocomplete);

router.get('/details/:placeId', validate(placesValidators.details), placesController.details);

router.get('/reverse-geocode', validate(placesValidators.reverseGeocode), placesController.reverseGeocode);

router.post('/areas', validate.strict(placesValidators.createArea, { stage: 2 }), placesController.createArea);

module.exports = router;
