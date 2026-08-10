import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

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
            const result = sut(bytes);
            expect(result).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
