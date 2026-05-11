const { PlatformPackage } = require('../models/platform');
const { sendSuccess, createError } = require('../utils/response.utils');

// ── GET /platform-packages — list active packages ────────────────────────────
const listPackages = async (req, res, next) => {
  try {
    const includeInactive = req.user?.role === 'PLATFORM_ADMIN';
    const where = includeInactive ? {} : { status: 'ACTIVE' };

    const packages = await PlatformPackage.findAll({
      where,
      order: [['price', 'ASC']],
    });

    return sendSuccess(res, packages);
  } catch (err) {
    next(err);
  }
};

// ── GET /platform-packages/:id — get package detail ─────────────────────────
const getPackage = async (req, res, next) => {
  try {
    const pkg = await PlatformPackage.findByPk(req.params.id);
    if (!pkg) throw createError('Package not found', 404);

    return sendSuccess(res, pkg);
  } catch (err) {
    next(err);
  }
};

// ── POST /platform-packages — create package (admin) ────────────────────────
const createPackage = async (req, res, next) => {
  try {
    const { name, description, price, billingCycle, maxBranches, maxTrainers, maxMembers, featureFlagsJson } = req.body;

    const pkg = await PlatformPackage.create({
      name,
      description: description || null,
      price,
      billingCycle: billingCycle || 'MONTHLY',
      maxBranches: maxBranches || 1,
      maxTrainers: maxTrainers || 5,
      maxMembers: maxMembers || 200,
      featureFlagsJson: featureFlagsJson || null,
      status: 'ACTIVE',
    });

    return sendSuccess(res, pkg, 'Package created successfully', 201);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /platform-packages/:id — update package (admin) ───────────────────
const updatePackage = async (req, res, next) => {
  try {
    const pkg = await PlatformPackage.findByPk(req.params.id);
    if (!pkg) throw createError('Package not found', 404);

    const fields = ['name', 'description', 'price', 'billingCycle', 'maxBranches', 'maxTrainers', 'maxMembers', 'featureFlagsJson', 'status'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) pkg[f] = req.body[f];
    });
    await pkg.save();

    return sendSuccess(res, pkg, 'Package updated successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = { listPackages, getPackage, createPackage, updatePackage };
