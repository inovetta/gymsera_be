const { City, Area } = require('../models/platform');
const { sendSuccess, createError, parsePagination, buildPagination } = require('../utils/response.utils');

// ── GET /cities — list all active cities ─────────────────────────────────────
const listCities = async (req, res, next) => {
  try {
    const includeInactive = req.user?.role === 'PLATFORM_ADMIN';

    const where = includeInactive ? {} : { isActive: true };

    const cities = await City.findAll({
      where,
      order: [['name', 'ASC']],
    });

    return sendSuccess(res, cities);
  } catch (err) {
    next(err);
  }
};

// ── GET /cities/:id/areas — list areas for a city ────────────────────────────
const listAreas = async (req, res, next) => {
  try {
    const city = await City.findByPk(req.params.id);
    if (!city) throw createError('City not found', 404);

    const areas = await Area.findAll({
      where: { cityId: city.id },
      order: [['name', 'ASC']],
    });

    return sendSuccess(res, { city, areas });
  } catch (err) {
    next(err);
  }
};

// ── POST /cities — create city (admin) ───────────────────────────────────────
const createCity = async (req, res, next) => {
  try {
    const { name, isActive } = req.body;
    const city = await City.create({ name, isActive: isActive !== undefined ? isActive : true });
    return sendSuccess(res, city, 'City created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /cities/:id — update city (admin) ──────────────────────────────────
const updateCity = async (req, res, next) => {
  try {
    const city = await City.findByPk(req.params.id);
    if (!city) throw createError('City not found', 404);

    const { name, isActive } = req.body;
    if (name !== undefined) city.name = name;
    if (isActive !== undefined) city.isActive = isActive;
    await city.save();

    return sendSuccess(res, city, 'City updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /cities/:id/areas — create area (admin) ─────────────────────────────
const createArea = async (req, res, next) => {
  try {
    const city = await City.findByPk(req.params.id);
    if (!city) throw createError('City not found', 404);

    const area = await Area.create({ cityId: city.id, name: req.body.name });
    return sendSuccess(res, area, 'Area created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /cities/:id/areas/:areaId — update area (admin) ────────────────────
const updateArea = async (req, res, next) => {
  try {
    const area = await Area.findOne({
      where: { id: req.params.areaId, cityId: req.params.id },
    });
    if (!area) throw createError('Area not found', 404);

    if (req.body.name !== undefined) area.name = req.body.name;
    await area.save();

    return sendSuccess(res, area, 'Area updated successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = { listCities, listAreas, createCity, updateCity, createArea, updateArea };
