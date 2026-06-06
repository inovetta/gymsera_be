const { City, Area } = require('../models/platform');
const { sendSuccess, createError, parsePagination, buildPagination } = require('../utils/response.utils');
const storageService = require('../services/storage.service');

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
    const { name, isActive, imageUrl } = req.body;
    const city = await City.create({ name, isActive: isActive !== undefined ? isActive : true, imageUrl: imageUrl || null });
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

    const { name, isActive, imageUrl } = req.body;
    if (name !== undefined) city.name = name;
    if (isActive !== undefined) city.isActive = isActive;
    if (imageUrl !== undefined) city.imageUrl = imageUrl || null;
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

    const area = await Area.create({ cityId: city.id, name: req.body.name, imageUrl: req.body.imageUrl || null });
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
    if (req.body.imageUrl !== undefined) area.imageUrl = req.body.imageUrl || null;
    await area.save();

    return sendSuccess(res, area, 'Area updated successfully');
  } catch (err) {
    next(err);
  }
};

// ── POST /cities/:id/image ────────────────────────────────────────────────────
const uploadCityImage = async (req, res, next) => {
  try {
    if (!req.file) throw createError('Image file is required', 422);
    const city = await City.findByPk(req.params.id);
    if (!city) throw createError('City not found', 404);

    if (city.imageUrl) await storageService.deleteImage(city.imageUrl).catch(() => {});
    const imageUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'cities', `city-${city.id}`);
    await city.update({ imageUrl });
    return sendSuccess(res, { imageUrl }, 'City image uploaded');
  } catch (err) {
    next(err);
  }
};

// ── POST /cities/:id/areas/:areaId/image ──────────────────────────────────────
const uploadAreaImage = async (req, res, next) => {
  try {
    if (!req.file) throw createError('Image file is required', 422);
    const area = await Area.findOne({ where: { id: req.params.areaId, cityId: req.params.id } });
    if (!area) throw createError('Area not found', 404);

    if (area.imageUrl) await storageService.deleteImage(area.imageUrl).catch(() => {});
    const imageUrl = await storageService.uploadImage(req.file.buffer, req.file.mimetype, 'areas', `area-${area.id}`);
    await area.update({ imageUrl });
    return sendSuccess(res, { imageUrl }, 'Area image uploaded');
  } catch (err) {
    next(err);
  }
};

// ── DELETE /cities/:id ────────────────────────────────────────────────────────
const deleteCity = async (req, res, next) => {
  try {
    const city = await City.findByPk(req.params.id);
    if (!city) throw createError('City not found', 404);
    const areaCount = await Area.count({ where: { cityId: city.id } });
    if (areaCount > 0) throw createError(`Cannot delete city with ${areaCount} area(s). Remove all areas first.`, 409);
    if (city.imageUrl) await storageService.deleteImage(city.imageUrl).catch(() => {});
    await city.destroy();
    return sendSuccess(res, null, 'City deleted');
  } catch (err) { next(err); }
};

// ── DELETE /cities/:id/areas/:areaId ─────────────────────────────────────────
const deleteArea = async (req, res, next) => {
  try {
    const area = await Area.findOne({ where: { id: req.params.areaId, cityId: req.params.id } });
    if (!area) throw createError('Area not found', 404);
    if (area.imageUrl) await storageService.deleteImage(area.imageUrl).catch(() => {});
    await area.destroy();
    return sendSuccess(res, null, 'Area deleted');
  } catch (err) { next(err); }
};

module.exports = { listCities, listAreas, createCity, updateCity, createArea, updateArea, uploadCityImage, uploadAreaImage, deleteCity, deleteArea };
