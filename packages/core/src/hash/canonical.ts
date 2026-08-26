import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization (RFC 8785-style, restricted to the value shapes this
 * system actually produces).
 *
 * The effect hash is load-bearing: it is the idempotency key for processor calls, the
 * identity of an approval, and the value compared at commit time to detect that the
 * world moved. So the serialization has to be stable across processes and versions:
 *
 *  - object keys sorted by UTF-16 code unit
 *  - no insignificant whitespace
 *  - `undefined` members omitted entirely, so an optional field that is absent hashes
 *    the same as one explicitly set to undefined
 *  - numbers must be finite; NaN and Infinity are rejected rather than silently
 *    serialized as null, which is what JSON.stringify does
 */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [k: string]: CanonicalValue | undefined };

export class NonCanonicalValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonCanonicalValueError';
  }
}

export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(`non-finite number in canonical value: ${value}`);
      }
      // Negative zero and positive zero must not hash differently.
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new NonCanonicalValueError(`unsupported type: ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v as CanonicalValue)).join(',')}]`;
  }

  const obj = value as { readonly [k: string]: CanonicalValue | undefined };
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k] as CanonicalValue)}`);
  return `{${body.join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hash of a canonical value, prefixed with a domain-separation tag so that hashes of
 * different kinds of object can never collide or be substituted for one another.
 */
export function digest(domain: string, value: CanonicalValue): string {
  return sha256Hex(`${domain} ${canonicalize(value)}`);
}
