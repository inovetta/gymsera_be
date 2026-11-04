/**
 * NEW-207: a test may not give a membership, invoice or token a calendar end date that is still in
 * the future. It turns into the past on its own and the test fails on that day (FLOW-09 on
 * 2026-11-01, NEW-199; the 2026-12-31 memberships of NEW-48, NEW-49, API-07/08, NEW-06, SEC-17,
 * SEC-01 and the 2B group 3 check before P10b). Use daysFromToday() from tests/harness/dates.js.
 * A literal date in the past stays in the past, so it is allowed.
 */
const fs = require('fs');
const path = require('path');

const TESTS = path.join(__dirname, '..');
const FIELD = /\b(endDate|end_date|dueDate|due_date|expiresAt|expires_at|validUntil|valid_until|renewsAt|currentPeriodEnd)\s*:\s*(?:new Date\()?['"](\d{4}-\d{2}-\d{2})/g;

const testFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'fixtures' ? [] : testFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });

describe('NEW-207 no future calendar end dates in tests', () => {
  it('every literal end / due / expiry date in a test is already in the past', () => {
    const today = new Date().toISOString().slice(0, 10);
    const offenders = [];
    for (const f of testFiles(TESTS)) {
      if (f === __filename) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(FIELD)) {
        if (m[2] >= today) offenders.push(`${path.relative(TESTS, f)}: ${m[1]} '${m[2]}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
