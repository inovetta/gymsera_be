/**
 * Google Places behind the API (Phase 7 P3, BUG-01 to BUG-04, R-76).
 *
 * The apps never call Google with a key for search: they call /places/*, and this service calls
 * Places API (New) autocomplete and place details, and the Geocoding API, with the server key
 * `GOOGLE_MAPS_SERVER_KEY` (API env only, never in git). The mobile key in the app build only draws maps.
 *
 * Every place it resolves is upserted into `cities` / `areas` (by Google place id, else by name, so an
 * admin-made "Lahore" is reused, not duplicated). Callers get our ids back, so discovery filters,
 * tenants and branches keep using `cityId` / `areaId` as before.
 *
 * NEW-259 (R-107): an area is created when the host picks it (here), never typed in. Area suggestions
 * are our own areas of the chosen city first (placeId `gymsera-area:<id>`, resolved by details() without
 * Google, so builds that only know Google place ids keep working), then Google's, restricted to the
 * city. details() refuses a Google area in another city, and every write that takes an areaId calls
 * assertAreaInCity (code `area_not_listed`).
 */
const { Op } = require('sequelize');
const { City, Area } = require('../models/platform');
const { sequelize } = require('../database/platform');
const { createError } = require('../utils/response.utils');
const { likeContains } = require('../utils/sql-like');

const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const TIMEOUT_MS = 5000;
const CITY_RADIUS_M = 25000; // address search: bias; area search: restriction (NEW-259)
const OUR_AREA_PREFIX = 'gymsera-area:';
const OUR_AREA_LIMIT = 8;
const DEFAULT_REGION = 'pk';
const DETAILS_FIELDS = 'id,displayName,formattedAddress,location,addressComponents,types';

// Places (New) types used to read a city and an area out of an address.
const CITY_TYPES = ['locality', 'postal_town', 'administrative_area_level_3', 'administrative_area_level_2'];
const AREA_TYPES = ['sublocality_level_1', 'sublocality', 'neighborhood'];

const serverKey = () => {
  const key = (process.env.GOOGLE_MAPS_SERVER_KEY || '').trim();
  if (!key) throw createError('Location search is not available right now.', 503, 'places_not_configured');
  return key;
};

/** Optional `GOOGLE_PLACES_REGION_CODES=pk,ae`: the countries searched when no city country is known; else Pakistan. */
const defaultRegions = () => {
  const list = (process.env.GOOGLE_PLACES_REGION_CODES || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : [DEFAULT_REGION];
};

/** Autocomplete stays in the selected city's country, else the default countries. */
const regionsFor = (city) => (city?.countryCode ? [city.countryCode.toLowerCase()] : defaultRegions());

/** A two-letter country code, upper case, or null. */
const cleanCountryCode = (code) => (/^[A-Za-z]{2}$/.test(code || '') ? code.toUpperCase() : null);

/** Trims and collapses spaces; null when nothing is left. */
const normalizeName = (name) => {
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 100) : null;
};

const titleCase = (name) => name.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

const sameName = (name) => sequelize.where(sequelize.fn('LOWER', sequelize.col('name')), name.toLowerCase());

const toNumber = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * One call to Google. The key travels in a header for Places (New); the Geocoding API only takes it in
 * the query string, so no URL is ever logged here. Quota and outages become 503s the apps can explain.
 */
const callGoogle = async (url, init = {}) => {
  let res;
  try {
    res = await global.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.warn(`[places] Google unreachable: ${err.name}`);
    throw createError('Location search is not available right now. Please try again.', 503, 'places_unavailable');
  }
  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }
  const googleStatus = body?.error?.status || body?.status;
  if (res.status === 429 || googleStatus === 'RESOURCE_EXHAUSTED' || googleStatus === 'OVER_QUERY_LIMIT') {
    console.warn('[places] Google quota reached');
    throw createError('Location search is busy right now. Please try again in a few minutes.', 503, 'places_quota');
  }
  if (res.status === 404 || googleStatus === 'NOT_FOUND' || googleStatus === 'INVALID_REQUEST') {
    throw createError('We could not find that place. Please pick another one.', 404, 'place_not_found');
  }
  if (!res.ok || googleStatus === 'REQUEST_DENIED' || googleStatus === 'PERMISSION_DENIED') {
    console.warn(`[places] Google answered ${res.status} ${googleStatus || ''}`.trim());
    throw createError('Location search is not available right now. Please try again.', 503, 'places_unavailable');
  }
  return body;
};

const placesHeaders = (fieldMask) => ({
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': serverKey(),
  ...(fieldMask ? { 'X-Goog-FieldMask': fieldMask } : {}),
});

