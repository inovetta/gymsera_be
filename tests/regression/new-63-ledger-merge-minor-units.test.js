/**
 * NEW-63 (PAY-02 regression in a read path): the gym-wide ledger merge added money with JS floats. Totals were
 * rounded at the end, but the per-collector and per-shift cash figures were not, so three branches reporting
 * 0.10, 0.20 and 0.30 summed to 0.6000000000000001 on the wire. The merge now adds in integer minor units and
 * every amount it returns has at most two decimals and is the exact decimal sum.
 */
const { mergeBranchLedgers } = require('../../src/services/ledger.service');

const branch = (id, amounts) => ({
  branchId: id,
  branchName: `Branch ${id}`,
  businessDate: '2026-10-20',
  isMissed: false,
  totals: { expected: amounts, collected: amounts, verified: amounts, pending: 0, variance: 0 },
  byMethod: { CASH: amounts },
  byCollector: [
    {
      collectorId: 'c1',
      collectorName: 'Sana',
      total: amounts,
      cashCollected: amounts,
      cashExpected: amounts,
      count: 1,
      shifts: { MORNING: { shift: 'MORNING', total: amounts, cashCollected: amounts, cashExpected: amounts, count: 1 } },
    },
  ],
  perDay: [{ businessDate: '2026-10-20', status: 'CLOSED', expected: amounts, collected: amounts, verified: amounts }],
  payments: [],
});

const decimals = (n) => (String(n).split('.')[1] || '').length;

describe('mergeBranchLedgers adds in minor units', () => {
  const merged = mergeBranchLedgers([branch('a', 0.1), branch('b', 0.2), branch('c', 0.3)]);

  test('the classic: 0.1 + 0.2 + 0.3 is exactly 0.6 everywhere', () => {
    expect(merged.totals.collected).toBe(0.6);
    expect(merged.byMethod.CASH).toBe(0.6);
    const c = merged.byCollector[0];
    expect(c.total).toBe(0.6);
    expect(c.cashCollected).toBe(0.6);
    expect(c.cashExpected).toBe(0.6);
    expect(c.shifts.MORNING.total).toBe(0.6);
    expect(c.shifts.MORNING.cashCollected).toBe(0.6);
    expect(c.shifts.MORNING.cashExpected).toBe(0.6);
    expect(merged.perDay[0].collected).toBe(0.6);
  });

  test('no amount in the result has more than two decimals', () => {
    const all = [];
    const walk = (v) => {
      if (typeof v === 'number') all.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk({ t: merged.totals, m: merged.byMethod, c: merged.byCollector, p: merged.perDay });
    expect(all.filter((n) => decimals(n) > 2)).toEqual([]);
  });

  test('many small amounts still sum exactly (10 x 0.10 = 1.00, 7 x 1.15 = 8.05)', () => {
    const ten = mergeBranchLedgers(Array.from({ length: 10 }, (_, i) => branch(String(i), 0.1)));
    expect(ten.byCollector[0].cashCollected).toBe(1);
    const seven = mergeBranchLedgers(Array.from({ length: 7 }, (_, i) => branch(String(i), 1.15)));
    expect(seven.byCollector[0].cashCollected).toBe(8.05);
    expect(seven.totals.collected).toBe(8.05);
  });

  test('a collector or shift missing from some branches is still added correctly', () => {
    const a = branch('a', 0.1);
    const b = branch('b', 0.2);
    b.byCollector = [];
    const out = mergeBranchLedgers([a, b]);
    expect(out.byCollector).toHaveLength(1);
    expect(out.byCollector[0].cashCollected).toBe(0.1);
    expect(out.totals.collected).toBeCloseTo(0.3, 10);
    expect(decimals(out.totals.collected)).toBeLessThanOrEqual(2);
  });
});
