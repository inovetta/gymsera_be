const placesService = require('../services/places.service');
const areaRequestsService = require('../services/area-requests.service');
const { sendSuccess } = require('../utils/response.utils');

// ── GET /places/autocomplete — Google suggestions for a city, an area or an address ──
const autocomplete = async (req, res, next) => {
  try {
    const { input, kind, sessionToken, cityId, extended } = req.query;
    const result = await placesService.autocomplete({
      input: String(input).trim(),
      kind,
      sessionToken,
      cityId: cityId ? Number(cityId) : null,
      extended: extended === 'true' || extended === '1', // NEW-265: roads and landmarks (build 25 on)
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
      userId: req.user.sub || req.user.id, // NEW-265: a road / landmark pick becomes this person's request
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

// ── NEW-265 Part A: area requests (spec §13 A3) ──────────────────────────────
const callerOf = (req) => ({ userId: req.user.sub || req.user.id, tenantId: req.user.tenantId || null });

// POST /places/area-requests/check — writes nothing
const checkAreaRequest = async (req, res, next) => {
  try {
    const result = await areaRequestsService.checkAreaName({ userId: callerOf(req).userId, cityId: req.body.cityId, name: req.body.name });
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
};

// POST /places/area-requests — 201 a pending request; 200 an existing area or the own open request
const createAreaRequest = async (req, res, next) => {
  try {
    const { status, body } = await areaRequestsService.createAreaRequest({
      userId: callerOf(req).userId,
      cityId: req.body.cityId,
      name: req.body.name,
      confirmNotListed: req.body.confirmNotListed === true,
    });
    return sendSuccess(res, body, status === 201 ? 'Area sent for review' : 'OK', status);
  } catch (err) {
    next(err);
  }
};

// GET /places/area-requests/:id
const getAreaRequest = async (req, res, next) => {
  try {
    return sendSuccess(res, await areaRequestsService.getAreaRequestForCaller(req.params.id, callerOf(req)));
  } catch (err) {
    next(err);
  }
};

module.exports = { autocomplete, details, reverseGeocode, createArea, checkAreaRequest, createAreaRequest, getAreaRequest };
