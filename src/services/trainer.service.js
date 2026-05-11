const { createError, buildPagination } = require('../utils/response.utils');

// ── POST /trainers ─────────────────────────────────────────────────────────────
const createTrainer = async (tenantDb, data) => {
  const { Trainer, Branch } = tenantDb.models;

  // Validate branchId if provided
  if (data.branchId) {
    const branch = await Branch.findOne({ where: { id: data.branchId, status: 'ACTIVE' } });
    if (!branch) throw createError('Branch not found or inactive', 404);
  }

  // Prevent duplicate active trainer record for the same user
  const existing = await Trainer.findOne({ where: { userId: data.userId, status: 'ACTIVE' } });
  if (existing) throw createError('Trainer profile already exists for this user', 409);

  const trainer = await Trainer.create({
    userId:              data.userId,
    branchId:            data.branchId            || null,
    specialization:      data.specialization       || null,
    bio:                 data.bio                  || null,
    yearsExperience:     data.yearsExperience      ?? 0,
    certificationsJson:  data.certificationsJson   || null,
    availabilityJson:    data.availabilityJson      || null,
    status:              'ACTIVE',
  });

  return trainer;
};

// ── GET /trainers ──────────────────────────────────────────────────────────────
const listTrainers = async (tenantDb, { branchId, status, page, limit, offset }) => {
  const { Trainer } = tenantDb.models;
  const where = {};
  if (branchId) where.branchId = branchId;
  if (status)   where.status   = status;

  const { count, rows } = await Trainer.findAndCountAll({
    where,
    order:  [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return { trainers: rows, pagination: buildPagination(count, page, limit) };
};

// ── PATCH /trainers/:id ────────────────────────────────────────────────────────
const updateTrainer = async (tenantDb, trainerId, data) => {
  const { Trainer } = tenantDb.models;

  const trainer = await Trainer.findByPk(trainerId);
  if (!trainer) throw createError('Trainer not found', 404);

  const allowed = ['specialization', 'bio', 'yearsExperience',
    'certificationsJson', 'availabilityJson', 'status'];
  const patch = {};
  for (const key of allowed) {
    if (data[key] !== undefined) patch[key] = data[key];
  }

  await trainer.update(patch);
  return trainer.reload();
};

// ── POST /trainers/:id/assign ──────────────────────────────────────────────────
const assignTrainer = async (tenantDb, trainerId, branchId) => {
  const { Trainer, Branch } = tenantDb.models;

  const trainer = await Trainer.findByPk(trainerId);
  if (!trainer) throw createError('Trainer not found', 404);

  const branch = await Branch.findOne({ where: { id: branchId, status: 'ACTIVE' } });
  if (!branch) throw createError('Branch not found or inactive', 404);

  await trainer.update({ branchId });
  return trainer.reload();
};

module.exports = { createTrainer, listTrainers, updateTrainer, assignTrainer };
