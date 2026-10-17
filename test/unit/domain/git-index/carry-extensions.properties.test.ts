import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serializeCacheTree } from '../../../../src/domain/git-index/cache-tree.js';
import {
  carryExtensions,
  withResolveUndo,
} from '../../../../src/domain/git-index/carry-extensions.js';
import type {
  CacheTreeEntry,
  IndexExtension,
} from '../../../../src/domain/git-index/index-entry.js';
import {
  parseResolveUndo,
  recordResolveUndo,
  serializeResolveUndo,
} from '../../../../src/domain/git-index/resolve-undo.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbResolveUndoRecord } from './arbitraries.js';

const NUM_RUNS = 200;
const RESOLVE_UNDO_RUNS = 100;
const arbRecords = fc.array(arbResolveUndoRecord(), { maxLength: 4 });
const DIGEST_LENGTH = 20;
const SETTINGS = { untrackedCache: undefined, digestLength: DIGEST_LENGTH } as const;
const TREE_ID = 'a'.repeat(40) as ObjectId;
// Two names only, so repeated sibling names are common among generated trees.
const NAMES = ['a', 'b'] as const;
const MAX_DEPTH = 3;

const withName = (path: string, children: ReadonlyArray<CacheTreeEntry>): CacheTreeEntry => ({
  path,
  entryCount: 1,
  subtreeCount: children.length,
  id: TREE_ID,
  children,
});

const arbTreeAllowingTwins = (depth: number): fc.Arbitrary<CacheTreeEntry> =>
  fc
    .record({
      path: fc.constantFrom(...NAMES),
      children:
        depth <= 0
          ? fc.constant([] as ReadonlyArray<CacheTreeEntry>)
          : fc.array(arbTreeAllowingTwins(depth - 1), { maxLength: 3 }),
    })
    .map(({ path, children }) => withName(path, children));

const repeatsAChildName = (tree: CacheTreeEntry): boolean => {
  const names = tree.children.map((child) => child.path);
  return new Set(names).size !== names.length || tree.children.some(repeatsAChildName);
};

describe('carryExtensions TREE properties', () => {
  describe('Given a TREE whose nodes may repeat a child name at any depth', () => {
    describe('When carried over an update', () => {
      it('Then TREE is carried iff no node repeats a child name', () => {
        // Arrange
        const sut = carryExtensions;
        const change = {
          changedPaths: [{ path: 'zz' as FilePath }],
          trackedSetChanged: false,
          resolvedUnmerged: false,
        };

        // Act + Assert
        fc.assert(
          fc.property(arbTreeAllowingTwins(MAX_DEPTH), (generated) => {
            const root = withName('', generated.children);
            const previous: IndexExtension[] = [
              { signature: 'TREE', data: serializeCacheTree(root, DIGEST_LENGTH) },
            ];
            const result = sut(previous, change, 'update', SETTINGS);
            expect(result.some((e) => e.signature === 'TREE')).toBe(!repeatsAChildName(root));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

describe('withResolveUndo properties', () => {
  describe('Given arbitrary prior and resolved records', () => {
    describe('When merged into the carried extensions', () => {
      it('Then REUC decodes to the recorded merge', () => {
        // Arrange
        const sut = withResolveUndo;

        // Act + Assert
        fc.assert(
          fc.property(arbRecords, arbRecords, (prior, resolved) => {
            const previous = [{ signature: 'REUC', data: serializeResolveUndo(prior) }];
            const result = sut([], previous, resolved, DIGEST_LENGTH);
            if (resolved.length === 0) return;
            const data = result.find((e) => e.signature === 'REUC')?.data as Uint8Array;
            expect(parseResolveUndo(data, DIGEST_LENGTH)).toEqual(
              recordResolveUndo(
                parseResolveUndo(previous[0]?.data as Uint8Array, DIGEST_LENGTH) ?? [],
                resolved,
              ),
            );
          }),
          { numRuns: RESOLVE_UNDO_RUNS },
        );
      });
    });

    describe('When no record was resolved', () => {
      it('Then the carried array is returned', () => {
        // Arrange
        const sut = withResolveUndo;
        const carried: IndexExtension[] = [{ signature: 'UNTR', data: new Uint8Array([1]) }];

        // Act + Assert
        fc.assert(
          fc.property(arbRecords, (prior) => {
            const previous = [{ signature: 'REUC', data: serializeResolveUndo(prior) }];
            expect(sut(carried, previous, [], DIGEST_LENGTH)).toBe(carried);
          }),
          { numRuns: RESOLVE_UNDO_RUNS },
        );
      });
    });
  });
});
