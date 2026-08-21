import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';

const enc = new TextEncoder();

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Builds one raw cache-tree entry's bytes: NUL-terminated path, `entryCount
 *  SP subtreeCount LF`, then the raw oid (only when `sha` is given). */
function buildEntryBytes(
  path: string,
  entryCount: number,
  subtreeCount: number,
  sha?: string,
): Uint8Array {
  const pathBytes = enc.encode(path);
  const header = enc.encode(`${entryCount} ${subtreeCount}\n`);
  const oidBytes = sha === undefined ? new Uint8Array(0) : hexToBytes(sha);
  return concatBytes([pathBytes, new Uint8Array([0]), header, oidBytes]);
}

/** Builds a chain of `levels` entries, each the sole subtree of the one
 *  before it. Every entry is invalidated (`entryCount = -1`) so it carries no
 *  oid — six bytes per nesting level, the cheapest nesting the grammar
 *  allows and therefore the shape a depth bound has to survive. */
function buildNestedChain(levels: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let level = 0; level < levels; level += 1) {
    parts.push(buildEntryBytes('', -1, level === levels - 1 ? 0 : 1));
  }
  return concatBytes(parts);
}

/** One more level than `MAX_CACHE_TREE_DEPTH` admits: the root sits at depth
 *  0, so a chain of `MAX + 1` entries is exactly the deepest accepted one. */
const DEEPEST_ACCEPTED_CHAIN = 1025;

describe('parseCacheTree', () => {
  describe('Given a root-only cache-tree with one resolvable entry', () => {
    describe('When parsing', () => {
      it('Then it returns the root entry with its oid and no children', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = buildEntryBytes('', 3, 0, SHA_A);

        // Act
        const result = sut(bytes, 20);

        // Assert
        expect(result).toEqual({
          path: '',
          entryCount: 3,
          subtreeCount: 0,
          id: SHA_A,
          children: [],
        });
      });
    });
  });

  describe('Given a root entry with one invalidated (entryCount = -1) subtree', () => {
    describe('When parsing', () => {
      it('Then the child carries no id and is not read past its header', () => {
        // Arrange
        const sut = parseCacheTree;
        const child = buildEntryBytes('src', -1, 0);
        const root = concatBytes([buildEntryBytes('', 2, 1, SHA_A), child]);

        // Act
        const result = sut(root, 20);

        // Assert
        expect(result).toEqual({
          path: '',
          entryCount: 2,
          subtreeCount: 1,
          id: SHA_A,
          children: [{ path: 'src', entryCount: -1, subtreeCount: 0, children: [] }],
        });
      });
    });
  });

  describe('Given a root entry with two nested subtrees, the second with its own child', () => {
    describe('When parsing', () => {
      it('Then every entry nests depth-first with the correct oid threaded through', () => {
        // Arrange
        const sut = parseCacheTree;
        const grandchild = buildEntryBytes('deep', 1, 0, SHA_C);
        const secondChild = concatBytes([buildEntryBytes('lib', 2, 1, SHA_B), grandchild]);
        const firstChild = buildEntryBytes('src', 1, 0, SHA_A);
        const root = concatBytes([buildEntryBytes('', 4, 2, SHA_C), firstChild, secondChild]);

        // Act
        const result = sut(root, 20);

        // Assert
        expect(result).toEqual({
          path: '',
          entryCount: 4,
          subtreeCount: 2,
          id: SHA_C,
          children: [
            { path: 'src', entryCount: 1, subtreeCount: 0, id: SHA_A, children: [] },
            {
              path: 'lib',
              entryCount: 2,
              subtreeCount: 1,
              id: SHA_B,
              children: [{ path: 'deep', entryCount: 1, subtreeCount: 0, id: SHA_C, children: [] }],
            },
          ],
        });
      });
    });
  });

  describe('Given an entry whose path has no NUL terminator', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = enc.encode('no-nul-here');

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry missing NUL-terminated path',
          });
        }
      });
    });
  });

  describe('Given an entry missing the space between entry-count and subtree-count', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('12\n')]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry missing entry-count separator',
          });
        }
      });
    });
  });

  describe('Given an entry missing the LF after subtree-count', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('1 0')]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry missing subtree-count terminator',
          });
        }
      });
    });
  });

  describe('Given an entry whose entry-count is not a valid decimal', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('x 0\n')]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry has a malformed entry count',
          });
        }
      });
    });
  });

  describe('Given an entry whose subtree-count is not a valid decimal', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('1 y\n')]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry has a malformed subtree count',
          });
        }
      });
    });
  });

  describe('Given an entry whose subtree-count is negative', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY (subtree-count is never negative, unlike entry-count)', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('1 -1\n')]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry has a malformed subtree count',
          });
        }
      });
    });
  });

  describe('Given a resolvable entry whose oid is truncated', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([new Uint8Array([0]), enc.encode('1 0\n'), new Uint8Array(5)]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 0,
            reason: 'cache-tree entry truncated oid',
          });
        }
      });
    });
  });

  describe('Given a buffer with trailing bytes after the root entry and its subtrees', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = concatBytes([buildEntryBytes('', 1, 0, SHA_A), new Uint8Array([9])]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: bytes.length - 1,
            reason: 'cache-tree data has trailing bytes',
          });
        }
      });
    });
  });

  describe(`Given a chain of ${DEEPEST_ACCEPTED_CHAIN} nested entries`, () => {
    describe('When parsing', () => {
      it('Then it parses, since the deepest entry sits exactly at the depth bound', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = buildNestedChain(DEEPEST_ACCEPTED_CHAIN);

        // Act
        const result = sut(bytes, 20);

        // Assert
        expect(result.subtreeCount).toBe(1);
      });
    });
  });

  describe(`Given a chain of ${DEEPEST_ACCEPTED_CHAIN + 1} nested entries`, () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY rather than exhausting the call stack', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = buildNestedChain(DEEPEST_ACCEPTED_CHAIN + 1);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: DEEPEST_ACCEPTED_CHAIN * 6,
            reason: 'cache-tree nesting exceeds the maximum depth',
          });
        }
      });
    });
  });

  describe('Given a subtree whose path ends with the same byte that separates the counts', () => {
    describe('When parsing', () => {
      it('Then the count scan starts past the NUL and the trailing space stays part of the path', () => {
        // Arrange — a path may legitimately end in a space; only a scan that
        // starts after the terminator can tell it from the count separator.
        const sut = parseCacheTree;
        const child = buildEntryBytes('dir ', 1, 0, SHA_A);
        const bytes = concatBytes([buildEntryBytes('', 1, 1, SHA_B), child]);

        // Act
        const result = sut(bytes, 20);

        // Assert
        expect(result.children).toEqual([
          { path: 'dir ', entryCount: 1, subtreeCount: 0, id: SHA_A, children: [] },
        ]);
      });
    });
  });

  describe('Given an entry whose second (missing) subtree causes a truncated child read', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY at the missing child offset', () => {
        // Arrange — root claims 2 subtrees but only 1 is present
        const sut = parseCacheTree;
        const onlyChild = buildEntryBytes('src', 1, 0, SHA_A);
        const bytes = concatBytes([buildEntryBytes('', 2, 2, SHA_B), onlyChild]);

        // Act & Assert
        try {
          sut(bytes, 20);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: bytes.length,
            reason: 'cache-tree entry missing NUL-terminated path',
          });
        }
      });
    });
  });

  describe('Given a root-only cache-tree with a 32-byte (SHA-256) oid', () => {
    describe('When parsing at digestLength 32', () => {
      it('Then it returns the root entry with its full 64-hex oid', () => {
        // Arrange
        const sut = parseCacheTree;
        const SHA_256_A = '2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4';
        const bytes = buildEntryBytes('', 1, 0, SHA_256_A);

        // Act
        const result = sut(bytes, 32);

        // Assert
        expect(result).toEqual({
          path: '',
          entryCount: 1,
          subtreeCount: 0,
          id: SHA_256_A,
          children: [],
        });
      });
    });
  });
});
