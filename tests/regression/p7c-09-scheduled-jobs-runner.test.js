/**
 * P7c item 9 (NEW-178; owner decision R-82).
 *
 * The daily 01:00 job (subscription expiry, store re-check, capacity, lock sweep) and the
 * every-minute billing inbox retry ran only as node-cron schedules inside the API process
 * (server.js). On the production host that process lives under iisnode, which starts it on
 * the first request and stops it with the IIS application pool (idle time-out, recycling),
 * so a quiet night skipped the 01:00 run.
 *
 * Now the same jobs run from a local CLI (src/scripts/run-scheduled-job.js) that Windows
 * Task Scheduler calls; it is not an HTTP route, so nothing outside the server can start
 * it. SCHEDULED_JOBS=external turns the in-process schedules off, so a job never runs twice.
 */
const fs = require('fs');
const path = require('path');

describe('P7c item 9: scheduled jobs can run outside the web process', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.SCHEDULED_JOBS;
  });

  test('"daily" runs the daily expiry job; "billing-inbox" retries the inbox, then the alert sweep', async () => {
    const cron = require('../../src/jobs/subscription-expiry.cron');
    const billingEvents = require('../../src/services/billing-event.service');
    const order = [];
    jest.spyOn(cron, 'runExpiryCheck').mockImplementation(async () => order.push('daily'));
    jest.spyOn(billingEvents, 'processPendingEvents').mockImplementation(async () => order.push('inbox'));
    jest.spyOn(billingEvents, 'sweepBillingAlerts').mockImplementation(async () => order.push('alerts'));
    const { runScheduledJob } = require('../../src/jobs/scheduled-jobs');

    await runScheduledJob('daily');
    await runScheduledJob('billing-inbox');
    expect(order).toEqual(['daily', 'inbox', 'alerts']);
    await expect(runScheduledJob('drop-everything')).rejects.toThrow(/Unknown scheduled job/);
  });

  test('SCHEDULED_JOBS=external turns the in-process schedules off; anything else keeps them', () => {
    const { inProcessSchedulesEnabled } = require('../../src/jobs/scheduled-jobs');
    expect(inProcessSchedulesEnabled()).toBe(true);
    process.env.SCHEDULED_JOBS = 'external';
    expect(inProcessSchedulesEnabled()).toBe(false);
    process.env.SCHEDULED_JOBS = 'in-process';
    expect(inProcessSchedulesEnabled()).toBe(true);
  });

  test('server.js schedules the daily job and the inbox retry only when in-process schedules are on', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
    const guard = src.indexOf('inProcessSchedulesEnabled()');
    expect(guard).toBeGreaterThan(-1);
    expect(src.indexOf('cron.schedule(EXPIRY_CRON')).toBeGreaterThan(guard);
    expect(src.indexOf("cron.schedule('* * * * *'")).toBeGreaterThan(guard);
  });

  test('the CLI exists, takes the job name and is documented in .env.example', () => {
    const cli = fs.readFileSync(path.join(__dirname, '../../src/scripts/run-scheduled-job.js'), 'utf8');
    expect(cli).toMatch(/runScheduledJob/);
    expect(cli).toMatch(/process\.argv\[2\]/);
    expect(fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8')).toMatch(/^SCHEDULED_JOBS=/m);
  });
});
