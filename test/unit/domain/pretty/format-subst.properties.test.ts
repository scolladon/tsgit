import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Expansion, expandFormatSubst } from '../../../../src/domain/pretty/format-subst.js';
import { buildCharsetEncoder } from '../../../../src/domain/pretty/reencode.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const TOTALITY_RUNS = 200;
const IDENTITY_RUNS = 200;
const COUNT_RUNS = 100;
const MAX_OCCURRENCES = 6;

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const containsMarker = (blob: Uint8Array): boolean =>
  new TextDecoder('latin1').decode(blob).includes('$Format:');

const plain = (bytes: Uint8Array): Expansion => ({
  bytes,
  parsedHeader: false,
  encoding: undefined,
});

const echo = (accumulated: Uint8Array, fmt: Uint8Array): Expansion =>
  plain(concat(accumulated, fmt));

describe('Given arbitrary bytes, When expanding', () => {
  it('Then it never throws', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (blob) => {
        // Arrange
        const sut = expandFormatSubst;

        // Act
        const result = sut(blob, echo, buildCharsetEncoder);

        // Assert
        expect(result).toBeInstanceOf(Uint8Array);
      }),
      { numRuns: TOTALITY_RUNS },
    );
  });
});

describe('Given a blob without $Format:, When expanding', () => {
  it('Then the output equals the input and expandOne is never called', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (blob) => {
        fc.pre(!containsMarker(blob));
        // Arrange
        const sut = expandFormatSubst;
        let calls = 0;

        // Act
        const result = sut(
          blob,
          (accumulated) => {
            calls += 1;
            return plain(accumulated);
          },
          buildCharsetEncoder,
        );

        // Assert
        expect([...result]).toEqual([...blob]);
        expect(calls).toBe(0);
      }),
      { numRuns: IDENTITY_RUNS },
    );
  });
});

describe('Given k well-formed $Format:%H$ occurrences, When expanding', () => {
  it('Then expandOne is called exactly k times', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_OCCURRENCES }), (k) => {
        // Arrange
        const sut = expandFormatSubst;
        const blob = encode(Array.from({ length: k }, () => 'text $Format:%H$ ').join(''));
        let calls = 0;

        // Act
        sut(
          blob,
          (accumulated) => {
            calls += 1;
            return plain(accumulated);
          },
          buildCharsetEncoder,
        );

        // Assert
        expect(calls).toBe(k);
      }),
      { numRuns: COUNT_RUNS },
    );
  });
});
