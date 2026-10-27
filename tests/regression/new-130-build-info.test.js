/**
 * NEW-130 — nothing showed which build the API process runs: `/health` always said
 * `version: '1.1.0'`, so a process still running a September build (NEW-127) looked like a fresh
 * deploy. Now `/health` and the boot line carry the commit, its build time and when the process
 * started. Sources, first found wins: GYMSERA_BUILD_COMMIT / GYMSERA_BUILD_TIME, a
 * `build-info.json` in the app folder, the app folder's own git checkout (the server deploys with
 * git pull; build time = commit time), else "unknown". Read once when the process starts, so a
 * later `git pull` without a restart still shows the commit actually loaded.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { readBuildInfo } = require('../../src/utils/build-info');

const ROOT = path.join(__dirname, '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gymsera-n130-'));

describe('readBuildInfo', () => {
  test('GYMSERA_BUILD_COMMIT / GYMSERA_BUILD_TIME win', () => {
    expect(readBuildInfo({ env: { GYMSERA_BUILD_COMMIT: 'abc1234', GYMSERA_BUILD_TIME: '2026-10-27T10:00:00Z' }, root: ROOT }))
      .toEqual({ commit: 'abc1234', builtAt: '2026-10-27T10:00:00Z', source: 'env' });
  });

  test('build-info.json in the app folder', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit: 'def5678', builtAt: '2026-10-26T09:00:00Z' }));
    expect(readBuildInfo({ env: {}, root: dir })).toEqual({ commit: 'def5678', builtAt: '2026-10-26T09:00:00Z', source: 'build-info.json' });
  });

  test('the app folder\'s own git checkout: HEAD commit and its commit time', () => {
    const dir = tmp();
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    git('add', 'a.txt');
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@gymsera.test', 'commit', '-q', '-m', 'a'], {
      env: { ...process.env, GIT_COMMITTER_DATE: '2026-09-26T13:54:03Z', GIT_AUTHOR_DATE: '2026-09-26T13:54:03Z' },
    });
    const head = git('rev-parse', 'HEAD');
    const info = readBuildInfo({ env: {}, root: dir });
    expect(info).toEqual({ commit: head, builtAt: expect.any(String), source: 'git' });
    expect(new Date(info.builtAt).toISOString()).toBe('2026-09-26T13:54:03.000Z');
  });

  test('a folder inside someone else\'s git repo does not borrow that repo\'s commit', () => {
    const dir = path.join(ROOT, 'node_modules', '.n130-not-a-checkout');
    fs.mkdirSync(dir, { recursive: true });
    try {
      expect(readBuildInfo({ env: {}, root: dir })).toEqual({ commit: 'unknown', builtAt: null, source: 'none' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nothing found: "unknown", never a guess', () => {
    expect(readBuildInfo({ env: {}, root: tmp() })).toEqual({ commit: 'unknown', builtAt: null, source: 'none' });
  });
});

describe('/health and the boot line', () => {
  const saved = {};
  beforeAll(() => {
    for (const k of ['GYMSERA_BUILD_COMMIT', 'GYMSERA_BUILD_TIME']) saved[k] = process.env[k];
    process.env.GYMSERA_BUILD_COMMIT = '0123456789abcdef0123456789abcdef01234567';
    process.env.GYMSERA_BUILD_TIME = '2026-10-27T11:00:00Z';
  });
  afterAll(async () => {
    await require('../harness/test-server').stopTestServer();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('GET /api/v1/health names the commit, its build time and when this process started', async () => {
    const { startTestServer } = require('../harness/test-server');
    const res = await request(await startTestServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.build).toEqual({
      commit: '0123456789abcdef0123456789abcdef01234567',
      builtAt: '2026-10-27T11:00:00Z',
      source: 'env',
    });
    expect(Date.parse(res.body.data.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(res.body.data.version).toBe('1.1.0');
  });

  test('the boot line (console and journal) names the commit, build time, start time and platform database', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      jest.isolateModules(() => require('../../src/utils/error-journal').boot());
      const line = log.mock.calls.map((c) => c.join(' ')).find((l) => l.startsWith('[ErrorJournal] boot'));
      expect(line).toMatch(/ commit=0123456789ab /);
      expect(line).toMatch(/ built=2026-10-27T11:00:00Z /);
      expect(line).toMatch(/ started=\d{4}-\d\d-\d\dT/);
      expect(line).toMatch(new RegExp(` platformDb=${process.env.PLATFORM_DB_NAME} `));
    } finally {
      log.mockRestore();
    }
  });
});
