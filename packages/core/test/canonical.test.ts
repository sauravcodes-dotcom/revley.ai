import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NonCanonicalValueError, canonicalize, digest } from '../src';

describe('canonical serialization', () => {
  it('is independent of key insertion order', () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('omits undefined members entirely', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('treats negative zero as zero', () => {
    expect(canonicalize({ v: -0 })).toBe(canonicalize({ v: 0 }));
  });

  it('rejects non-finite numbers rather than emitting null', () => {
    expect(() => canonicalize({ v: Number.NaN })).toThrow(NonCanonicalValueError);
    expect(() => canonicalize({ v: Number.POSITIVE_INFINITY })).toThrow(NonCanonicalValueError);
  });

  it('escapes strings so that delimiters cannot be forged', () => {
    // Without proper escaping these two objects would serialize identically, which would
    // let a caller construct two different plans with the same effect hash.
    const a = canonicalize({ k: 'a","b' });
    const b = canonicalize({ k: 'a', b: '' });
    expect(a).not.toBe(b);
  });

  it('domain separation makes identical values hash differently per domain', () => {
    const value = { a: 1 };
    expect(digest('warrant.effect.v1', value)).not.toBe(digest('warrant.route.v1', value));
  });

  it('is stable across repeated serialization of equivalent structures', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (obj) => {
        const shuffled = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalize(obj)).toBe(canonicalize(shuffled));
      }),
    );
  });
});
