import { describe, expect, it } from 'vitest';

import { concatBytes, encode } from '../../../../src/domain/objects/encoding.js';
import {
  foldPackNameHash,
  PACK_NAME_HASH_SEED,
  packNameHash,
} from '../../../../src/domain/storage/pack-name-hash.js';

const V2_NAME_HASH_VECTORS: ReadonlyArray<readonly [Uint8Array, number]> = [
  [new Uint8Array(0), 0x00000000],
  [encode('a'), 0x86000000],
  [encode('ab'), 0x67800000],
  [encode('a b'), 0x67800000],
  [concatBytes([encode('ab'), Uint8Array.of(0x09)]), 0x67800000],
  [concatBytes([Uint8Array.of(0x0b), encode('ab')]), 0x74800000],
  [concatBytes([Uint8Array.of(0x0c), encode('ab')]), 0x6a800000],
  [encode('churn.txt'), 0x3ac57e00],
  [encode('src/churn.txt'), 0x395cfe00],
  [encode('lib/churn.txt'), 0x3b7efe00],
  [encode('deep/er/churn.txt'), 0x3b1f5980],
  [encode('README.md'), 0x5e0d7200],
  [encode('src/main.c'), 0xeef20000],
  [encode('src/util.c'), 0xea880000],
  [encode('0123456789abcdef'), 0x9569c357],
  [encode('X0123456789abcdef'), 0x9569c358],
  [concatBytes([Uint8Array.of(0xc3, 0xa9), encode('.txt')]), 0x3af5c000],
  [Uint8Array.of(0xff), 0xff000000],
];

