import { describe, expect, it } from 'vitest';
import {
  BITMAP_FLOOR_BYTES,
  BITMAP_HEADROOM_BYTES_PER_OBJECT,
  exceedsMaxBitmapBytes,
  exceedsMaxCommitMessageBytes,
  exceedsMaxIndexBytes,
  exceedsMaxMidxBytes,
  exceedsMaxMidxChainLayers,
  exceedsMaxPackIdxBytes,
  exceedsMaxPeelDepth,
  exceedsMaxSymbolicDepth,
  exceedsMaxTreeDepth,
  exceedsMaxTreeEntries,
  exceedsMaxWalkSeeds,
  hasDeclaredId,
  hasHeaderInjectionChars,
  hasSignatureInjectionChars,
  isContainedRefSegment,
  isEmptyFrom,
  isGitlink,
  isHead,
  isInvalidExtraHeaderKey,
  MAX_MIDX_BYTES,
  MAX_MIDX_CHAIN_LAYERS,
  MAX_PACK_IDX_BYTES,
  maxBitmapBytes,
  messageContainsNul,
  REASON_BITMAP_EXCEEDS_MAX,
  REASON_EXTRA_HEADER_KEY_INVALID,
  REASON_INDEX_CHECKSUM_MISMATCH,
  REASON_INDEX_EXCEEDS_MAX,
  REASON_MESSAGE_CONTAINS_NUL,
  REASON_MESSAGE_EXCEEDS_MAX,
  REASON_MIDX_CHAIN_TOO_LONG,
  REASON_MIDX_EXCEEDS_MAX,
  REASON_PACK_IDX_EXCEEDS_MAX,
  REASON_TARGET_ESCAPES_GIT_DIR,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_TOO_MANY_SEEDS,
} from '../../../../src/application/primitives/validators.js';

