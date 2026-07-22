import { describe, expect, it } from 'vitest';

import { TsgitError } from '../../../../src/domain/error.js';
import {
  formatObjectFilter,
  type ObjectFilter,
  parseObjectFilter,
} from '../../../../src/domain/protocol/object-filter.js';

const expectInvalid = (spec: string, reason: string): void => {
  // Act
  let caught: unknown;
  try {
    parseObjectFilter(spec);
  } catch (err) {
    caught = err;
  }
  // Assert
  expect(caught).toBeInstanceOf(TsgitError);
  const data = (caught as TsgitError).data;
  expect(data.code).toBe('INVALID_FILTER_SPEC');
  if (data.code !== 'INVALID_FILTER_SPEC') throw new Error('unreachable');
  expect(data.spec).toBe(spec);
  expect(data.reason).toBe(reason);
};

describe('parseObjectFilter', () => {
  describe('Given "blob:none"', () => {
    describe('When parsed', () => {
      it('Then returns the blob-none filter', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:none');
        // Assert
        expect(result).toEqual({ kind: 'blob-none' });
      });
    });
  });

  describe('Given "blob:limit=0"', () => {
    describe('When parsed', () => {
      it('Then returns a zero-byte limit', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:limit=0');
        // Assert
        expect(result).toEqual({ kind: 'blob-limit', bytes: 0 });
      });
    });
  });

  describe('Given "blob:limit=100"', () => {
    describe('When parsed', () => {
      it('Then returns the literal byte count', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:limit=100');
        // Assert
        expect(result).toEqual({ kind: 'blob-limit', bytes: 100 });
      });
    });
  });

  describe('Given a "k" suffix', () => {
    describe('When parsed', () => {
      it('Then multiplies by 1024', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:limit=1k');
        // Assert
        expect(result).toEqual({ kind: 'blob-limit', bytes: 1024 });
      });
    });
  });

  describe('Given an uppercase "M" suffix', () => {
    describe('When parsed', () => {
      it('Then multiplies by 1024^2', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:limit=2M');
        // Assert
        expect(result).toEqual({ kind: 'blob-limit', bytes: 2 * 1024 * 1024 });
      });
    });
  });

  describe('Given a "g" suffix', () => {
    describe('When parsed', () => {
      it('Then multiplies by 1024^3', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('blob:limit=3g');
        // Assert
        expect(result).toEqual({ kind: 'blob-limit', bytes: 3 * 1024 * 1024 * 1024 });
      });
    });
  });

  describe('Given "tree:0"', () => {
    describe('When parsed', () => {
      it('Then returns a zero-depth tree filter', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('tree:0');
        // Assert
        expect(result).toEqual({ kind: 'tree-depth', depth: 0 });
      });
    });
  });

  describe('Given "tree:5"', () => {
    describe('When parsed', () => {
      it('Then returns the requested depth', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('tree:5');
        // Assert
        expect(result).toEqual({ kind: 'tree-depth', depth: 5 });
      });
    });
  });

  describe('Given a multi-digit tree depth', () => {
    describe('When parsed', () => {
      it('Then returns the full depth', () => {
        // Arrange
        const sut = parseObjectFilter;
        // Act
        const result = sut('tree:42');
        // Assert
        expect(result).toEqual({ kind: 'tree-depth', depth: 42 });
      });
    });
  });

  describe('Given an empty string', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_FILTER_SPEC (empty)', () => {
        // Arrange + Assert
        expectInvalid('', 'empty');
      });
    });
  });

  describe('Given an unknown kind', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
        // Arrange + Assert
        expectInvalid('unknown:x', 'unknown-kind');
      });
    });
  });

  describe('Given "sparse:oid"', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
        // Arrange + Assert
        expectInvalid('sparse:oid=HEAD', 'unknown-kind');
      });
    });
  });

  describe('Given "combine:"', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
        // Arrange + Assert
        expectInvalid('combine:blob:none', 'unknown-kind');
      });
    });
  });

  describe('Given "blob:all"', () => {
    describe('When parsed', () => {
      it('Then throws INVALID_FILTER_SPEC (unknown-kind)', () => {
        // Arrange + Assert
        expectInvalid('blob:all', 'unknown-kind');
      });
    });
  });

  describe('Given "blob:limit=" with no number', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=', 'bad-blob-limit');
      });
    });
  });

  describe('Given a negative blob limit', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=-1', 'bad-blob-limit');
      });
    });
  });

  describe('Given a fractional blob limit', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=1.5', 'bad-blob-limit');
      });
    });
  });

  describe('Given a non-numeric blob limit', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=abc', 'bad-blob-limit');
      });
    });
  });

  describe('Given a bad suffix on a blob limit', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=1x', 'bad-blob-limit');
      });
    });
  });

  describe('Given a blob limit beyond MAX_SAFE_INTEGER', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=99999999999999999999', 'bad-blob-limit');
      });
    });
  });

  describe('Given a "g"-scaled limit that overflows safe range', () => {
    describe('When parsed', () => {
      it('Then throws (bad-blob-limit)', () => {
        // Arrange + Assert
        expectInvalid('blob:limit=9999999999999g', 'bad-blob-limit');
      });
    });
  });

  describe('Given "tree:" with no depth', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:', 'bad-tree-depth');
      });
    });
  });

  describe('Given a negative tree depth', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:-1', 'bad-tree-depth');
      });
    });
  });

  describe('Given a fractional tree depth', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:1.5', 'bad-tree-depth');
      });
    });
  });

  describe('Given a tree depth with trailing content after the integer', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:5.0', 'bad-tree-depth');
      });
    });
  });

  describe('Given a non-numeric tree depth', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:abc', 'bad-tree-depth');
      });
    });
  });

  describe('Given a tree depth beyond MAX_SAFE_INTEGER', () => {
    describe('When parsed', () => {
      it('Then throws (bad-tree-depth)', () => {
        // Arrange + Assert
        expectInvalid('tree:99999999999999999999', 'bad-tree-depth');
      });
    });
  });
});

describe('formatObjectFilter', () => {
  describe('Given the blob-none filter', () => {
    describe('When formatted', () => {
      it('Then renders "blob:none"', () => {
        // Arrange
        const sut = formatObjectFilter;
        // Act
        const result = sut({ kind: 'blob-none' });
        // Assert
        expect(result).toBe('blob:none');
      });
    });
  });

  describe('Given a blob-limit filter', () => {
    describe('When formatted', () => {
      it('Then renders the byte count', () => {
        // Arrange
        const sut = formatObjectFilter;
        // Act
        const result = sut({ kind: 'blob-limit', bytes: 4096 });
        // Assert
        expect(result).toBe('blob:limit=4096');
      });
    });
  });

  describe('Given a tree-depth filter', () => {
    describe('When formatted', () => {
      it('Then renders the depth', () => {
        // Arrange
        const sut = formatObjectFilter;
        // Act
        const result = sut({ kind: 'tree-depth', depth: 3 });
        // Assert
        expect(result).toBe('tree:3');
      });
    });
  });

  it.each<string>(['blob:none', 'blob:limit=1k', 'blob:limit=2M', 'tree:0', 'tree:7'])(
    'Given %s, When parsed then formatted then re-parsed, Then the filter is stable',
    (spec: string) => {
      // Arrange
      const first: ObjectFilter = parseObjectFilter(spec);
      // Act
      const reparsed = parseObjectFilter(formatObjectFilter(first));
      // Assert
      expect(reparsed).toEqual(first);
    },
  );
});
