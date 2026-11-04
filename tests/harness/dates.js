/**
 * Dates relative to the day the test runs (NEW-207). A test that needs a membership or an invoice
 * that is current must not hard-code a calendar date: '2026-12-31' turns into the past on
 * 2027-01-01 (FLOW-09 failed this way on 2026-11-01, NEW-199).
 */

/** 'YYYY-MM-DD' (UTC) for today plus `n` days; negative is in the past. */
const daysFromToday = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

module.exports = { daysFromToday };
