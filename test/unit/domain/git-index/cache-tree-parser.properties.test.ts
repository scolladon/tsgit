import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { arbCacheTreeEntry } from './arbitraries.js';

const enc = new TextEncoder();

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

/** Test-local encoder — the inverse `parseCacheTree` doesn't need in
 *  production, but the property needs to construct valid bytes from an
 *  arbitrary {@link CacheTreeEntry} to prove the round trip. */
function encodeCacheTreeEntry(entry: CacheTreeEntry): Uint8Array {
  const pathBytes = enc.encode(entry.path);
  const header = enc.encode(`${entry.entryCount} ${entry.subtreeCount}\n`);
  const oidBytes = entry.id === undefined ? new Uint8Array(0) : hexToBytes(entry.id);
  const childBytes = entry.children.map(encodeCacheTreeEntry);
  return concatBytes([pathBytes, new Uint8Array([0]), header, oidBytes, ...childBytes]);
}

describe('cache-tree parser properties', () => {
  describe('Given an arbitrary CacheTreeEntry tree', () => {
    describe('When parseCacheTree(encode(tree))', () => {
      it('Then it returns an equivalent tree', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCacheTreeEntry(), (tree) => {
            const sut = parseCacheTree;
            const bytes = encodeCacheTreeEntry(tree);
            const result = sut(bytes, 20);
            expect(result).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary byte string up to 4 KiB', () => {
    describe('When parsing it as a cache tree', () => {
      it('Then it either returns a tree or refuses with INVALID_INDEX_ENTRY — never a RangeError', () => {
        // Arrange + Act + Assert
        const sut = parseCacheTree;

        // Raw bytes alone rarely survive the path/NUL gate, so half the runs
        // start from a VALID encoded tree and corrupt a window of it — the
        // only generation that drives the parser into its deep gates
        // (entry-count, subtree-count, oid, trailing bytes) with
        // in-bounds-looking values.
        const rawBytes = fc.uint8Array({ minLength: 0, maxLength: 4096, size: 'max' });
        const corruptedBuilt = arbCacheTreeEntry().chain((tree) => {
          const built = encodeCacheTreeEntry(tree);
          return fc
            .tuple(
              fc.nat({ max: Math.max(0, built.length - 1) }),
              fc.uint8Array({ minLength: 1, maxLength: 16 }),
            )
            .map(([start, patch]) => {
              const corrupted = built.slice();
              corrupted.set(patch.subarray(0, corrupted.length - start), start);
              return corrupted;
            });
        });

        fc.assert(
          fc.property(fc.oneof(rawBytes, corruptedBuilt), (bytes) => {
            let result: CacheTreeEntry | undefined;
            try {
              result = sut(bytes, 20);
            } catch (e) {
              expect((e as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
              return;
            }

            expect(typeof result.path).toBe('string');
            expect(result.children).toHaveLength(Math.max(result.subtreeCount, 0));
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
