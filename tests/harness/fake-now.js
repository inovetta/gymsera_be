/**
 * Date-bomb check (NEW-207). Loaded by jest.config.js `setupFiles`; does nothing unless
 * TEST_FAKE_NOW is set.
 *
 * With TEST_FAKE_NOW=2027-01-02T09:00:00Z every `new Date()` and `Date.now()` in the test process
 * (tests and app code alike) reads that moment plus the real time elapsed since the file loaded, so a
 * whole run behaves as if it started on that day. Timers, `performance.now()` and
 * `process.hrtime()` are not touched, so supertest, mysql2 and Jest timeouts behave normally.
 *
 * Node processes a test starts (the scripts under src/scripts, run with spawn) get the same clock:
 * the offset is kept in TEST_FAKE_NOW_OFFSET_MS and NODE_OPTIONS loads this file in each child.
 * Other programs (openssl) keep the real clock.
 *
 * Pair it with a MySQL whose clock is shifted the same way (libfaketime, see
 * docs/runbooks/test-date-bombs.md) so SQL NOW() / CURDATE() agree with Node.
 *
 *   TEST_FAKE_NOW=2027-01-02T09:00:00Z TEST_MYSQL_PORT=3309 npm test
 */
const target = process.env.TEST_FAKE_NOW;

if (target) {
  // Loaded twice (a test that reloads this file in a shifted run): measure against the real clock.
  const RealDate = Date.fakeNowRealDate || Date;
  const targetMs = RealDate.parse(target);
  if (Number.isNaN(targetMs)) {
    throw new Error(`[fake-now] TEST_FAKE_NOW is not a date: ${target}`);
  }
  // One offset for this process and every node process a test starts (scripts run with spawn):
  // NODE_OPTIONS makes each child load this file too, and the offset travels in the environment.
  let offset = Number(process.env.TEST_FAKE_NOW_OFFSET_MS);
  if (!Number.isFinite(offset)) {
    offset = targetMs - RealDate.now();
    process.env.TEST_FAKE_NOW_OFFSET_MS = String(offset);
  }
  const requireSelf = `--require ${__filename}`;
  if (!(process.env.NODE_OPTIONS || '').includes(requireSelf)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${requireSelf}`.trim();
  }

  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + offset);
      } else {
        super(...args);
      }
    }

    static now() {
      return RealDate.now() + offset;
    }

    // A date made by the real constructor is still a Date.
    static [Symbol.hasInstance](value) {
      return value instanceof RealDate;
    }
  }
  ShiftedDate.fakeNowRealDate = RealDate;

  // Date() called without `new` returns the current time as a string.
  const callable = new Proxy(ShiftedDate, {
    apply: () => new ShiftedDate().toString(),
  });

  global.Date = callable;
}
