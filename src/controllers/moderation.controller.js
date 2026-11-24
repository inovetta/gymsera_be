'use strict';
/** NEW-256: reports, blocks and the word list (App Store 1.2, Google Play UGC policy). */
const contentReports = require('../services/content-report.service');
const userBlocks = require('../services/user-block.service');
const moderationWords = require('../services/moderation-words.service');
const inboxService = require('../services/inbox.service');
const { sendSuccess, parsePagination } = require('../utils/response.utils');

const userIdOf = (req) => req.user.sub || req.user.id;

// ── POST /reports ─────────────────────────────────────────────────────────────
const createReport = async (req, res, next) => {
  try {
    const { targetType, targetId, reason, note } = req.body;
    const { report, created } = await contentReports.createReport({
      reporterUserId: userIdOf(req),
      reporterTenantId: req.user.organizationId || null,
      targetType,
      targetId,
      reason,
      note,
    });
    return sendSuccess(
      res,
      { report: { id: report.id, status: report.status, targetType: report.targetType, targetId: report.targetId } },
      created ? 'Thanks for your report. Our team will review it within 24 hours.' : 'You already reported this. Our team will review it.',
      created ? 201 : 200
    );
  } catch (err) {
    next(err);
  }
};

// ── Traveller: /me/inbox/:conversationId/block, /me/blocks ────────────────────
const travellerBlock = (blocked) => async (req, res, next) => {
  try {
    const block = await inboxService.setTravelerBlock(req.params.conversationId, userIdOf(req), blocked);
    return sendSuccess(res, { block }, blocked ? 'Blocked' : 'Unblocked');
  } catch (err) {
    next(err);
  }
};

const listMyBlocks = async (req, res, next) => {
  try {
    return sendSuccess(res, { blocks: await userBlocks.listForUser(userIdOf(req)) });
  } catch (err) {
    next(err);
  }
};

// ── Host: /host/inbox/inquiries/:inquiryId/block, /host/inbox/blocks ──────────
const hostBlock = (blocked) => async (req, res, next) => {
  try {
    const block = await inboxService.setHostBlock(req.params.inquiryId, req.user.organizationId, userIdOf(req), blocked);
    return sendSuccess(res, { block }, blocked ? 'Blocked' : 'Unblocked');
  } catch (err) {
    next(err);
  }
};

const listHostBlocks = async (req, res, next) => {
  try {
    const blocks = req.user.organizationId ? await userBlocks.listForTenant(req.user.organizationId) : [];
    return sendSuccess(res, { blocks });
  } catch (err) {
    next(err);
  }
};

// ── Admin: /admin/reports, /admin/moderation/words ────────────────────────────
const adminListReports = async (req, res, next) => {
  try {
    const { page, limit, offset } = parsePagination(req.query, 20, 100);
    const { status, targetType } = req.query;
    const result = await contentReports.adminList({ status, targetType, page, limit, offset });
    return sendSuccess(
      res,
      { reports: result.reports, counts: result.counts, responseHours: result.responseHours },
      'OK',
      200,
      result.pagination
    );
  } catch (err) {
    next(err);
  }
};

const adminGetReport = async (req, res, next) => {
  try {
    return sendSuccess(res, { report: await contentReports.adminGet(req.params.id) });
  } catch (err) {
    next(err);
  }
};

const adminActOnReport = async (req, res, next) => {
  try {
    const result = await contentReports.adminAct(req.params.id, req.body, userIdOf(req));
    return sendSuccess(res, result, 'Report updated');
  } catch (err) {
    next(err);
  }
};

const adminGetWords = async (req, res, next) => {
  try {
    return sendSuccess(res, { words: await moderationWords.getWords() });
  } catch (err) {
    next(err);
  }
};

const adminReplaceWords = async (req, res, next) => {
  try {
    return sendSuccess(res, { words: await moderationWords.replaceWords(req.body.words) }, 'Word list saved');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createReport,
  blockTraveller: travellerBlock(true),
  unblockTraveller: travellerBlock(false),
  listMyBlocks,
  blockFromHost: hostBlock(true),
  unblockFromHost: hostBlock(false),
  listHostBlocks,
  adminListReports,
  adminGetReport,
  adminActOnReport,
  adminGetWords,
  adminReplaceWords,
};
