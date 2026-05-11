const trainerService = require('../services/trainer.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

// ── POST /trainers ─────────────────────────────────────────────────────────────
const createTrainer = async (req, res, next) => {
  try {
    const trainer = await trainerService.createTrainer(req.tenantDb, req.body);
    return sendSuccess(res, { trainer }, 'Trainer profile created', 201);
  } catch (err) {
    next(err);
  }
};

// ── GET /trainers ──────────────────────────────────────────────────────────────
const listTrainers = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { branchId, status } = req.query;

    const result = await trainerService.listTrainers(req.tenantDb, {
      branchId: branchId || null,
      status:   status   || null,
      page,
      limit,
      offset,
    });

    return sendSuccess(res, { trainers: result.trainers }, 'OK', 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

// ── PATCH /trainers/:id ────────────────────────────────────────────────────────
const updateTrainer = async (req, res, next) => {
  try {
    const trainer = await trainerService.updateTrainer(req.tenantDb, req.params.id, req.body);
    return sendSuccess(res, { trainer }, 'Trainer updated');
  } catch (err) {
    next(err);
  }
};

// ── POST /trainers/:id/assign ──────────────────────────────────────────────────
const assignTrainer = async (req, res, next) => {
  try {
    const trainer = await trainerService.assignTrainer(
      req.tenantDb,
      req.params.id,
      req.body.branchId
    );
    return sendSuccess(res, { trainer }, 'Trainer assigned to branch');
  } catch (err) {
    next(err);
  }
};

module.exports = { createTrainer, listTrainers, updateTrainer, assignTrainer };
