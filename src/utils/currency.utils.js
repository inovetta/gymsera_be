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

/** Number of minor digits ICU uses for `code` (JPY 0, USD 2, KWD 3). */
const minorDigits = (code) => {
  const { maximumFractionDigits } = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: normalizeCurrency(code) || DEFAULT_CURRENCY,
  }).resolvedOptions();
  return maximumFractionDigits;
};

/** `amount` (major units, number or decimal string) as display text for `locale`. */
const formatMoney = (amount, currency = DEFAULT_CURRENCY, locale = 'en') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: normalizeCurrency(currency) }).format(Number(amount));

/** Stable plain text for notes and server messages: `PKR 5000.00` (clients format with ICU for display). */
const moneyText = (amount, currency = DEFAULT_CURRENCY) => `${normalizeCurrency(currency) || DEFAULT_CURRENCY} ${amount}`;

module.exports = {
  moneyText,
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  normalizeCurrency,
  isSupportedCurrency,
  minorDigits,
  formatMoney,
};
