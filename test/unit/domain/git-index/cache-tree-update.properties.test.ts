import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  invalidateCacheTree,
  serializeCacheTree,
} from '../../../../src/domain/git-index/cache-tree.js';
import {
  type CacheTreePlan,
  compareSubtreeNames,
  planCacheTree,
  toCacheTreeEntry,
} from '../../../../src/domain/git-index/cache-tree-update.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import { splitAtSlash } from '../../../../src/domain/git-index/index-path-key.js';
import { decode, encode } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbSortedStage0Entries } from './arbitraries.js';

const FAKE_ID = '1'.repeat(40) as ObjectId;
const allIds = (plan: CacheTreePlan): ObjectId[] => plan.nodes.map(() => FAKE_ID);
const nameOf = (plan: CacheTreePlan, i: number): string =>
  decode(plan.nodes[i]?.nameBytes ?? encode(''));

const directoriesOf = (paths: ReadonlyArray<string>): Set<string> => {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  return directories;
};

const pathsOfNodes = (plan: CacheTreePlan): string[] => {
  const paths: string[] = [];
  const walk = (index: number, prefix: string): void => {
    for (const child of plan.nodes[index]?.children ?? []) {
      const path = prefix === '' ? nameOf(plan, child) : `${prefix}/${nameOf(plan, child)}`;
      paths.push(path);
      walk(child, path);
    }
  };
  walk(0, '');
  return paths;
};

describe('planCacheTree properties', () => {
  describe('Given arbitrary sorted stage-0 entries', () => {
    describe('When planning without a carried tree', () => {
      it('Then every directory has exactly one node', () => {
        fc.assert(
          fc.property(arbSortedStage0Entries(), (entries) => {
            // Arrange
            const sut = planCacheTree;

            // Act
            const result = pathsOfNodes(sut(entries, undefined));

            // Assert
            const expected = [...directoriesOf(entries.map((e) => e.path))];
            expect([...result].sort()).toEqual(expected.sort());
          }),
          { numRuns: 100 },
        );
      });

      it('Then the root entry count is the number of entries', () => {
        fc.assert(
          fc.property(arbSortedStage0Entries(), (entries) => {
            // Arrange
            const sut = planCacheTree;

            // Act
            const result = sut(entries, undefined);

            // Assert
            expect(result.nodes[0]?.entryCount).toBe(entries.length);
          }),
          { numRuns: 100 },
        );
      });

      it('Then children are strictly ordered by subtree name order', () => {
        fc.assert(
          fc.property(arbSortedStage0Entries(), (entries) => {
            // Arrange
            const sut = planCacheTree;

            // Act
            const result = sut(entries, undefined);

            // Assert
            for (const node of result.nodes) {
              const names = node.children.map((c) => result.nodes[c]?.nameBytes as Uint8Array);
              names.slice(1).forEach((name, i) => {
                expect(compareSubtreeNames(names[i] as Uint8Array, name)).toBeLessThan(0);
              });
            }
          }),
          { numRuns: 100 },
        );
      });

      it('Then the emitted tree round-trips through the serializer', () => {
        fc.assert(
          fc.property(arbSortedStage0Entries(), (entries) => {
            // Arrange
            const plan = planCacheTree(entries, undefined);
            const emitted = toCacheTreeEntry(plan, allIds(plan));

            const sut = parseCacheTree;

            // Act
            const result = sut(serializeCacheTree(emitted, 20), 20);

            // Assert
            expect(result).toEqual(emitted);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When re-planning with its own plan as the carried tree', () => {
      it('Then nothing is built and the root is reused', () => {
        fc.assert(
          fc.property(arbSortedStage0Entries(), (entries) => {
            // Arrange
            const plan = planCacheTree(entries, undefined);
            const carried = toCacheTreeEntry(plan, allIds(plan));

            const sut = planCacheTree;

            // Act
            const result = sut(entries, carried);

            // Assert
            expect(result.builds).toEqual([]);
            expect(result.nodes[0]?.reused).toBe(FAKE_ID);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When a changed path invalidates the carried tree', () => {
      it('Then the directories on its chain are builds and the root is rebuilt', () => {
        fc.assert(
          fc.property(
            arbSortedStage0Entries().filter((entries) => entries.length > 0),
            fc.nat(),
            (entries, pick) => {
              // Arrange
              const changed = entries[pick % entries.length];
              const plan = planCacheTree(entries, undefined);
              const carried = invalidateCacheTree(toCacheTreeEntry(plan, allIds(plan)), [
                { path: changed?.path as never },
              ]);

              const sut = planCacheTree;

              // Act
              const result = sut(entries, carried);

              // Assert
              const built = new Set(result.builds.map((b) => b.node));
              const chain = splitAtSlash(encode(changed?.path ?? '')).slice(0, -1);
              expect(built.has(0)).toBe(true);
              let node = 0;
              for (const part of chain) {
                node = (result.nodes[node]?.children ?? []).find(
                  (c) => nameOf(result, c) === decode(part),
                ) as number;
                expect(built.has(node)).toBe(true);
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