/** Finds a city by place id, else by name (any case); fills the place id and centre it lacks; else creates it. */
const upsertCity = async ({ name, placeId = null, latitude = null, longitude = null, countryCode = null }) => {
  const clean = normalizeName(name);
  if (!clean) return null;
  let city = placeId ? await City.findOne({ where: { googlePlaceId: placeId } }) : null;
  if (!city) city = await City.findOne({ where: sameName(clean), order: [['id', 'ASC']] });
  if (!city) {
    try {
      return await City.create({ name: clean, isActive: true, googlePlaceId: placeId, latitude, longitude, countryCode });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      return City.findOne({ where: { googlePlaceId: placeId } }); // created by a parallel request
    }
  }
  const patch = {};
  if (placeId && !city.googlePlaceId) patch.googlePlaceId = placeId;
  if (latitude !== null && city.latitude === null) Object.assign(patch, { latitude, longitude });
  if (countryCode && !city.countryCode) patch.countryCode = countryCode;
  if (Object.keys(patch).length) {
    try {
      await city.update(patch);
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err; // that place id already sits on another row
    }
  }
  return city;
};

/** Same rule as upsertCity, inside one city. */
const upsertArea = async ({ cityId, name, placeId = null }) => {
  const clean = normalizeName(name);
  if (!clean || !cityId) return null;
  let area = placeId ? await Area.findOne({ where: { googlePlaceId: placeId } }) : null;
  if (area && area.cityId !== cityId) area = null; // Google filed it elsewhere; keep the host's city
  if (!area) area = await Area.findOne({ where: { [Op.and]: [{ cityId }, sameName(clean)] }, order: [['id', 'ASC']] });
  if (!area) {
    try {
      return await Area.create({ cityId, name: clean, googlePlaceId: placeId });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      return Area.create({ cityId, name: clean, googlePlaceId: null });
    }
  }
  if (placeId && !area.googlePlaceId) {
    try {
      await area.update({ googlePlaceId: placeId });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    }
  }
  return area;
};

/** Lower case, single spaces: how two area names are compared. */
const nameKey = (name) => (normalizeName(name) || '').toLowerCase();

const AREA_NOT_LISTED_MESSAGE = 'Pick your area from the list for the chosen city. Can\'t find your area? Contact support.';
const areaNotListed = () => createError(AREA_NOT_LISTED_MESSAGE, 422, 'area_not_listed');

/**
 * NEW-259: every write that takes an areaId. No area (null, 0, '') is allowed; an area must exist and belong
 * to `cityId` (the city sent with it, else the record's own city). Returns the area, or null.
 */
const assertAreaInCity = async ({ cityId, areaId }) => {
  if (areaId === undefined || areaId === null || areaId === '' || areaId === 0 || areaId === '0') return null;
  const id = Number(areaId);
  const area = Number.isInteger(id) && id > 0 ? await Area.findByPk(id) : null;
  if (!area || !cityId || Number(area.cityId) !== Number(cityId)) throw areaNotListed();
  return area;
};

const findCityOr404 = async (cityId) => {
  const city = cityId ? await City.findByPk(cityId) : null;
  if (!city) throw createError('City not found', 404, 'city_not_found');
  return city;
};

/** "Peshawar" and "Peshawar District" are the same city; "Lahore" and "Peshawar" are not. */
const sameCityName = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};

const shapeCity = (city) => (city ? { id: city.id, name: city.name } : null);
const shapeArea = (area) => (area ? { id: area.id, name: area.name } : null);

/** First address component of one of `types`, in the order of `types`. */
const pickComponent = (components, types, field = 'longText') => {
  for (const t of types) {
    const c = (components || []).find((x) => (x.types || []).includes(t));
    if (c && c[field]) return c[field];
  }
  return null;
};

// ── Autocomplete ──────────────────────────────────────────────────────────────

/**
 * @param {{ input: string, kind: 'city'|'area'|'address', sessionToken: string, cityId?: number }} q
 * @returns {Promise<{ suggestions: Array<{ placeId: string, primaryText: string, secondaryText: string|null }> }>}
 */
