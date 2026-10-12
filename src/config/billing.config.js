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

/** Days of grace before locking over-quota branches (R-3, default 7). */
const overquotaGraceDays = () => {
  const raw = process.env.OVERQUOTA_GRACE_DAYS;
  if (raw === undefined || raw === '') return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`OVERQUOTA_GRACE_DAYS must be a whole number of days (1 or more), got "${raw}"`);
  }
  return days;
};

/** Days existing members can still check in after a branch is billing-locked (R-2, default 7). */
const memberCheckinGraceDays = () => {
  const raw = process.env.MEMBER_CHECKIN_GRACE_DAYS;
  if (raw === undefined || raw === '') return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`MEMBER_CHECKIN_GRACE_DAYS must be a whole number of days (1 or more), got "${raw}"`);
  }
  return days;
};

/**
 * Bank transfer instructions for SaaS platform payments / onboarding (UX-15).
 * Read strictly from environment variables so no account data is in git.
 */
const getBankTransferInstructions = (requestedCurrency) => {
  const currency = requestedCurrency || process.env.BANK_TRANSFER_CURRENCY || 'PKR';
  return {
    bankName: process.env.BANK_TRANSFER_BANK_NAME || null,
    accountTitle: process.env.BANK_TRANSFER_ACCOUNT_TITLE || null,
    accountNumber: process.env.BANK_TRANSFER_ACCOUNT_NUMBER || null,
    iban: process.env.BANK_TRANSFER_IBAN || null,
    swiftCode: process.env.BANK_TRANSFER_SWIFT || null,
    currency,
    instructions: process.env.BANK_TRANSFER_INSTRUCTIONS || null,
  };
};

module.exports = {
  payLaterGraceDays,
  overquotaGraceDays,
  memberCheckinGraceDays,
  getBankTransferInstructions,
  OVERQUOTA_GRACE_DAYS: 7,
  MEMBER_CHECKIN_GRACE_DAYS: 7,
};

