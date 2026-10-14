/**
 * Currency helpers (GLB-02, spec §6.3).
 *
 * A branch has one currency (ISO 4217, upper-case); every payment, invoice and payout created in that branch
 * carries it. Display formatting is ICU (`Intl.NumberFormat`), never string concatenation.
 *
 * Storage limit: money columns are DECIMAL(…,2). A currency with 3 minor digits (KWD, BHD, OMR, JOD, TND) would be
 * silently rounded, so a branch cannot be set to one until the columns are widened (spec §13 GLB-02 notes).
 */

const DEFAULT_CURRENCY = 'PKR';

// Currencies a branch may use. Subset of ISO 4217 with at most 2 minor digits; extend deliberately.
const SUPPORTED_CURRENCIES = Object.freeze([
  'PKR', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'QAR', 'INR', 'BDT', 'LKR', 'NPR', 'AUD', 'CAD', 'NZD', 'SGD', 'MYR',
  'IDR', 'THB', 'TRY', 'EGP', 'ZAR', 'NGN', 'KES', 'JPY', 'KRW', 'CHF', 'SEK', 'NOK', 'DKK',
]);

const normalizeCurrency = (code) => String(code || '').trim().toUpperCase();

const isSupportedCurrency = (code) => SUPPORTED_CURRENCIES.includes(normalizeCurrency(code));

/**
 * Minor digits per ISO 4217. The source of truth for every currency we handle: ICU builds disagree (CI's data
 * reported PKR with 0 digits, local Node with 2), and a wrong number here silently shifts every price by 100x.
 * Includes the zero-decimal currencies Stripe counts in whole units.
 */
const CURRENCY_MINOR_DIGITS = Object.freeze({
  PKR: 2, USD: 2, EUR: 2, GBP: 2, AED: 2, SAR: 2, QAR: 2, INR: 2, BDT: 2, LKR: 2, NPR: 2, AUD: 2, CAD: 2,
  NZD: 2, SGD: 2, MYR: 2, IDR: 2, THB: 2, TRY: 2, EGP: 2, ZAR: 2, NGN: 2, KES: 2, CHF: 2, SEK: 2, NOK: 2, DKK: 2,
  JPY: 0, KRW: 0, BIF: 0, CLP: 0, DJF: 0, GNF: 0, KMF: 0, MGA: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0,
  XAF: 0, XOF: 0, XPF: 0,
  KWD: 3, BHD: 3, OMR: 3, JOD: 3, TND: 3,
});

/** Number of minor digits for `code`: our table, and only for an unlisted code what ICU says. */
const minorDigits = (code) => {
  const normalized = normalizeCurrency(code) || DEFAULT_CURRENCY;
  if (Object.prototype.hasOwnProperty.call(CURRENCY_MINOR_DIGITS, normalized)) return CURRENCY_MINOR_DIGITS[normalized];
  return new Intl.NumberFormat('en', { style: 'currency', currency: normalized }).resolvedOptions().maximumFractionDigits;
};

/** `amount` (major units, number or decimal string) as display text for `locale`, with our digits. */
const formatMoney = (amount, currency = DEFAULT_CURRENCY, locale = 'en') => {
  const code = normalizeCurrency(currency);
  const digits = minorDigits(code);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(amount));
};

/** Stable plain text for notes and server messages: `PKR 5000.00` (clients format with ICU for display). */
const moneyText = (amount, currency = DEFAULT_CURRENCY) => `${normalizeCurrency(currency) || DEFAULT_CURRENCY} ${amount}`;

module.exports = {
  CURRENCY_MINOR_DIGITS,
  moneyText,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  normalizeCurrency,
  isSupportedCurrency,
  minorDigits,
  formatMoney,
};
