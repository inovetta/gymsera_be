/**
 * Audit service — append-only record of consequential mutations.
 *
 * Distinct from middleware/auditLog.js, which logs HTTP traffic. This records
 * *domain* changes with before/after state: who changed whose access, who approved
 * what payment, who voided which invoice.
 *
 * Writes to the tenant database so a customer's trail lives inside their own data.
 * Every call is non-fatal: an audit failure must never fail the business operation
 * it is describing, but it is logged loudly so a broken trail is noticed.
 */

/**
 * Record one audited action.
 *
 * @param {object} ctx
 * @param {object} ctx.tenantDb
 * @param {string} [ctx.userId]      actor
 * @param {string} [ctx.roleKey]     actor's role at the time
 * @param {string} [ctx.branchId]
 * @param {object} [ctx.req]         used for IP and user agent
 * @param {object} entry
 * @param {string} entry.action      dotted verb: 'team.invite', 'approvals.decide'
 * @param {string} [entry.targetType]
 * @param {string} [entry.targetId]
 * @param {object} [entry.before]
 * @param {object} [entry.after]
 */
const record = async (ctx, entry) => {
  try {
    const { AuditLog } = ctx.tenantDb.models;
    if (!AuditLog) return null;

    const req = ctx.req;
    return await AuditLog.create({
      branchId: entry.branchId || ctx.branchId || null,
      actorUserId: ctx.userId || null,
      actorRoleKey: ctx.roleKey || null,
      action: entry.action,
      targetType: entry.targetType || null,
      targetId: entry.targetId ? String(entry.targetId) : null,
      beforeState: entry.before || null,
      afterState: entry.after || null,
      ip: req ? (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) : null,
      userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 255) : null,
    });
  } catch (err) {
    console.warn('[Audit] failed to record', entry.action, '-', err.message);
    return null;
  }
};

/**
 * Snapshot a Sequelize row for the before/after columns.
 *
 * Strips noise and anything that must never reach a log: password hashes,
 * connection strings, tokens.
 */
const snapshot = (instance, fields = null) => {
  if (!instance) return null;
  const plain = typeof instance.toJSON === 'function' ? instance.toJSON() : { ...instance };
  const SENSITIVE = ['passwordHash', 'password', 'connectionStringEncrypted', 'token', 'refreshToken'];
  for (const key of SENSITIVE) delete plain[key];
  if (!fields) return plain;
  return fields.reduce((acc, f) => {
    if (f in plain) acc[f] = plain[f];
    return acc;
  }, {});
};

/**
 * Paginated audit trail for the tenant.
 */
const list = async (tenantDb, { actor, action, branchId, from, to, limit = 50, offset = 0 } = {}) => {
  const { Op } = require('sequelize');
  const { AuditLog } = tenantDb.models;

  const where = {};
  if (actor) where.actorUserId = actor;
  if (action) where.action = { [Op.like]: `${action}%` };
  if (branchId) where.branchId = branchId;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt[Op.gte] = new Date(from);
    if (to) where.createdAt[Op.lte] = new Date(to);
  }

  return AuditLog.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });
};

module.exports = { record, snapshot, list };
