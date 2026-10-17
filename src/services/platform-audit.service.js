/**
 * Admin view of the platform audit trails (OBS-07, spec §12.12). Read-only.
 *
 *   source=actions   `platform_audit_logs`: what platform admins and system jobs did
 *                    (tenant approved, suspended, deletion finalized, KYC purge ...)
 *   source=requests  `audit_logs`: one row per mutating API request (who, which route, status)
 *
 * Both tables are append-only (models/append-only.js). Nothing here returns an IP address or a
 * user agent, and everything free-form (`details`, `path`) passes through the log redaction
 * (SEC-07): secrets removed, e-mails and phone numbers only as short hashes. Ids are returned as
 * ids; looking a person up is a separate, deliberate step.
 */
const { Op } = require('sequelize');
const { PlatformAuditLog, AuditLog } = require('../models/platform');
const { redact, redactString } = require('../utils/log-redaction');

const dateRange = ({ from, to }) => {
  if (!from && !to) return undefined;
  return { ...(from && { [Op.gte]: new Date(from) }), ...(to && { [Op.lte]: new Date(to) }) };
};

const listActions = async (f, { limit, offset }) => {
  const where = {};
  if (f.userId) where.actorUserId = f.userId;
  if (f.action) where.action = f.action;
  if (f.targetType) where.targetType = f.targetType;
  if (f.targetId) where.targetId = f.targetId;
  const range = dateRange(f);
  if (range) where.createdAt = range;
  const { rows, count } = await PlatformAuditLog.findAndCountAll({
    where,
    order: [['createdAt', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
  return {
    total: count,
    items: rows.map((r) => ({
      id: r.id,
      source: 'actions',
      actorUserId: r.actorUserId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      details: r.details == null ? null : redact(r.details),
      createdAt: r.createdAt,
    })),
  };
};

const listRequests = async (f, { limit, offset }) => {
  const where = {};
  if (f.userId) where.userId = f.userId;
  if (f.tenantId) where.tenantId = f.tenantId;
  if (f.method) where.method = f.method;
  const range = dateRange(f);
  if (range) where.createdAt = range;
  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    attributes: ['id', 'userId', 'tenantId', 'method', 'path', 'statusCode', 'durationMs', 'createdAt'], // no ip_address, no user_agent
    order: [['createdAt', 'DESC'], ['id', 'ASC']],
    limit,
    offset,
  });
  return {
    total: count,
    items: rows.map((r) => ({
      id: r.id,
      source: 'requests',
      userId: r.userId,
      tenantId: r.tenantId,
      method: r.method,
      path: redactString(r.path || ''),
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
    })),
  };
};

const list = (filters = {}, page) =>
  (filters.source === 'requests' ? listRequests : listActions)(filters, page);

module.exports = { list };
