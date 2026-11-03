/**
 * Phase 7 P10 item 4 (R-88): run-scheduled-job.js on the server printed Redis connection warnings
 * and then disabled the cache. Production runs without Redis (R-88: DISABLE_REDIS=true, one API
 * instance); the jobs then take MySQL GET_LOCK locks (distributed-lock.js) and nothing is lost.
 *
 * - DISABLE_REDIS=true, or no REDIS_HOST / REDIS_URL: the script prints no [Redis] line at all.
 * - REDIS_HOST set but nothing listening: one line that says Redis is off for this run, not a
 *   warning per reconnect attempt plus "Connection ended".
 * The job itself still runs and exits 0.
 */
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');
const { setupTestDatabases, teardownTestDatabases } = require('../harness');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'src', 'scripts', 'run-scheduled-job.js');

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const run = (job, overrides) => {
  // Empty, not deleted: the script loads the folder's .env (dotenv), which never overrides a set variable.
  const env = { ...process.env, REDIS_HOST: '', REDIS_URL: '', REDIS_PORT: '', REDIS_PASSWORD: '', DISABLE_REDIS: '' };
  // The harness's test-only default (NODE_ENV=test means 127.0.0.1) is not what a server has.
  env.NODE_ENV = 'development';
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [SCRIPT, job], { cwd: ROOT, encoding: 'utf8', env, timeout: 60000 });
};
const redisLines = (res) => `${res.stdout}\n${res.stderr}`.split('\n').filter((l) => l.includes('[Redis'));

describe('P10 item 4: run-scheduled-job is quiet about Redis when Redis is not used', () => {
  beforeAll(async () => {
    await setupTestDatabases();
  });
  afterAll(async () => {
    await teardownTestDatabases();
  });

  test.each([
    ['DISABLE_REDIS=true (R-88)', { DISABLE_REDIS: 'true', REDIS_HOST: 'localhost' }],
    ['no REDIS_HOST or REDIS_URL', {}],
  ])('%s: the job runs, exit 0, no [Redis] line', (_label, env) => {
    for (const job of ['billing-inbox', 'daily']) {
      const res = run(job, env);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(new RegExp(`\\[ScheduledJob\\] ${job} finished`));
      expect(redisLines(res)).toEqual([]);
    }
  });

  test('REDIS_HOST set but nothing listening: one line, then the job runs without Redis', async () => {
    const port = await freePort();
    const res = run('daily', { REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port) });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[ScheduledJob\] daily finished/);
    const lines = redisLines(res);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/not reachable/);
    expect(lines[0]).toMatch(/DISABLE_REDIS=true/);
  });
});
