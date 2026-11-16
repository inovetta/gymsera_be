'use strict';
/**
 * NEW-256: reports of user content (App Store 1.2, Google Play UGC policy).
 *
 *   POST /reports           anyone signed in reports a visible review, or a message in one of their
 *                           own conversations (traveller side or the gym's side).
 *   GET  /admin/reports     platform admins see the queue (CMS: Moderation › Reports); an open
 *                           report older than REPORT_RESPONSE_HOURS is overdue.
 *   PATCH /admin/reports/:id dismiss, hide the review, delete the message, or suspend the author.
 *
 * A reported review is hidden at once from the person who reported it (hiddenReviewIdsFor); other
 * people still see it until an admin hides it. The reported text is kept on the report, so it
 * survives a deletion.
 */
const { Op } = require('sequelize');
const { ContentReport, GymReview, Message, Conversation, User, PlatformAuditLog } = require('../models/platform');
const { createError, buildPagination } = require('../utils/response.utils');
const {
  ReportTargetType,
  ReportStatus,
  ReportAction,
  ACTIONS_BY_TARGET,
  REPORT_RESPONSE_HOURS,
} = require('../constants/moderation');

const HOUR_MS = 60 * 60 * 1000;
const MESSAGE_REMOVED = 'Message removed';

const _audit = (actorUserId, action, report, details = {}) =>
  PlatformAuditLog.create({
    actorUserId,
    action,
    targetType: 'CONTENT_REPORT',
    targetId: report.id,
    details: { targetType: report.targetType, targetId: report.targetId, ...details },
    createdAt: new Date(),
  }).catch((err) => console.warn('[content-report] audit log failed:', err.message));

/** What is being reported, checked against who reports it. */
const _resolveTarget = async ({ reporterUserId, reporterTenantId, targetType, targetId }) => {
  if (targetType === ReportTargetType.REVIEW) {
    const review = await GymReview.findByPk(targetId);
    // Only a review people can see can be reported.
    if (!review || review.status !== 'APPROVED') throw createError('Review not found', 404, 'not_found');
    if (review.userId === reporterUserId) throw createError('You cannot report your own review', 400, 'own_content');
    return {
      targetUserId: review.userId,
      tenantId: review.tenantId || null,
      conversationId: null,
      snapshotText: [review.title, review.body].filter(Boolean).join('\n') || null,
    };
  }

  const message = await Message.findByPk(targetId);
  if (!message) throw createError('Message not found', 404, 'not_found');
  const conversation = await Conversation.findByPk(message.conversationId);
  const isTraveller = conversation && conversation.userId === reporterUserId;
  const isGym = conversation && reporterTenantId && conversation.tenantId === reporterTenantId;
  // Not your conversation: answered like a message that does not exist.
  if (!isTraveller && !isGym) throw createError('Message not found', 404, 'not_found');
  if (message.senderId === reporterUserId) throw createError('You cannot report your own message', 400, 'own_content');
  if (message.senderType === 'SYSTEM') throw createError('This message cannot be reported', 400, 'not_reportable');

  // The author as a person: a traveller, or the staff member who wrote it. An opening message a
  // gym sent carries the tenant id, not a person; then there is no author to suspend.
  const author = message.senderId ? await User.findByPk(message.senderId, { attributes: ['id'] }) : null;
  return {
    targetUserId: author ? author.id : null,
    tenantId: conversation.tenantId || null,
    conversationId: conversation.id,
    snapshotText: message.text,
  };
};

/**
 * Creates the report, or returns the caller's existing report on the same content
 * (`created: false`): one report per person per item.
 */
const createReport = async ({ reporterUserId, reporterTenantId = null, targetType, targetId, reason, note = null }) => {
  const existing = await ContentReport.findOne({ where: { reporterUserId, targetType, targetId } });
  if (existing) return { report: existing, created: false };

  const target = await _resolveTarget({ reporterUserId, reporterTenantId, targetType, targetId });
  try {
    const report = await ContentReport.create({
      reporterUserId,
      targetType,
      targetId,
      reason,
      note: note && String(note).trim() ? String(note).trim().slice(0, 500) : null,
      status: ReportStatus.OPEN,
      ...target,
    });
    return { report, created: true };
  } catch (err) {
    if (err.name !== 'SequelizeUniqueConstraintError') throw err;
    const winner = await ContentReport.findOne({ where: { reporterUserId, targetType, targetId } });
    if (!winner) throw err;
    return { report: winner, created: false };
  }
};

/** Review ids this person reported: hidden from them at once. */
const hiddenReviewIdsFor = async (userId) => {
  if (!userId) return [];
  const rows = await ContentReport.findAll({
    where: { reporterUserId: userId, targetType: ReportTargetType.REVIEW },
    attributes: ['targetId'],
  });
  return rows.map((r) => r.targetId);
};

const _isOverdue = (report, now = Date.now()) =>
  report.status === ReportStatus.OPEN && now - new Date(report.createdAt).getTime() > REPORT_RESPONSE_HOURS * HOUR_MS;

const _present = (report, now = Date.now()) => {
  const json = typeof report.toJSON === 'function' ? report.toJSON() : { ...report };
  json.ageHours = Math.floor((now - new Date(report.createdAt).getTime()) / HOUR_MS);
  json.overdue = _isOverdue(report, now);
  json.allowedActions = report.status === ReportStatus.OPEN ? ACTIONS_BY_TARGET[report.targetType] || [] : [];
  return json;
};

