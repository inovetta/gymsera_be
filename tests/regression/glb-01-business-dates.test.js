const {
  addPlanDuration,
  addDays,
  monthStartOf,
  monthEndOf,
  startOfBusinessDay,
  businessDayRange,
} = require('../../src/utils/business-date.utils');
const { computeBusinessDate } = require('../../src/services/ledger.service');

describe('GLB-01: business dates are computed in the branch timezone, not the server timezone', () => {
  test('plan durations are calendar maths on the date string', () => {
    expect(addPlanDuration('2026-01-15', 'DAILY', 10)).toBe('2026-01-25');
    expect(addPlanDuration('2026-01-15', 'WEEKLY', 2)).toBe('2026-01-29');
    expect(addPlanDuration('2026-01-15', 'MONTHLY', 1)).toBe('2026-02-15');
    expect(addPlanDuration('2026-01-15', 'QUARTERLY', 1)).toBe('2026-04-15');
    expect(addPlanDuration('2026-01-15', 'YEARLY', 1)).toBe('2027-01-15');
    expect(addPlanDuration('2026-01-15', 'UNKNOWN', 5)).toBe('2026-02-15');
    // Across a US DST change (2026-03-08): still exactly one calendar day.
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
  });

  test('month bounds', () => {
    expect(monthStartOf('2026-02-17')).toBe('2026-02-01');
    expect(monthEndOf('2026-02-17')).toBe('2026-02-28');
    expect(monthEndOf('2028-02-01')).toBe('2028-02-29');
    expect(monthEndOf('2026-12-31')).toBe('2026-12-31');
  });

  test('the same instant is a different business date in different branches', () => {
    const instant = new Date('2026-06-30T20:30:00Z');
    expect(computeBusinessDate(instant, 'Asia/Karachi')).toBe('2026-07-01'); // UTC+5
    expect(computeBusinessDate(instant, 'America/New_York')).toBe('2026-06-30'); // UTC-4
    expect(computeBusinessDate(instant, 'Pacific/Kiritimati')).toBe('2026-07-01'); // UTC+14
  });

  test('start of a business day, whole-hour and half-hour zones', () => {
    expect(startOfBusinessDay('2026-07-01', 'Asia/Karachi').toISOString()).toBe('2026-06-30T19:00:00.000Z');
    expect(startOfBusinessDay('2026-07-01', 'Asia/Kolkata').toISOString()).toBe('2026-06-30T18:30:00.000Z');
    expect(startOfBusinessDay('2026-07-01', 'UTC').toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(startOfBusinessDay('2026-07-01', 'America/New_York').toISOString()).toBe('2026-07-01T04:00:00.000Z');
  });

  test('a branch in America/New_York has a 23 h day on spring-forward and a 25 h day on fall-back', () => {
    const hours = (d) => {
      const { start, end } = businessDayRange(d, 'America/New_York');
      return (end - start) / 3600000;
    };
    expect(hours('2026-03-07')).toBe(24);
    expect(hours('2026-03-08')).toBe(23);
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-11-02')).toBe(24);
  });

  test('a check-in at 23:30 New York time belongs to that day even though UTC is already tomorrow', () => {
    const checkIn = new Date('2026-07-02T03:30:00Z'); // 23:30 on 2026-07-01 in New York
    const { start, end } = businessDayRange('2026-07-01', 'America/New_York');
    expect(checkIn >= start && checkIn < end).toBe(true);
    const next = businessDayRange('2026-07-02', 'America/New_York');
    expect(checkIn >= next.start).toBe(false);
  });
});
