'use strict';
/**
 * NEW-256: POST /reports — anyone signed in reports a review or a chat message (App Store 1.2,
 * Google Play UGC policy). Mounted at /reports next to the financial reports router, which only
 * has GET routes; this router has only this POST.
 */
const { Router } = require('express');
const authenticate = require('../middleware/authenticate');
const validate = require('../middleware/validate');
const v = require('../validators/moderation.validator');
const controller = require('../controllers/moderation.controller');

const router = Router();

/**
 * @swagger
 * /reports:
 *   post:
 *     summary: Report a review or a chat message
 *     description: One report per person per item (a repeat answers 200 with the same report). A reported review is hidden from the reporter at once. Platform admins review reports within 24 hours.
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetType, targetId, reason]
 *             properties:
 *               targetType: { type: string, enum: [REVIEW, MESSAGE] }
 *               targetId: { type: string, format: uuid }
 *               reason: { type: string, enum: [SPAM, HARASSMENT, HATE, SEXUAL, VIOLENCE, FALSE_INFO, OTHER] }
 *               note: { type: string, maxLength: 500 }
 *     responses:
 *       201: { description: Report created }
 *       200: { description: Already reported by this person }
 *       404: { description: Not found, or not a conversation of the caller }
 */
router.post('/', authenticate, validate.strict(v.createReport), controller.createReport);

module.exports = router;
