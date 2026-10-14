const {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  minorDigits,
  formatMoney,
  moneyText,
} = require('../../src/utils/currency.utils');

describe('GLB-02: currency is a code per branch, formatted with ICU', () => {
  test.each([
    ['PKR', 2, 'PKR 1,234.50'],
    ['USD', 2, '$1,234.50'],
    ['EUR', 2, '€1,234.50'],
    ['AED', 2, 'AED 1,234.50'],
    ['JPY', 0, '¥1,235'],
    ['KWD', 3, 'KWD 1,234.500'],
  ])('%s has %i minor digits and formats as %s', (code, digits, text) => {
    expect(minorDigits(code)).toBe(digits);
    // ICU puts a no-break space between a currency code and the number.
    expect(formatMoney(1234.5, code).replace(/\u00a0/g, ' ')).toBe(text);
  });

  test('no 3-digit currency is allowed on a branch while money columns are DECIMAL(…,2)', () => {
    expect(SUPPORTED_CURRENCIES.filter((c) => minorDigits(c) > 2)).toEqual([]);
    expect(isSupportedCurrency('kwd')).toBe(false);
    expect(isSupportedCurrency('usd')).toBe(true);
    expect(isSupportedCurrency('XXX')).toBe(false);
  });

  test('plain text for notes keeps the code, defaults to PKR', () => {
    expect(moneyText('5000.00', 'usd')).toBe('USD 5000.00');
    expect(moneyText('5000.00')).toBe(`${DEFAULT_CURRENCY} 5000.00`);
  });
});
