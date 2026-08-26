/**
 * Money is represented as an integer count of minor units (cents) plus a currency.
 *
 * Floating point is never used for money anywhere in this system. Every amount that
 * crosses a boundary -- database, processor API, model tool call, ledger entry -- is
 * an integer of minor units. The `Money` type exists so that a currency mismatch is a
 * type-and-runtime error rather than a silent addition of dollars to euros.
 */

export type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD';

export const CURRENCIES: readonly Currency[] = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

/** Minor-unit exponent per currency. All supported currencies are 2dp today; the table
 *  exists so that adding JPY (0dp) or KWD (3dp) is a data change, not a code change. */
const MINOR_UNIT_EXPONENT: Record<Currency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
};

export interface Money {
  readonly currency: Currency;
  /** Signed integer count of minor units. */
  readonly minor: number;
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * Upper bound on any single amount the system will represent: 1 trillion minor units.
 * This is far above any real transaction and far below Number.MAX_SAFE_INTEGER, which
 * leaves headroom for summing many amounts without losing integer precision.
 */
export const MAX_MINOR = 1_000_000_000_000;

export function money(minor: number, currency: Currency): Money {
  if (!Number.isInteger(minor)) {
    throw new InvalidMoneyError(`amount must be an integer number of minor units, got ${minor}`);
  }
  if (Math.abs(minor) > MAX_MINOR) {
    throw new InvalidMoneyError(`amount ${minor} exceeds MAX_MINOR (${MAX_MINOR})`);
  }
  return { currency, minor };
}

export function zero(currency: Currency): Money {
  return { currency, minor: 0 };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function neg(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  let acc = 0;
  for (const m of items) {
    if (m.currency !== currency) throw new CurrencyMismatchError(currency, m.currency);
    acc += m.minor;
  }
  return money(acc, currency);
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export const gt = (a: Money, b: Money): boolean => cmp(a, b) === 1;
export const gte = (a: Money, b: Money): boolean => cmp(a, b) >= 0;
export const lt = (a: Money, b: Money): boolean => cmp(a, b) === -1;
export const lte = (a: Money, b: Money): boolean => cmp(a, b) <= 0;
export const eq = (a: Money, b: Money): boolean => cmp(a, b) === 0;

export const isZero = (a: Money): boolean => a.minor === 0;
export const isPositive = (a: Money): boolean => a.minor > 0;
export const isNegative = (a: Money): boolean => a.minor < 0;

export function abs(a: Money): Money {
  return money(Math.abs(a.minor), a.currency);
}

export function min(a: Money, b: Money): Money {
  return lte(a, b) ? a : b;
}

export function max(a: Money, b: Money): Money {
  return gte(a, b) ? a : b;
}

/** Human-readable form used in approval UIs, audit records and eval reports. */
export function format(a: Money): string {
  const exp = MINOR_UNIT_EXPONENT[a.currency];
  const sign = a.minor < 0 ? '-' : '';
  const digits = Math.abs(a.minor).toString().padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp);
  const frac = exp === 0 ? '' : `.${digits.slice(digits.length - exp)}`;
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${frac} ${a.currency}`;
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}