const autocomplete = async ({ input, kind, sessionToken, cityId }) => {
  const body = { input, sessionToken };
  let city = null;
  if (kind === 'area') city = await findCityOr404(cityId);
  else if (kind === 'address' && cityId) city = await City.findByPk(cityId); // unknown id: search without it

  body.includedRegionCodes = regionsFor(city);
  const hasCentre = city && city.latitude !== null && city.longitude !== null;
  if (hasCentre && kind !== 'city') {
    body.locationBias = {
      circle: { center: { latitude: Number(city.latitude), longitude: Number(city.longitude) }, radius: CITY_RADIUS_M },
    };
  }
  if (kind === 'city') {
    body.includedPrimaryTypes = ['(cities)'];
  } else if (kind === 'area') {
    body.includedPrimaryTypes = ['sublocality', 'neighborhood'];
    if (hasCentre) {
      // NEW-259: inside the city only, not merely near it.
      body.locationRestriction = body.locationBias;
      delete body.locationBias;
    } else {
      body.input = `${input}, ${city.name}`; // no centre yet: the city name narrows it instead
    }
    return areaSuggestions({ input, city, hasCentre, body });
  }

  return { suggestions: await googleSuggestions(body) };
};

const googleSuggestions = async (body) => {
  const res = await callGoogle(`${PLACES_BASE}/places:autocomplete`, {
    method: 'POST',
    headers: placesHeaders(),
    body: JSON.stringify(body),
  });
  return (res.suggestions || [])
    .map((s) => s.placePrediction)
    .filter((p) => p && p.placeId)
    .map((p) => ({
      placeId: p.placeId,
      primaryText: p.structuredFormat?.mainText?.text || p.text?.text || '',
      secondaryText: p.structuredFormat?.secondaryText?.text || null,
    }));
};

const ourAreaSuggestion = (area, city) => ({ placeId: `${OUR_AREA_PREFIX}${area.id}`, primaryText: area.name, secondaryText: city.name });

/**
 * NEW-259 (R-107): our areas of the city that match the input first, then Google's areas in the city.
 * A Google suggestion we already hold (same place id, else same name) is shown once, as ours.
 * When Google fails, our own matches still answer; with none, the Google error stands.
 */
const areaSuggestions = async ({ input, city, hasCentre, body }) => {
  const key = nameKey(input);
  const ours = await Area.findAll({
    where: { cityId: city.id, name: { [Op.like]: likeContains(normalizeName(input) || '') } },
    order: [['name', 'ASC']],
    limit: 50,
  });
  ours.sort((a, b) => Number(!nameKey(a.name).startsWith(key)) - Number(!nameKey(b.name).startsWith(key)));
  const picked = ours.slice(0, OUR_AREA_LIMIT);

  let google;
  try {
    google = await googleSuggestions(body);
  } catch (err) {
    if (picked.length) return { suggestions: picked.map((a) => ourAreaSuggestion(a, city)) };
    throw err;
  }
  if (!hasCentre) {
    // Searched by name only: keep what Google itself places in this city.
    const cityKey = nameKey(city.name);
    google = google.filter((s) => nameKey(s.secondaryText).includes(cityKey));
  }

  const known = google.length
    ? await Area.findAll({
      where: {
        cityId: city.id,
        [Op.or]: [
          { googlePlaceId: google.map((s) => s.placeId) },
          sequelize.where(sequelize.fn('LOWER', sequelize.col('name')), { [Op.in]: google.map((s) => nameKey(s.primaryText)) }),
        ],
      },
    })
    : [];

  const ourIds = new Set(picked.map((a) => a.id));
  const ourList = [...picked];
  const googleList = [];
  const seenNames = new Set(picked.map((a) => nameKey(a.name)));
  for (const s of google) {
    const match = known.find((a) => a.googlePlaceId === s.placeId) || known.find((a) => nameKey(a.name) === nameKey(s.primaryText));
    if (match) {
      if (!ourIds.has(match.id)) {
        ourIds.add(match.id);
        ourList.push(match);
        seenNames.add(nameKey(match.name));
      }
    } else if (!seenNames.has(nameKey(s.primaryText))) {
      seenNames.add(nameKey(s.primaryText));
      googleList.push(s);
    }
  }
  return { suggestions: [...ourList.map((a) => ourAreaSuggestion(a, city)), ...googleList] };
};

// ── Details ───────────────────────────────────────────────────────────────────

/**
 * Resolves a picked suggestion. `kind` says what the host picked: a city, an area inside `cityId`,
 * or a full address (whose city and area come from its address components).
 */