const _people = [
  { model: User, as: 'reporter', attributes: ['id', 'fullName', 'email'] },
  { model: User, as: 'targetUser', attributes: ['id', 'fullName', 'email', 'status'] },
  { model: User, as: 'handledBy', attributes: ['id', 'fullName'] },
];

/** The CMS queue: newest first, OPEN by default, with the open and overdue counts. */
const adminList = async ({ status = ReportStatus.OPEN, targetType, page, limit, offset }) => {
  const where = {};
  if (status && status !== 'ALL') where.status = status;
  if (targetType) where.targetType = targetType;
  const { count, rows } = await ContentReport.findAndCountAll({
    where,
    include: _people,
    order: [['createdAt', status === ReportStatus.OPEN ? 'ASC' : 'DESC']],
    limit,
    offset,
    distinct: true,
  });
  const cutoff = new Date(Date.now() - REPORT_RESPONSE_HOURS * HOUR_MS);
  const [open, overdue] = await Promise.all([
    ContentReport.count({ where: { status: ReportStatus.OPEN } }),
    ContentReport.count({ where: { status: ReportStatus.OPEN, createdAt: { [Op.lt]: cutoff } } }),
  ]);
  const now = Date.now();
  return {
    reports: rows.map((r) => _present(r, now)),
    counts: { open, overdue },
    responseHours: REPORT_RESPONSE_HOURS,
    pagination: buildPagination(count, page, limit),
  };
};

/** One report, with the content as it is now (it may already be hidden or deleted). */
const adminGet = async (id) => {
  const report = await ContentReport.findByPk(id, { include: _people });
  if (!report) throw createError('Report not found', 404, 'not_found');
  const json = _present(report);
  if (report.targetType === ReportTargetType.REVIEW) {
    const review = await GymReview.findByPk(report.targetId);
    json.current = review
      ? { exists: true, status: review.status, rating: review.rating, title: review.title, body: review.body, branchId: review.branchId }
      : { exists: false };
  } else {
    const message = await Message.findByPk(report.targetId);
    json.current = message
      ? { exists: true, text: message.text, senderType: message.senderType, conversationId: message.conversationId, createdAt: message.createdAt }
      : { exists: false };
  }
  json.otherReports = await ContentReport.count({
    where: { targetType: report.targetType, targetId: report.targetId, id: { [Op.ne]: report.id } },
  });
  return json;
};

const _deleteMessage = async (messageId) => {
  const message = await Message.findByPk(messageId);
  if (!message) return { alreadyGone: true };
  const conversation = await Conversation.findByPk(message.conversationId);
  await message.destroy();
  if (conversation && conversation.lastMessageText === message.text) {
    await conversation.update({ lastMessageText: MESSAGE_REMOVED });
  }
  try {
    const socketGateway = require('../socket');
    socketGateway.emitToConversation(message.conversationId, 'message_deleted', {
      conversationId: message.conversationId,
      messageId: message.id,
    });
  } catch (_) {
    /* realtime is best effort; clients refetch */
  }
  return { alreadyGone: false };
};

/**
 * A platform admin acts on an OPEN report. The same outcome closes every other open report on the
 * same content, so one decision clears the item from the queue.
 */
const adminAct = async (id, { action, adminNote = null }, adminUserId) => {
  const report = await ContentReport.findByPk(id);
  if (!report) throw createError('Report not found', 404, 'not_found');
  if (report.status !== ReportStatus.OPEN) throw createError('This report is already closed', 409, 'report_closed');
  if (!(ACTIONS_BY_TARGET[report.targetType] || []).includes(action)) {
    throw createError(`${action} does not apply to a ${report.targetType.toLowerCase()} report`, 422, 'action_not_allowed');
  }

  const details = {};
  if (action === ReportAction.HIDE_REVIEW) {
    const discoveryService = require('./discovery.service');
    try {
      await discoveryService.moderateReview(report.targetId, { action: 'reject', adminNote: adminNote || 'Hidden after a report' });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
      details.alreadyGone = true;
    }
  } else if (action === ReportAction.DELETE_MESSAGE) {
    Object.assign(details, await _deleteMessage(report.targetId));
  } else if (action === ReportAction.SUSPEND_USER) {
    if (!report.targetUserId) throw createError('This content has no person to suspend', 422, 'no_author');
    const userService = require('./user.service');
    await userService.setStatus(report.targetUserId, 'SUSPENDED');
    details.suspendedUserId = report.targetUserId;
  }

  const outcome = {
    status: action === ReportAction.DISMISS ? ReportStatus.DISMISSED : ReportStatus.ACTIONED,
    action,
    adminNote: adminNote && String(adminNote).trim() ? String(adminNote).trim().slice(0, 500) : null,
    handledByUserId: adminUserId,
    handledAt: new Date(),
  };
  await report.update(outcome);
  const [closedOthers] = await ContentReport.update(outcome, {
    where: { targetType: report.targetType, targetId: report.targetId, status: ReportStatus.OPEN, id: { [Op.ne]: report.id } },
  });
  await _audit(adminUserId, `CONTENT_REPORT_${action}`, report, { ...details, closedOthers });
  return { report: await adminGet(report.id), closedOthers };
};

module.exports = {
  createReport,
  hiddenReviewIdsFor,
  adminList,
  adminGet,
  adminAct,
  MESSAGE_REMOVED,
};
