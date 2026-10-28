const placesService = require('../services/places.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /places/autocomplete — Google suggestions for a city, an area or an address ──
const autocomplete = async (req, res, next) => {
  try {
    const { input, kind, sessionToken, cityId } = req.query;
    const result = await placesService.autocomplete({
      input: String(input).trim(),
      kind,
      sessionToken,
      cityId: cityId ? Number(cityId) : null,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /places/details/:placeId — the picked suggestion, with our city / area ids ──
const details = async (req, res, next) => {
  try {
    const { kind, sessionToken, cityId } = req.query;
    const result = await placesService.details({
      placeId: req.params.placeId,
      kind,
      sessionToken,
      cityId: cityId ? Number(cityId) : null,
    });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── GET /places/reverse-geocode — the address at the phone's position ──
const reverseGeocode = async (req, res, next) => {
  try {
    const result = await placesService.reverseGeocode({ latitude: Number(req.query.lat), longitude: Number(req.query.lng) });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// ── POST /places/areas — a typed area when Google has none ──
const createArea = async (req, res, next) => {
  try {
    const area = await placesService.findOrCreateArea({ cityId: Number(req.body.cityId), name: req.body.name });
    return sendSuccess(res, area);
  } catch (err) {
    next(err);
  }
};

module.exports = { autocomplete, details, reverseGeocode, createArea };
