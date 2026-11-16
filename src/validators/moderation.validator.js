'use strict';
/** NEW-256: report, block and word-list routes. */
const { body, param, query } = require('express-validator');
const { ReportTargetType, ReportReason, ReportStatus, ReportAction, WORD_LIST_LIMITS } = require('../constants/moderation');

const oneOf = (values) => (v) => values.includes(v);
const upper = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v);

module.exports = {
  createReport: [
    body('targetType').customSanitizer(upper).custom(oneOf(Object.values(ReportTargetType)))
      .withMessage(`targetType must be one of ${Object.values(ReportTargetType).join(', ')}`),
    body('targetId').isUUID().withMessage('targetId must be a UUID'),
    body('reason').customSanitizer(upper).custom(oneOf(Object.values(ReportReason)))
      .withMessage(`reason must be one of ${Object.values(ReportReason).join(', ')}`),
    body('note').optional({ nullable: true }).isString().isLength({ max: 500 }).withMessage('note is at most 500 characters'),
  ],

  travellerConversation: [param('conversationId').isUUID().withMessage('Invalid conversation ID')],

  hostConversation: [param('inquiryId').isUUID().withMessage('Invalid conversation ID')],

  adminList: [
    query('status').optional().customSanitizer(upper).custom(oneOf([...Object.values(ReportStatus), 'ALL']))
      .withMessage('status must be OPEN, ACTIONED, DISMISSED or ALL'),
    query('targetType').optional().customSanitizer(upper).custom(oneOf(Object.values(ReportTargetType)))
      .withMessage('targetType must be REVIEW or MESSAGE'),
  ],

  adminGet: [param('id').isUUID().withMessage('Invalid report ID')],

  adminAct: [
    param('id').isUUID().withMessage('Invalid report ID'),
    body('action').customSanitizer(upper).custom(oneOf(Object.values(ReportAction)))
      .withMessage(`action must be one of ${Object.values(ReportAction).join(', ')}`),
    body('adminNote').optional({ nullable: true }).isString().isLength({ max: 500 }),
  ],

  replaceWords: [
    body('words').isArray({ max: WORD_LIST_LIMITS.maxWords }).withMessage(`words must be a list of at most ${WORD_LIST_LIMITS.maxWords}`),
    body('words.*').isString().withMessage('each word must be text'),
  ],
};
