const {
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
} = require('../../src/utils/money.utils');

describe('PAY-02: Money is never a float — Minor Units Integer Arithmetic (spec §6.3, §12)', () => {
  describe('Unit Conversions', () => {
    test('toMinorUnits accurately parses strings, numbers, decimals, and edge cases', () => {
      expect(toMinorUnits('10.50')).toBe(1050);
      expect(toMinorUnits('0.01')).toBe(1);
      expect(toMinorUnits('0.1')).toBe(10);
      expect(toMinorUnits('100')).toBe(10000);
      expect(toMinorUnits(19.99)).toBe(1999);
      expect(toMinorUnits(0)).toBe(0);
      expect(toMinorUnits(null)).toBe(0);
      expect(toMinorUnits(undefined)).toBe(0);
      expect(toMinorUnits('')).toBe(0);
      expect(toMinorUnits('-5.25')).toBe(-525);
    });

    test('fromMinorUnits formats integers into exact two-decimal strings', () => {
      expect(fromMinorUnits(1050)).toBe('10.50');
      expect(fromMinorUnits(1)).toBe('0.01');
      expect(fromMinorUnits(0)).toBe('0.00');
      expect(fromMinorUnits(-525)).toBe('-5.25');
      expect(fromMinorUnits(-1)).toBe('-0.01');
      expect(fromMinorUnits(10000)).toBe('100.00');
    });

    test('toMajorUnitsNumber returns clean numbers without scientific notation or NaN', () => {
      expect(toMajorUnitsNumber(1050)).toBe(10.5);
      expect(toMajorUnitsNumber(1)).toBe(0.01);
      expect(toMajorUnitsNumber(0)).toBe(0);
    });
  });

  describe('Elimination of Classic IEEE-754 Float Precision Bugs', () => {
    test('0.10 + 0.20 strictly equals 0.30 (not 0.30000000000000004)', () => {
      // Classic JS float bug: 0.1 + 0.2 !== 0.3
      const jsFloat = 0.1 + 0.2;
      expect(jsFloat).not.toBe(0.3);

      // Antigravity minor-units exact integer arithmetic:
      const result = addMoney('0.10', '0.20');
      expect(result).toBe('0.30');
    });

    test('100.20 - 100.10 strictly equals 0.10 (not 0.09999999999999432)', () => {
      const jsFloat = 100.2 - 100.1;
      expect(jsFloat).not.toBe(0.1);

      const result = subtractMoney('100.20', '100.10');
      expect(result).toBe('0.10');
    });

    test('Multiplication retains exact integer rounding without float drift', () => {
      expect(multiplyMoney('10.25', 3)).toBe('30.75');
      expect(multiplyMoney('33.33', 3)).toBe('99.99');
    });

    test('Comparisons are strictly exact', () => {
      expect(compareMoney('10.50', '10.50')).toBe(0);
      expect(compareMoney('10.51', '10.50')).toBe(1);
      expect(compareMoney('10.49', '10.50')).toBe(-1);
      expect(minMoney('10.49', '10.50')).toBe('10.49');
      expect(maxMoney('10.49', '10.50')).toBe('10.50');
    });
  });

  describe('Property Test: Sum of random amounts matches exactly (spec §12)', () => {
    test('Sum of 10,000 random currency values matches exact integer accumulator without precision drift', () => {
      const numItems = 10000;
      const amounts = [];
      let expectedIntegerAccumulator = 0;

      for (let i = 0; i < numItems; i++) {
        // Random amount between 1 paisa and 50,000.00 PKR
        const minor = Math.floor(Math.random() * 5000000) + 1;
        expectedIntegerAccumulator += minor;
        amounts.push(fromMinorUnits(minor));
      }

      const sumResult = sumMoney(amounts);
      const minorResult = sumMinor(amounts);

      expect(minorResult).toBe(expectedIntegerAccumulator);
      expect(sumResult).toBe(fromMinorUnits(expectedIntegerAccumulator));
    });
  });
});
