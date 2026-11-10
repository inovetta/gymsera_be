/**
 * The scheduled jobs, runnable from inside the API process (server.js, node-cron) or from
 * outside it (src/scripts/run-scheduled-job.js, called by Windows Task Scheduler) — P7c
 * item 9, NEW-178, R-82.
 *
 * On the production host the API runs under iisnode: IIS starts the Node process on the
 * first request and stops it with the application pool (idle time-out, recycling), so an
 * in-process 01:00 schedule does not run on a quiet night. With SCHEDULED_JOBS=external the
 * in-process schedules are off and Task Scheduler runs the CLI instead, so a job never runs
 * twice. Both paths take the same distributed locks (REL-03).
 */
const JOBS = {
  // Daily at 01:00: inbox retry, store re-check, expiry, capacity, branch locks, per-tenant pass.
  daily: () => require('./subscription-expiry.cron').runExpiryCheck(),
  // Every minute: retry billing webhook events that failed, then the billing alerts (BILL-12, OBS-05).
  'billing-inbox': async () => {
    const billingEvents = require('../services/billing-event.service');
    await billingEvents.processPendingEvents();
    await billingEvents.sweepBillingAlerts();
  },
  // ZKTeco access devices (docs/runbooks/devices.md, spec ZKTECO_PUSH_DEVICE_SYNC.md §8.3). Each under its own lock.
  'device-watchdog': () => deviceJob('device-watchdog', 55000, (j) => j.runWatchdog()), // every minute
  'device-sync': () => deviceJob('device-sync', 280000, (j) => j.runSync()), // every 5 minutes
  'device-audit': () => deviceJob('device-audit', 3500000, (j) => j.runAudit()), // hourly
  'device-retention': () => deviceJob('device-retention', 3500000, (j) => j.runRetention()), // daily
};

async function deviceJob(name, ttlMs, fn) {
  const { withDistributedLock } = require('../utils/distributed-lock');
  const res = await withDistributedLock(`cron:${name}`, ttlMs, () => fn(require('./device-jobs')));
  if (res && !res.skipped) console.log(`[ScheduledJob] ${name}: ${JSON.stringify(res.result || {})}`);
  return res;
}

const runScheduledJob = async (name) => {
  const job = JOBS[name];
  if (!job) throw new Error(`Unknown scheduled job "${name}". Use one of: ${Object.keys(JOBS).join(', ')}`);
  return job();
};

/** False when SCHEDULED_JOBS=external: Task Scheduler runs the jobs, server.js must not. */
const inProcessSchedulesEnabled = () => process.env.SCHEDULED_JOBS !== 'external';

module.exports = { runScheduledJob, inProcessSchedulesEnabled, JOB_NAMES: Object.keys(JOBS) };
