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

describe('parseCacheTree', () => {
  describe('Given a root-only cache-tree with one resolvable entry', () => {
    describe('When parsing', () => {
      it('Then it returns the root entry with its oid and no children', () => {
        // Arrange
        const sut = parseCacheTree;
        const bytes = buildEntryBytes('', 3, 0, SHA_A);

        // Act
        const result = sut(bytes);

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
        const result = sut(root);

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
        const result = sut(root);

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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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
          sut(bytes);
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

  describe('Given an entry whose second (missing) subtree causes a truncated child read', () => {
    describe('When parsing', () => {
      it('Then it throws INVALID_INDEX_ENTRY at the missing child offset', () => {
        // Arrange — root claims 2 subtrees but only 1 is present
        const sut = parseCacheTree;
        const onlyChild = buildEntryBytes('src', 1, 0, SHA_A);
        const bytes = concatBytes([buildEntryBytes('', 2, 2, SHA_B), onlyChild]);

        // Act & Assert
        try {
          sut(bytes);
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
});
