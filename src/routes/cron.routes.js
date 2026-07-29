/**
 * cron.routes.js
 *
 * HTTP-triggered entry points for scheduled jobs that would otherwise rely on
 * an always-on process (node-cron in server.js, which never boots on Vercel's
 * serverless entrypoint — see api/index.js). Vercel Cron Jobs (configured in
 * vercel.json) hit these on a schedule; any other host can reach the same
 * endpoint from a plain system cron / curl, so behavior doesn't depend on
 * which platform is running the API.
 *
 * Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` when
 * invoking a scheduled path if the CRON_SECRET env var is set on the project.
 * An `x-cron-secret` header is also accepted so any external scheduler can
 * trigger these the same way.
 */
const { Router } = require('express');
const { runExpiryCheck } = require('../jobs/subscription-expiry.cron');

const router = Router();

const verifyCronSecret = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ success: false, message: 'CRON_SECRET is not configured on the server' });
  }

  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const provided = bearerToken || req.headers['x-cron-secret'];

  if (provided !== secret) {
    return res.status(401).json({ success: false, message: 'Invalid or missing cron secret' });
  }
  next();
};

// ── GET /cron/subscription-expiry ────────────────────────────────────────────
router.get('/subscription-expiry', verifyCronSecret, async (_req, res, next) => {
  try {
    await runExpiryCheck();
    return res.json({ success: true, message: 'Subscription expiry check completed' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