describe('packNameHash', () => {
  describe('Given path bytes matching git’s pinned oracle vectors', () => {
    describe('When computing the name hash', () => {
      it.each([
        { label: 'empty', bytes: new Uint8Array(0), expected: 0x00000000 },
        { label: 'a', bytes: encode('a'), expected: 0x61000000 },
        { label: 'ab', bytes: encode('ab'), expected: 0x7a400000 },
        { label: 'a b (space skipped)', bytes: encode('a b'), expected: 0x7a400000 },
        {
          label: 'ab\\t (tab skipped)',
          bytes: concatBytes([encode('ab'), Uint8Array.of(0x09)]),
          expected: 0x7a400000,
        },
        {
          label: '\\x0bab (vertical tab hashed)',
          bytes: concatBytes([Uint8Array.of(0x0b), encode('ab')]),
          expected: 0x7af00000,
        },
        {
          label: '\\x0cab (form feed hashed)',
          bytes: concatBytes([Uint8Array.of(0x0c), encode('ab')]),
          expected: 0x7b000000,
        },
        { label: 'churn.txt', bytes: encode('churn.txt'), expected: 0x9a8bd300 },
        { label: 'src/churn.txt', bytes: encode('src/churn.txt'), expected: 0x9a8be72b },
        { label: 'lib/churn.txt', bytes: encode('lib/churn.txt'), expected: 0x9a8be6f0 },
        { label: 'deep/er/churn.txt', bytes: encode('deep/er/churn.txt'), expected: 0x9a8be7c7 },
        { label: 'README.md', bytes: encode('README.md'), expected: 0x83977600 },
        { label: 'src/main.c', bytes: encode('src/main.c'), expected: 0x77854ac0 },
        { label: 'src/util.c', bytes: encode('src/util.c'), expected: 0x777a4ac0 },
        {
          label: '0123456789abcdef',
          bytes: encode('0123456789abcdef'),
          expected: 0x878af8e3,
        },
        {
          label: 'X0123456789abcdef',
          bytes: encode('X0123456789abcdef'),
          expected: 0x878af8e3,
        },
        {
          label: '\\xc3\\xa9.txt (UTF-8 é)',
          bytes: concatBytes([Uint8Array.of(0xc3, 0xa9), encode('.txt')]),
          expected: 0x9ad1c000,
        },
        { label: '\\xff', bytes: Uint8Array.of(0xff), expected: 0xff000000 },
        {
          // The only row whose fold crosses 2^32 mid-way: the second byte
          // overflows the accumulator, so this pins the wrap itself against
          // git's `uint32_t` semantics rather than only the arithmetic below
          // it. Every other row here stays under 2^32 throughout.
          //
          // It does NOT pin where the truncation happens, and no test can:
          // `>>>` applies ToUint32 to its own left operand, so `hash >>> 2`
          // discards any excess at the next iteration whether or not the
          // previous step normalised. Per-step and truncate-once-at-the-end
          // agree on every input — checked over 200k random byte strings
          // against a BigInt model of the C fold, zero mismatches.
          //
          // The per-step `>>> 0` is redundant only against an equivalent
          // `>>> 0` on the return. The truncation ITSELF is load-bearing and
          // must not simply be deleted: the final step's `c << 24` is a
          // signed int32 for any byte >= 0x80, so a fold with no truncation at all
          // returns -16777216 rather than 0xff000000 for the `\xff` row.
          label: '\\x10\\xff\\x41 (mid-fold uint32 overflow)',
          bytes: Uint8Array.of(0x10, 0xff, 0x41),
          expected: 0x41c00000,
        },
      ])('Then returns git’s v1 hash for $label', ({ bytes, expected }) => {
        // Arrange
        const sut = packNameHash;

        // Act
        const result = sut(bytes);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a candidate space byte inserted before "ab"', () => {
    describe('When computing the name hash', () => {
      it('Then skips 0x09 (tab)', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x09), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).toBe(sut(without));
      });

      it('Then skips 0x0a (line feed)', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x0a), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).toBe(sut(without));
      });

      it('Then skips 0x0d (carriage return)', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x0d), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).toBe(sut(without));
      });

      it('Then skips 0x20 (space)', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x20), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).toBe(sut(without));
      });

      it('Then hashes 0x0b (vertical tab), producing the pinned value', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x0b), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).not.toBe(sut(without));
        expect(result).toBe(0x7af00000);
      });

      it('Then hashes 0x0c (form feed), producing the pinned value', () => {
        // Arrange
        const sut = packNameHash;
        const withByte = concatBytes([Uint8Array.of(0x0c), encode('ab')]);
        const without = encode('ab');

        // Act
        const result = sut(withByte);

        // Assert
        expect(result).not.toBe(sut(without));
        expect(result).toBe(0x7b000000);
      });
    });
  });

  describe('Given a single byte at or above 0x80', () => {
    describe('When computing the name hash', () => {
      it('Then folds 0x80 to the unsigned value 0x80000000', () => {
        // Arrange
        const sut = packNameHash;

        // Act
        const result = sut(Uint8Array.of(0x80));

        // Assert
        expect(result).toBe(0x80000000);
        expect(result).toBeGreaterThanOrEqual(0);
      });

      it('Then folds 0xff to the unsigned value 0xff000000, never negative', () => {
        // Arrange
        const sut = packNameHash;

        // Act
        const result = sut(Uint8Array.of(0xff));

        // Assert
        expect(result).toBe(0xff000000);
        expect(result).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('Given paths that differ only in bytes older than the sixteen-byte window', () => {
    describe('When computing the name hash', () => {
      it('Then a sixteen-byte prefix leaves the hash unchanged', () => {
        // Arrange
        const sut = packNameHash;
        const withPrefix = encode('X0123456789abcdef');
        const withoutPrefix = encode('0123456789abcdef');

        // Act
        const result = sut(withPrefix);

        // Assert
        expect(result).toBe(sut(withoutPrefix));
      });

      it('Then a fifteen-byte tail still admits the prefix by exactly one', () => {
        // Arrange
        const sut = packNameHash;
        const withPrefix = encode('X123456789abcdef');
        const withoutPrefix = encode('123456789abcdef');

        // Act
        const result = sut(withPrefix);

        // Assert
        expect(result - sut(withoutPrefix)).toBe(1);
      });
    });
  });

  describe('Given a path split into two byte chunks', () => {
    describe('When folding each chunk in sequence and comparing to a single-pass hash', () => {
      it('Then the folded composition matches packNameHash over the concatenation', () => {
        // Arrange
        const sut = foldPackNameHash;
        const first = encode('src/');
        const second = encode('main.c');

        // Act
        const result = sut(sut(PACK_NAME_HASH_SEED, first), second);

        // Assert
        expect(result).toBe(packNameHash(concatBytes([first, second])));
      });
    });
  });

  describe('Given empty path bytes', () => {
    describe('When computing the name hash', () => {
      it('Then returns the seed, and the seed is zero', () => {
        // Arrange
        const sut = packNameHash;

        // Act
        const result = sut(new Uint8Array(0));

        // Assert
        expect(result).toBe(PACK_NAME_HASH_SEED);
        expect(PACK_NAME_HASH_SEED).toBe(0);
      });
    });
  });

  describe('Given the pinned v2 name-hash vectors, recorded but not implemented', () => {
    describe('When inspecting the recorded table', () => {
      it('Then it holds at least one [bytes, uint32] pair', () => {
        // Arrange
        const sut = V2_NAME_HASH_VECTORS;

        // Act
        const result = sut.length;

        // Assert
        expect(result).toBeGreaterThan(0);
      });

      it.each(V2_NAME_HASH_VECTORS)(
        'Then each entry pairs Uint8Array bytes with a uint32',
        (bytes, hash) => {
          // Arrange
          const sut = { bytes, hash };

          // Act & Assert
          expect(sut.bytes).toBeInstanceOf(Uint8Array);
          expect(Number.isInteger(sut.hash)).toBe(true);
          expect(sut.hash).toBeGreaterThanOrEqual(0);
          expect(sut.hash).toBeLessThan(2 ** 32);
        },
      );
    });
  });
});
