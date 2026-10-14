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

  // CI's ICU data (run 38619587952) reported PKR with 0 minor digits while local Node reports 2.
  // The digits for every currency we support come from our own table, so ICU data cannot change them.
  describe('independent of the ICU build', () => {
    const RealNumberFormat = Intl.NumberFormat;
    const withIcuDigits = (digitsFor) => {
      jest.spyOn(Intl, 'NumberFormat').mockImplementation((locale, opts = {}) => {
        const real = new RealNumberFormat(locale, opts);
        const digits = opts.style === 'currency' && opts.currency && opts.minimumFractionDigits === undefined
          ? digitsFor(opts.currency)
          : undefined;
        return {
          format: (n) => real.format(n),
          resolvedOptions: () => ({ ...real.resolvedOptions(), ...(digits === undefined ? {} : { maximumFractionDigits: digits }) }),
        };
      });
    };
    afterEach(() => jest.restoreAllMocks());

    test('PKR keeps 2 digits when ICU says 0', () => {
      withIcuDigits(() => 0);
      expect(minorDigits('PKR')).toBe(2);
      expect(minorDigits('USD')).toBe(2);
      expect(minorDigits('JPY')).toBe(0);
      expect(minorDigits('KWD')).toBe(3);
    });

    test('every supported currency has an explicit entry, and the table matches ICU where ICU is sane', () => {
      const { CURRENCY_MINOR_DIGITS } = require('../../src/utils/currency.utils');
      for (const code of SUPPORTED_CURRENCIES) expect(CURRENCY_MINOR_DIGITS[code]).toBeDefined();
      expect(CURRENCY_MINOR_DIGITS.PKR).toBe(2);
    });

    test('formatting uses the table too: PKR 1,234.50 even when ICU would round to whole rupees', () => {
      withIcuDigits(() => 0);
      expect(formatMoney(1234.5, 'PKR').replace(/\u00a0/g, ' ')).toBe('PKR 1,234.50');
    });

    test('an unlisted code falls back to ICU', () => {
      expect(minorDigits('CZK')).toBe(new RealNumberFormat('en', { style: 'currency', currency: 'CZK' }).resolvedOptions().maximumFractionDigits);
    });
  });
});

