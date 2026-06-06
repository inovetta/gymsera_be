/**
 * iclock.routes.js
 *
 * ZKTeco ADMS (Attendance Data Management System) protocol handler.
 * Mounted at /iclock in app.js (outside /api/v1).
 *
 * ZKTeco devices are configured to push to:
 *   Server: https://your-api-domain.com
 *   Path:   /iclock
 *   Port:   80 or 443
 *
 * The device serial number (SN query param) is used to authenticate —
 * only registered devices (in the `devices` table) are accepted.
 *
 * IMPORTANT: These routes use express.text() body parser because ZKTeco
 * sends ATTLOG data as plain text, not JSON.
 */

const { Router } = require('express');
const iclockService = require('../services/iclock.service');

const router = Router();

// ZKTeco ADMS sends plain-text bodies — parse them as text
router.use(require('express').text({ type: '*/*', limit: '1mb' }));

// ── Heartbeat / Command Poll ──────────────────────────────────────────────────
// ZKTeco sends this on boot and every ~30 seconds.
// We respond "OK" if the device is registered, 403 if not.
router.get('/getrequest', async (req, res) => {
  const sn = req.query.SN || req.query.sn;
  if (!sn) return res.status(400).send('ERROR: Missing SN');

  try {
    const device = await iclockService.handleHeartbeat(sn);
    if (!device) {
      console.warn(`[iClock] Unregistered device heartbeat: SN=${sn}`);
      return res.status(403).send('ERROR: Device not registered');
    }
    console.log(`[iClock] Heartbeat: SN=${sn} name="${device.name}"`);
    // Respond with OK — no pending commands
    res.set('Content-Type', 'text/plain').send('OK');
  } catch (err) {
    console.error('[iClock] Heartbeat error:', err.message);
    res.status(500).send('ERROR: Server error');
  }
});

// ── Data Upload (ATTLOG + others) ─────────────────────────────────────────────
// ZKTeco posts attendance records here. Table=ATTLOG is the one we care about.
// Other tables (OPERLOG, BIODATA, etc.) are acknowledged but ignored.
router.post('/cdata', async (req, res) => {
  const sn = req.query.SN || req.query.sn;
  const table = req.query.table || req.query.Table;

  if (!sn) return res.status(400).send('ERROR: Missing SN');

  // Acknowledge non-attendance tables immediately
  if (!table || table.toUpperCase() !== 'ATTLOG') {
    return res.set('Content-Type', 'text/plain').send('OK: 0\n');
  }

  try {
    const result = await iclockService.handleAttlog(sn, req.body);
    if (result === null) {
      console.warn(`[iClock] ATTLOG from unregistered device: SN=${sn}`);
      return res.status(403).send('ERROR: Device not registered');
    }
    console.log(`[iClock] ATTLOG SN=${sn}: accepted=${result.accepted} skipped=${result.skipped}`);
    // ZKTeco expects "OK: {count}\n" where count = number of records accepted
    res.set('Content-Type', 'text/plain').send(`OK: ${result.accepted}\n`);
  } catch (err) {
    console.error('[iClock] ATTLOG error:', err.message);
    res.status(500).send('ERROR: Server error');
  }
});

// ── Data Download / Sync Request ──────────────────────────────────────────────
// ZKTeco sends GET /iclock/cdata?table=ATTLOG&Stamp=9999999999 on initial sync
// or to check how many records the server wants. We always respond "OK: 0\n"
// because we don't need the device to resend historical data on our command.
router.get('/cdata', (req, res) => {
  res.set('Content-Type', 'text/plain').send('OK: 0\n');
});

// ── Device Info / Registration ─────────────────────────────────────────────────
// Some ZKTeco firmware sends device info via POST to /iclock/devicecmd
// We acknowledge it silently.
router.post('/devicecmd', (req, res) => {
  res.set('Content-Type', 'text/plain').send('OK');
});

// Catch-all for any other ADMS sub-paths
router.all('*', (req, res) => {
  res.set('Content-Type', 'text/plain').send('OK');
});

module.exports = router;