describe('isEmptyFrom', () => {
  describe('Given empty array', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isEmptyFrom([]);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
  describe('Given one-element array', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = isEmptyFrom(['a']);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('exceedsMaxWalkSeeds boundary triple', () => {
  describe('Given an array length around MAX_WALK_SEEDS', () => {
    describe('When invoked', () => {
      it.each([
        { length: 1023, expected: false, label: 'returns false (just-under)' },
        { length: 1024, expected: false, label: 'returns false (at cap)' },
        { length: 1025, expected: true, label: 'returns true (just-over cap)' },
      ])('Then $label', ({ length, expected }) => {
        // Arrange & Act
        const result = exceedsMaxWalkSeeds(new Array(length).fill(0));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('messageContainsNul', () => {
  describe('Given a message string', () => {
    describe('When invoked', () => {
      it.each([
        {
          value: 'a\0b',
          expected: true,
          label: 'returns true for a NUL byte anywhere in the string',
        },
        { value: 'hello world', expected: false, label: 'returns false for a clean message' },
        { value: '', expected: false, label: 'returns false for an empty string' },
      ])('Then $label', ({ value, expected }) => {
        // Arrange & Act
        const result = messageContainsNul(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxCommitMessageBytes boundary triple', () => {
  describe('Given a message length around 16 MiB', () => {
    describe('When invoked', () => {
      it.each([
        {
          length: 16 * 1024 * 1024 - 1,
          expected: false,
          label: 'returns false (just-under)',
        },
        { length: 16 * 1024 * 1024, expected: false, label: 'returns false (at cap)' },
        {
          length: 16 * 1024 * 1024 + 1,
          expected: true,
          label: 'returns true (just-over)',
        },
      ])('Then $label', ({ length, expected }) => {
        // Arrange & Act
        const result = exceedsMaxCommitMessageBytes('x'.repeat(length));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxIndexBytes boundary triple', () => {
  describe('Given a size around 256 MiB', () => {
    describe('When invoked', () => {
      it.each([
        { size: 256 * 1024 * 1024 - 1, expected: false, label: 'returns false (just-under)' },
        { size: 256 * 1024 * 1024, expected: false, label: 'returns false (at cap)' },
        { size: 256 * 1024 * 1024 + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ size, expected }) => {
        // Arrange & Act
        const result = exceedsMaxIndexBytes(size);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxSymbolicDepth boundary triple (default cap = 5)', () => {
  describe('Given a depth around the default or an overridden cap', () => {
    describe('When invoked', () => {
      it.each([
        { depth: 4, cap: undefined, expected: false, label: 'returns false (just-under)' },
        { depth: 5, cap: undefined, expected: false, label: 'returns false (at cap)' },
        { depth: 6, cap: undefined, expected: true, label: 'returns true (just-over)' },
        {
          depth: 6,
          cap: 10,
          expected: false,
          label: 'returns false (cap override works)',
        },
      ])('Then $label', ({ depth, cap, expected }) => {
        // Arrange & Act
        const result = exceedsMaxSymbolicDepth(depth, cap);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxPeelDepth boundary triple (default cap = 5)', () => {
  describe('Given a depth around the default cap', () => {
    describe('When invoked', () => {
      it.each([
        { depth: 4, expected: false, label: 'returns false (just-under)' },
        { depth: 5, expected: false, label: 'returns false (at cap)' },
        { depth: 6, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ depth, expected }) => {
        // Arrange & Act
        const result = exceedsMaxPeelDepth(depth);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isContainedRefSegment', () => {
  describe('Given a ref-segment candidate', () => {
    describe('When invoked', () => {
      it.each([
        { value: 'refs/heads/main', expected: true, label: 'returns true (baseline accept)' },
        { value: 'HEAD', expected: true, label: 'returns true' },
        { value: '/etc/passwd', expected: false, label: 'returns false (absolute)' },
        {
          value: 'refs\\heads\\main',
          expected: false,
          label: 'returns false (Windows drive)',
        },
        { value: 'C:/foo', expected: false, label: 'returns false (UNC/drive)' },
        { value: 'refs/../escape', expected: false, label: 'returns false (traversal)' },
      ])('Then $label', ({ value, expected }) => {
        // Arrange & Act
        const result = isContainedRefSegment(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isHead', () => {
  describe('Given a ref-name candidate', () => {
    describe('When invoked', () => {
      it.each([
        { value: 'HEAD', expected: true, label: 'returns true' },
        { value: 'refs/heads/main', expected: false, label: 'returns false' },
        { value: 'head', expected: false, label: 'returns false (case-sensitive)' },
      ])('Then $label', ({ value, expected }) => {
        // Arrange & Act
        const result = isHead(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isGitlink', () => {
  describe('Given a file mode', () => {
    describe('When invoked', () => {
      it.each([
        { mode: '160000', expected: true, label: 'returns true' },
        { mode: '100644', expected: false, label: 'returns false (blob)' },
        { mode: '040000', expected: false, label: 'returns false (tree)' },
      ])('Then $label', ({ mode, expected }) => {
        // Arrange & Act
        const result = isGitlink(mode);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxTreeDepth boundary triple', () => {
  describe('Given a depth around a cap of 5', () => {
    describe('When invoked', () => {
      it.each([
        { depth: 4, cap: 5, expected: false, label: 'returns false' },
        { depth: 5, cap: 5, expected: false, label: 'returns false (at)' },
        { depth: 6, cap: 5, expected: true, label: 'returns true' },
      ])('Then $label', ({ depth, cap, expected }) => {
        // Arrange & Act
        const result = exceedsMaxTreeDepth(depth, cap);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxTreeEntries boundary triple', () => {
  describe('Given a count around a cap of 3', () => {
    describe('When invoked', () => {
      it.each([
        { count: 2, cap: 3, expected: false, label: 'returns false' },
        { count: 3, cap: 3, expected: false, label: 'returns false (at)' },
        { count: 4, cap: 3, expected: true, label: 'returns true' },
      ])('Then $label', ({ count, cap, expected }) => {
        // Arrange & Act
        const result = exceedsMaxTreeEntries(count, cap);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('hasDeclaredId', () => {
  describe('Given an empty string', () => {
    describe('When invoked', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = hasDeclaredId('');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
  describe('Given a hex id', () => {
    describe('When invoked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = hasDeclaredId('0'.repeat(40));

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('isInvalidExtraHeaderKey', () => {
  describe('Given an extraHeader key candidate', () => {
    describe('When invoked', () => {
      it.each([
        { key: 'mergetag', expected: false, label: 'returns false for a clean key' },
        { key: '', expected: true, label: 'returns true for an empty key' },
        { key: 'a\0b', expected: true, label: 'returns true for a key with NUL' },
        { key: 'a\rb', expected: true, label: 'returns true for a key with CR' },
        { key: 'a\nb', expected: true, label: 'returns true for a key with LF' },
        {
          key: 'two words',
          expected: true,
          label: 'returns true for a key with a space (the key/value separator)',
        },
        { key: 'a\tb', expected: true, label: 'returns true for a key with a tab' },
      ])('Then $label', ({ key, expected }) => {
        // Arrange & Act
        const result = isInvalidExtraHeaderKey(key);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('hasHeaderInjectionChars', () => {
  describe('Given a header-value candidate', () => {
    describe('When hasHeaderInjectionChars', () => {
      it.each([
        {
          value: 'a clean header value',
          expected: false,
          label: 'returns false for a clean value',
        },
        { value: 'a\0b', expected: true, label: 'returns true for a value containing NUL' },
        { value: 'a\rb', expected: true, label: 'returns true for a value containing CR' },
        {
          value: 'a\n\nb',
          expected: true,
          label: 'returns true for a value containing a double LF',
        },
        {
          value: '\nabc',
          expected: true,
          label:
            'returns true for a LEADING LF only (isolates the startsWith(\\n) operand — no trailing LF)',
        },
        {
          value: 'abc\n',
          expected: true,
          label:
            'returns true for a TRAILING LF only (isolates the endsWith(\\n) operand — no leading LF)',
        },
        {
          value: 'a\nb',
          expected: false,
          label: 'returns false for an INTERIOR single LF only (every guard is false)',
        },
      ])('Then $label', ({ value, expected }) => {
        // Arrange & Act
        const result = hasHeaderInjectionChars(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('hasSignatureInjectionChars', () => {
  describe('Given a gpgSignature-field value candidate', () => {
    describe('When hasSignatureInjectionChars', () => {
      it.each([
        { value: 'a\0b', expected: true, label: 'returns true for a value containing NUL' },
        { value: 'a\rb', expected: true, label: 'returns true for a value containing CR' },
        {
          value: '-----BEGIN PGP SIGNATURE-----\n\nZmFrZQ==\n-----END PGP SIGNATURE-----\n',
          expected: false,
          label:
            'returns false for a genuine PGP armor block (blank line after BEGIN + trailing LF) — real armor carries no NUL/CR',
        },
        {
          value: 'a\n\nb',
          expected: false,
          label:
            'returns false for an interior double LF but no NUL/CR — the double-LF rule does not apply to this predicate',
        },
      ])('Then $label', ({ value, expected }) => {
        // Arrange & Act
        const result = hasSignatureInjectionChars(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxPackIdxBytes boundary triple', () => {
  describe('Given a size around MAX_PACK_IDX_BYTES', () => {
    describe('When invoked', () => {
      it.each([
        { size: MAX_PACK_IDX_BYTES - 1, expected: false, label: 'returns false (just-under)' },
        { size: MAX_PACK_IDX_BYTES, expected: false, label: 'returns false (at cap)' },
        { size: MAX_PACK_IDX_BYTES + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ size, expected }) => {
        // Arrange & Act
        const result = exceedsMaxPackIdxBytes(size);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxMidxBytes boundary triple', () => {
  describe('Given a size around MAX_MIDX_BYTES', () => {
    describe('When invoked', () => {
      it.each([
        { size: MAX_MIDX_BYTES - 1, expected: false, label: 'returns false (just-under)' },
        { size: MAX_MIDX_BYTES, expected: false, label: 'returns false (at cap)' },
        { size: MAX_MIDX_BYTES + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ size, expected }) => {
        // Arrange & Act
        const result = exceedsMaxMidxBytes(size);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxMidxChainLayers boundary triple', () => {
  describe('Given a layer count around MAX_MIDX_CHAIN_LAYERS', () => {
    describe('When invoked', () => {
      it.each([
        { count: MAX_MIDX_CHAIN_LAYERS - 1, expected: false, label: 'returns false (just-under)' },
        { count: MAX_MIDX_CHAIN_LAYERS, expected: false, label: 'returns false (at cap)' },
        { count: MAX_MIDX_CHAIN_LAYERS + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ count, expected }) => {
        // Arrange & Act
        const result = exceedsMaxMidxChainLayers(count);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('maxBitmapBytes', () => {
  describe('Given an objectCount whose scaled headroom is under the floor', () => {
    describe('When invoked', () => {
      it('Then the floor wins', () => {
        // Arrange
        const objectCount = 1;

        // Act
        const result = maxBitmapBytes(objectCount);

        // Assert
        expect(result).toBe(BITMAP_FLOOR_BYTES);
      });
    });
  });

  describe('Given an objectCount whose scaled headroom exceeds the floor', () => {
    describe('When invoked', () => {
      it('Then the scaled headroom wins', () => {
        // Arrange
        const objectCount = 1_000_000;

        // Act
        const result = maxBitmapBytes(objectCount);

        // Assert
        expect(result).toBe(objectCount * BITMAP_HEADROOM_BYTES_PER_OBJECT);
      });
    });
  });
});

describe('exceedsMaxBitmapBytes boundary triple, floor-dominated objectCount', () => {
  describe('Given a size around BITMAP_FLOOR_BYTES with a tiny objectCount', () => {
    describe('When invoked', () => {
      it.each([
        { size: BITMAP_FLOOR_BYTES - 1, expected: false, label: 'returns false (just-under)' },
        { size: BITMAP_FLOOR_BYTES, expected: false, label: 'returns false (at cap)' },
        { size: BITMAP_FLOOR_BYTES + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ size, expected }) => {
        // Arrange & Act
        const result = exceedsMaxBitmapBytes(size, 1);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('exceedsMaxBitmapBytes boundary triple, headroom-scaled objectCount', () => {
  describe('Given a size around the objectCount-scaled ceiling', () => {
    describe('When invoked', () => {
      const objectCount = 1_000_000;
      const cap = objectCount * BITMAP_HEADROOM_BYTES_PER_OBJECT;

      it.each([
        { size: cap - 1, expected: false, label: 'returns false (just-under)' },
        { size: cap, expected: false, label: 'returns false (at cap)' },
        { size: cap + 1, expected: true, label: 'returns true (just-over)' },
      ])('Then $label', ({ size, expected }) => {
        // Arrange & Act
        const result = exceedsMaxBitmapBytes(size, objectCount);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('error-reason constants are stable identifiers', () => {
  describe('Given a REASON_* constant', () => {
    describe('When read', () => {
      it.each([
        { actual: REASON_WALK_EMPTY_FROM, expected: 'empty from', label: 'REASON_WALK_EMPTY_FROM' },
        {
          actual: REASON_WALK_TOO_MANY_SEEDS,
          expected: 'too many seeds',
          label: 'REASON_WALK_TOO_MANY_SEEDS',
        },
        {
          actual: REASON_MESSAGE_CONTAINS_NUL,
          expected: 'message contains NUL',
          label: 'REASON_MESSAGE_CONTAINS_NUL',
        },
        {
          actual: REASON_MESSAGE_EXCEEDS_MAX,
          expected: 'message exceeds 16 MiB',
          label: 'REASON_MESSAGE_EXCEEDS_MAX',
        },
        {
          actual: REASON_INDEX_EXCEEDS_MAX,
          expected: 'index file exceeds 256 MiB',
          label: 'REASON_INDEX_EXCEEDS_MAX',
        },
        {
          actual: REASON_TARGET_ESCAPES_GIT_DIR,
          expected: 'target escapes gitDir',
          label: 'REASON_TARGET_ESCAPES_GIT_DIR',
        },
        {
          actual: REASON_INDEX_CHECKSUM_MISMATCH,
          expected: 'index trailer checksum mismatch',
          label: 'REASON_INDEX_CHECKSUM_MISMATCH',
        },
        {
          actual: REASON_PACK_IDX_EXCEEDS_MAX,
          expected: 'pack .idx file exceeds 64 MiB',
          label: 'REASON_PACK_IDX_EXCEEDS_MAX',
        },
        {
          actual: REASON_EXTRA_HEADER_KEY_INVALID,
          expected: 'extraHeader key contains forbidden characters',
          label: 'REASON_EXTRA_HEADER_KEY_INVALID',
        },
        {
          actual: REASON_MIDX_EXCEEDS_MAX,
          expected: 'multi-pack-index file exceeds 1 GiB',
          label: 'REASON_MIDX_EXCEEDS_MAX',
        },
        {
          actual: REASON_MIDX_CHAIN_TOO_LONG,
          expected: 'multi-pack-index chain exceeds 1000 layers',
          label: 'REASON_MIDX_CHAIN_TOO_LONG',
        },
        {
          actual: REASON_BITMAP_EXCEEDS_MAX,
          expected: 'bitmap file exceeds its object-count-scaled bound',
          label: 'REASON_BITMAP_EXCEEDS_MAX',
        },
      ])('Then $label matches expected string', ({ actual, expected }) => {
        // Arrange + Assert
        expect(actual).toBe(expected);
      });
    });
  });
});
