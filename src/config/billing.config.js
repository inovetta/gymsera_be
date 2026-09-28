/**
 * Billing settings that are owner decisions (spec §14). One setting per value —
 * nothing else in the code may hold its own copy.
 */

/** Days a host has to pay after a "pay later" approval (R-17 = R-22, default 14). Read on every use. */
const payLaterGraceDays = () => {
  const raw = process.env.PAY_LATER_GRACE_DAYS;
  if (raw === undefined || raw === '') return 14;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`PAY_LATER_GRACE_DAYS must be a whole number of days (1 or more), got "${raw}"`);
  }
  return days;
};

module.exports = { payLaterGraceDays };
