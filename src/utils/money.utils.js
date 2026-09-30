/**
 * Money Utility (PAY-02, spec §6.3, §12)
 *
 * Core rule:
 * - NEVER use floating point math for monetary calculations.
 * - Always calculate in integer minor units (paisa / cents: 1 PKR = 100 paisas).
 * - Format back to 2 decimal places ('12.50') for database storage (DECIMAL) and display.
 */

/**
 * Convert an amount in major units (number or string decimal) to integer minor units.
 * Safely handles string parsing without binary floating-point drift.
 * Examples:
 *   toMinorUnits('10.50') => 1050
 *   toMinorUnits(19.99) => 1999
 *   toMinorUnits(100) => 10000
 *   toMinorUnits('-5.25') => -525
 *   toMinorUnits(null) => 0
 */
function toMinorUnits(amount, decimals = 2) {
  if (amount === null || amount === undefined || amount === '') return 0;

  const str = String(amount).trim();
  if (!str) return 0;

  const isNegative = str.startsWith('-');
  const cleanStr = isNegative ? str.slice(1) : str;

  const parts = cleanStr.split('.');
  const wholePart = parts[0] || '0';
  const fracPart = parts[1] || '';

  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const extraDigits = fracPart.slice(decimals);

  let minor = parseInt(wholePart, 10) * Math.pow(10, decimals) + parseInt(paddedFrac || '0', 10);
  if (isNaN(minor)) return 0;

  // Round half-up if there are extra fractional digits beyond specified decimals
  if (extraDigits && parseInt(extraDigits[0], 10) >= 5) {
    minor += 1;
  }

  return isNegative ? -minor : minor;
}

/**
 * Convert integer minor units back to a formatted string with 2 decimal places.
 * Examples:
 *   fromMinorUnits(1050) => '10.50'
 *   fromMinorUnits(-525) => '-5.25'
 *   fromMinorUnits(0) => '0.00'
 */
function fromMinorUnits(minorUnits, decimals = 2) {
  if (minorUnits === null || minorUnits === undefined || isNaN(minorUnits)) {
    return (0).toFixed(decimals);
  }
  const isNegative = minorUnits < 0;
  const abs = Math.abs(Math.round(minorUnits));
  const divisor = Math.pow(10, decimals);
  const whole = Math.floor(abs / divisor);
  const fraction = (abs % divisor).toString().padStart(decimals, '0');
  return `${isNegative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Convert integer minor units to a JavaScript number with 2 decimal places.
 * Only use for API payloads where JSON number is expected, never for arithmetic.
 */
function toMajorUnitsNumber(minorUnits, decimals = 2) {
  return Number(fromMinorUnits(minorUnits, decimals));
}

/**
 * Sum an array of amounts (in major units, strings or numbers) using integer minor units.
 * Returns formatted string representation.
 */
function sumMoney(amounts, decimals = 2) {
  if (!Array.isArray(amounts) || amounts.length === 0) return fromMinorUnits(0, decimals);
  const totalMinor = amounts.reduce((acc, amt) => acc + toMinorUnits(amt, decimals), 0);
  return fromMinorUnits(totalMinor, decimals);
}

/**
 * Sum an array of amounts (in major units) returning integer minor units.
 */
function sumMinor(amounts, decimals = 2) {
  if (!Array.isArray(amounts) || amounts.length === 0) return 0;
  return amounts.reduce((acc, amt) => acc + toMinorUnits(amt, decimals), 0);
}

/**
 * Add two amounts in major units using integer minor units.
 */
function addMoney(a, b, decimals = 2) {
  return fromMinorUnits(toMinorUnits(a, decimals) + toMinorUnits(b, decimals), decimals);
}

/**
 * Subtract b from a in major units using integer minor units.
 */
function subtractMoney(a, b, decimals = 2) {
  return fromMinorUnits(toMinorUnits(a, decimals) - toMinorUnits(b, decimals), decimals);
}

/**
 * Multiply an amount by a factor (e.g. quantity or tax rate) using integer minor units.
 */
function multiplyMoney(amount, factor, decimals = 2) {
  const minor = toMinorUnits(amount, decimals);
  const resultMinor = Math.round(minor * Number(factor || 0));
  return fromMinorUnits(resultMinor, decimals);
}

/**
 * Compare two amounts:
 * Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
function compareMoney(a, b, decimals = 2) {
  const minorA = toMinorUnits(a, decimals);
  const minorB = toMinorUnits(b, decimals);
  if (minorA < minorB) return -1;
  if (minorA > minorB) return 1;
  return 0;
}

/**
 * Minimum of two amounts.
 */
function minMoney(a, b, decimals = 2) {
  return compareMoney(a, b, decimals) <= 0
    ? fromMinorUnits(toMinorUnits(a, decimals), decimals)
    : fromMinorUnits(toMinorUnits(b, decimals), decimals);
}

/**
 * Maximum of two amounts.
 */
function maxMoney(a, b, decimals = 2) {
  return compareMoney(a, b, decimals) >= 0
    ? fromMinorUnits(toMinorUnits(a, decimals), decimals)
    : fromMinorUnits(toMinorUnits(b, decimals), decimals);
}

module.exports = {
  toMinorUnits,
  fromMinorUnits,
  toMajorUnitsNumber,
  sumMoney,
  sumMinor,
  addMoney,
  subtractMoney,
  multiplyMoney,
  compareMoney,
  minMoney,
  maxMoney,
};
