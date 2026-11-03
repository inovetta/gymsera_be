/**
 * NEW-207: the date-bomb check harness (tests/harness/fake-now.js) shifts the clock only when
 * TEST_FAKE_NOW is set, and a shifted Date still behaves like a Date.
 */
const path = require('path');

const HARNESS = path.join(__dirname, '../harness/fake-now.js');

describe('NEW-207 fake-now harness', () => {
  const RealDate = global.Date;
  const saved = {
    TEST_FAKE_NOW: process.env.TEST_FAKE_NOW,
    TEST_FAKE_NOW_OFFSET_MS: process.env.TEST_FAKE_NOW_OFFSET_MS,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
  };

  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  afterEach(() => {
    global.Date = RealDate;
    restoreEnv();
  });

  const load = (value) => {
    global.Date = RealDate;
    restoreEnv();
    delete process.env.TEST_FAKE_NOW_OFFSET_MS;
    if (value === undefined) delete process.env.TEST_FAKE_NOW;
    else process.env.TEST_FAKE_NOW = value;
    jest.isolateModules(() => require(HARNESS));
  };

  it('leaves Date alone when TEST_FAKE_NOW is unset', () => {
    load(undefined);
    expect(global.Date).toBe(RealDate);
  });

  it('moves now() and new Date() to the given day, and keeps time running', () => {
    load('2027-01-02T09:00:00Z');
    const start = Date.now();
    expect(new Date().toISOString().slice(0, 10)).toBe('2027-01-02');
    expect(Math.abs(start - RealDate.parse('2027-01-02T09:00:00Z'))).toBeLessThan(5000);
    expect(Date.now()).toBeGreaterThanOrEqual(start);
  });

  it('keeps explicit dates, parse, UTC and instanceof working', () => {
    load('2027-01-02T09:00:00Z');
    expect(new Date('2026-03-04T00:00:00Z').toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(new Date(2026, 0, 5).getFullYear()).toBe(2026);
    expect(Date.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
    expect(Date.parse('2026-01-01T00:00:00Z')).toBe(RealDate.parse('2026-01-01T00:00:00Z'));
    expect(new Date() instanceof Date).toBe(true);
    expect(new RealDate() instanceof Date).toBe(true);
    expect(typeof Date()).toBe('string');
    expect(Date().startsWith('Sat Jan 02 2027')).toBe(true);
  });

  it('a node process started by a test (a script) sees the same day', () => {
    load('2027-01-02T09:00:00Z');
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(new Date().toISOString())'], {
      env: process.env,
      encoding: 'utf8',
    });
    expect(out.slice(0, 10)).toBe('2027-01-02');
  });

  it('refuses a value that is not a date', () => {
    expect(() => load('not-a-date')).toThrow('TEST_FAKE_NOW is not a date');
  });
});
