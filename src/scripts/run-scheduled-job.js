#!/usr/bin/env node
/**
 * Runs one scheduled job outside the web process (P7c item 9, NEW-178, R-82), for Windows
 * Task Scheduler on the IIS host (docs/runbooks/scheduled-jobs.md). A local command, not an
 * HTTP route: only someone on the server can start it. Set SCHEDULED_JOBS=external on the
 * API so the in-process schedules are off and nothing runs twice.
 *
 * Usage (from the API folder, with its .env):
 *   node src/scripts/run-scheduled-job.js daily           (01:00 every day)
 *   node src/scripts/run-scheduled-job.js billing-inbox   (every minute)
 * Exit code 0 = done, 1 = failed (Task Scheduler shows it as the last run result).
 */
require('dotenv').config();
const { connect, sequelize } = require('../database/platform');
const { runScheduledJob, JOB_NAMES } = require('../jobs/scheduled-jobs');

async function main() {
  const name = process.argv[2];
  if (!JOB_NAMES.includes(name)) {
    console.error(`Usage: node src/scripts/run-scheduled-job.js <${JOB_NAMES.join('|')}>`);
    process.exit(1);
  }
  require('../config/environment-guard').assertEnvironmentSafe();
  await connect();
  const started = Date.now();
  await runScheduledJob(name);
  console.log(`[ScheduledJob] ${name} finished in ${Date.now() - started} ms`);
  await sequelize.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error(`[ScheduledJob] ${process.argv[2]} failed:`, err.message);
  process.exit(1);
});