const details = async ({ placeId, kind, sessionToken, cityId }) => {
  const pickedCity = kind === 'area' ? await findCityOr404(cityId) : null;

  // NEW-259: one of our own areas, offered by autocomplete; Google is not asked.
  if (String(placeId).startsWith(OUR_AREA_PREFIX)) {
    if (kind !== 'area') throw createError('We could not find that place. Please pick another one.', 404, 'place_not_found');
    const area = await assertAreaInCity({ cityId: pickedCity.id, areaId: String(placeId).slice(OUR_AREA_PREFIX.length) });
    if (!area) throw areaNotListed();
    return {
      placeId,
      formattedAddress: `${area.name}, ${pickedCity.name}`,
      latitude: null,
      longitude: null,
      city: shapeCity(pickedCity),
      area: shapeArea(area),
    };
  }
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  const place = await callGoogle(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}${qs}`, {
    method: 'GET',
    headers: placesHeaders(DETAILS_FIELDS),
  });

  const latitude = toNumber(place.location?.latitude);
  const longitude = toNumber(place.location?.longitude);
  const displayName = place.displayName?.text || null;
  const components = place.addressComponents || [];
  const countryCode = cleanCountryCode(pickComponent(components, ['country'], 'shortText'));
  let city = null;
  let area = null;

  if (kind === 'city') {
    city = await upsertCity({ name: displayName || pickComponent(components, CITY_TYPES), placeId: place.id || placeId, latitude, longitude, countryCode });
  } else if (kind === 'area') {
    city = pickedCity;
    // NEW-259: an area Google files under another city is refused, not added to this one.
    const placeCity = pickComponent(components, CITY_TYPES);
    if (placeCity && !sameCityName(placeCity, city.name)) {
      throw createError(`That area is not in ${city.name}. Pick an area in ${city.name}.`, 422, 'area_outside_city');
    }
    area = await upsertArea({ cityId: city.id, name: displayName || pickComponent(components, AREA_TYPES), placeId: place.id || placeId });
  } else {
    city = await upsertCity({ name: pickComponent(components, CITY_TYPES), countryCode });
    if (city) area = await upsertArea({ cityId: city.id, name: pickComponent(components, AREA_TYPES) });
  }

  return {
    placeId: place.id || placeId,
    formattedAddress: place.formattedAddress || displayName || null,
    latitude,
    longitude,
    city: shapeCity(city),
    area: shapeArea(area),
  };
};

// ── Reverse geocode ───────────────────────────────────────────────────────────

const legacyComponent = (components, types, field = 'long_name') => {
  for (const t of types) {
    const c = (components || []).find((x) => (x.types || []).includes(t));
    if (c && c[field]) return c[field];
  }
  return null;
};

/** "Use current location": the address at a point, with its city and area upserted. */
const reverseGeocode = async ({ latitude, longitude }) => {
  const params = new URLSearchParams({ latlng: `${latitude},${longitude}`, key: serverKey() });
  const res = await callGoogle(`${GEOCODE_URL}?${params.toString()}`, { method: 'GET' });
  const results = res.results || [];
  if (!results.length) throw createError('We could not find an address here. Please type it instead.', 404, 'place_not_found');

  const top = results[0];
  const components = top.address_components || [];
  const cityName = legacyComponent(components, CITY_TYPES);
  const areaName = legacyComponent(components, AREA_TYPES);
  const cityResult = results.find((r) => (r.types || []).includes('locality'));
  const areaResult = results.find((r) => AREA_TYPES.some((t) => (r.types || []).includes(t)));

  const city = await upsertCity({
    name: cityName,
    placeId: cityResult?.place_id || null,
    latitude: toNumber(cityResult?.geometry?.location?.lat),
    longitude: toNumber(cityResult?.geometry?.location?.lng),
    countryCode: cleanCountryCode(legacyComponent(components, ['country'], 'short_name')),
  });
  const area = city ? await upsertArea({ cityId: city.id, name: areaName, placeId: areaResult?.place_id || null }) : null;

  return {
    placeId: top.place_id || null,
    formattedAddress: top.formatted_address || null,
    // The point the person is standing on, not Google's street centre: that is where the pin goes.
    latitude: Number(latitude),
    longitude: Number(longitude),
    city: shapeCity(city),
    area: shapeArea(area),
  };
};

// ── Free-text area ────────────────────────────────────────────────────────────

/** When Google has no match: the area the host typed, once per city (any case, extra spaces ignored). */
const findOrCreateArea = async ({ cityId, name }) => {
  const city = await findCityOr404(cityId);
  const clean = normalizeName(name);
  if (!clean) throw createError('Please enter the area name.', 422, 'validation_error');
  const area = await upsertArea({ cityId: city.id, name: titleCase(clean) });
  return { id: area.id, cityId: area.cityId, name: area.name };
};

module.exports = {
  autocomplete,
  details,
  reverseGeocode,
  findOrCreateArea,
  assertAreaInCity,
  AREA_NOT_LISTED_MESSAGE,
  OUR_AREA_PREFIX,
  upsertCity,
  upsertArea,
  normalizeName,
};
