import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MAX_MINOR,
  add,
  format,
  money,
  sub,
  sum,
  zero,
} from '../src';

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow(InvalidMoneyError);
  });

  it('rejects amounts beyond the representable bound', () => {
    expect(() => money(MAX_MINOR + 1, 'USD')).toThrow(InvalidMoneyError);
  });

  it('refuses to add across currencies', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('formats with grouping and two decimal places', () => {
    expect(format(money(1_234_567, 'USD'))).toBe('12,345.67 USD');
    expect(format(money(-4_000, 'USD'))).toBe('-40.00 USD');
    expect(format(money(5, 'USD'))).toBe('0.05 USD');
    expect(format(zero('EUR'))).toBe('0.00 EUR');
  });

  it('sums an empty list to zero', () => {
    expect(sum([], 'USD')).toEqual(money(0, 'USD'));
  });

  // The financial core does no floating point, so these properties should hold exactly
  // rather than approximately. That is the point of the type.
  it('add and sub are exact inverses', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (a, b) => {
          const x = money(a, 'USD');
          const y = money(b, 'USD');
          expect(sub(add(x, y), y)).toEqual(x);
        },
      ),
    );
  });

  it('sum equals repeated add', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -100_000, max: 100_000 }), { maxLength: 40 }), (xs) => {
        const amounts = xs.map((n) => money(n, 'USD'));
        const viaSum = sum(amounts, 'USD');
        const viaAdd = amounts.reduce((acc, m) => add(acc, m), zero('USD'));
        expect(viaSum).toEqual(viaAdd);
      }),
    );
  });
});
