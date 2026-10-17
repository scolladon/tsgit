import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  invalidateCacheTree,
  serializeCacheTree,
} from '../../../../src/domain/git-index/cache-tree.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import {
  type IndexPath,
  indexPathOfBytes,
  splitAtSlash,
} from '../../../../src/domain/git-index/index-path-key.js';
import {
  concatBytes,
  decode,
  decodeEscapingInvalid,
} from '../../../../src/domain/objects/encoding.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbCacheTreeEntry, arbPathBytes } from './arbitraries.js';

describe('cache-tree serializer properties', () => {
  describe('Given an arbitrary CacheTreeEntry tree at width 20', () => {
    describe('When parseCacheTree(serializeCacheTree(tree))', () => {
      it('Then it returns the same tree', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCacheTreeEntry(3, 40), (tree) => {
            const sut = serializeCacheTree;
            expect(parseCacheTree(sut(tree, 20), 20)).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary CacheTreeEntry tree at width 32', () => {
    describe('When parseCacheTree(serializeCacheTree(tree))', () => {
      it('Then it returns the same tree', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCacheTreeEntry(3, 64), (tree) => {
            const sut = serializeCacheTree;
            expect(parseCacheTree(sut(tree, 32), 32)).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});

const NUM_RUNS = 100;
const RANDOM_COMPONENTS = ['q', 'r', 'zz'];

function componentNames(tree: CacheTreeEntry): string[] {
  return tree.children.flatMap((child) => [child.path, ...componentNames(child)]);
}

function arbPaths(tree: CacheTreeEntry): fc.Arbitrary<IndexPath[]> {
  const names = [...componentNames(tree).filter((n) => n !== ''), ...RANDOM_COMPONENTS];
  const arbPath = fc
    .array(fc.constantFrom(...names), { minLength: 1, maxLength: 4 })
    .map((parts) => ({ path: parts.join('/') as FilePath }));
  return fc.array(arbPath, { maxLength: 4 });
}

function arbTreeWithPaths(
  hexLength: 40 | 64,
): fc.Arbitrary<{ tree: CacheTreeEntry; paths: IndexPath[] }> {
  return arbCacheTreeEntry(3, hexLength).chain((tree) =>
    arbPaths(tree).map((paths) => ({ tree, paths })),
  );
}

function coversPath(node: CacheTreeEntry, components: ReadonlyArray<string>): boolean {
  const [head, ...rest] = components;
  const child = node.children.find((c) => c.path === head);
  if (child === undefined) return node.entryCount >= 0;
  if (rest.length === 0) return true;
  return node.entryCount >= 0 || coversPath(child, rest);
}

function invalidatedOnce(
  entry: CacheTreeEntry,
  children: ReadonlyArray<CacheTreeEntry>,
): CacheTreeEntry {
  return {
    path: entry.path,
    entryCount: -1,
    subtreeCount: entry.subtreeCount - (entry.children.length - children.length),
    children,
  };
}

function oracleAlong(entry: CacheTreeEntry, components: ReadonlyArray<string>): CacheTreeEntry {
  const [head, ...rest] = components;
  const index = entry.children.findIndex((child) => child.path === head);
  const child = entry.children[index];
  if (child === undefined) return invalidatedOnce(entry, entry.children);
  const next = rest.length === 0 ? undefined : oracleAlong(child, rest);
  const children =
    next === undefined
      ? entry.children.filter((_, i) => i !== index)
      : entry.children.map((c, i) => (i === index ? next : c));
  return invalidatedOnce(entry, children);
}

describe('invalidateCacheTree properties', () => {
  describe('Given an arbitrary tree and paths built from its component names', () => {
    describe('When invalidateCacheTree', () => {
      it('Then no valid node covers a changed path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTreeWithPaths(40), ({ tree, paths }) => {
            const sut = invalidateCacheTree;
            const result = sut(tree, paths);
            for (const path of paths) {
              expect(coversPath(result, path.path.split('/'))).toBe(false);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then a root subtree no path enters is the same object', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTreeWithPaths(40), ({ tree, paths }) => {
            const sut = invalidateCacheTree;
            const entered = new Set(paths.map((p) => p.path.split('/')[0]));
            const result = sut(tree, paths);
            for (const child of tree.children) {
              if (!entered.has(child.path)) expect(result.children).toContain(child);
            }
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then the single pass equals folding the per-path invalidation', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTreeWithPaths(40), ({ tree, paths }) => {
            const sut = invalidateCacheTree;
            const expected = paths.reduce(
              (acc, path) => oracleAlong(acc, path.path.split('/')),
              tree,
            );
            expect(sut(tree, paths)).toEqual(expected);
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then applying it twice equals applying it once', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTreeWithPaths(40), ({ tree, paths }) => {
            const sut = invalidateCacheTree;
            const once = sut(tree, paths);
            expect(sut(once, paths)).toEqual(once);
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then serialize then parse round-trips at width 20', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTreeWithPaths(40), ({ tree, paths }) => {
            const sut = invalidateCacheTree;
            const result = sut(tree, paths);
            expect(parseCacheTree(serializeCacheTree(result, 20), 20)).toEqual(result);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});

const SLASH = Uint8Array.of(0x2f);
const ID: ObjectId = 'a'.repeat(40) as ObjectId;

const rawNode = (name: Uint8Array, children: ReadonlyArray<CacheTreeEntry>): CacheTreeEntry => ({
  path: decode(name),
  nameBytes: name,
  entryCount: 1,
  subtreeCount: children.length,
  id: ID,
  children,
});

const arbRawComponents = (): fc.Arbitrary<Uint8Array[]> =>
  fc
    .uniqueArray(
      arbPathBytes()
        .map(splitAtSlash)
        .map((parts) => parts[0] as Uint8Array),
      {
        minLength: 1,
        maxLength: 4,
        selector: decodeEscapingInvalid,
      },
    )
    .map((components) => components.map((component) => component.slice()));

function keyCoversPath(node: CacheTreeEntry, components: ReadonlyArray<Uint8Array>): boolean {
  const [head, ...rest] = components;
  const child = node.children.find(
    (c) =>
      c.nameBytes !== undefined &&
      decodeEscapingInvalid(c.nameBytes) === decodeEscapingInvalid(head as Uint8Array),
  );
  if (child === undefined) return node.entryCount >= 0;
  if (rest.length === 0) return true;
  return node.entryCount >= 0 || keyCoversPath(child, rest);
}

describe('invalidateCacheTree raw-name properties', () => {
  describe('Given a tree named by raw components and changed paths built from the same bytes', () => {
    describe('When invalidateCacheTree', () => {
      it('Then no valid node covers a changed path', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbRawComponents().chain((components) =>
              fc.record({
                components: fc.constant(components),
                chains: fc.array(
                  fc.array(fc.constantFrom(...components), { minLength: 1, maxLength: 2 }),
                  {
                    maxLength: 4,
                  },
                ),
              }),
            ),
            ({ components, chains }) => {
              const sut = invalidateCacheTree;
              const tree: CacheTreeEntry = {
                path: '',
                entryCount: 1,
                subtreeCount: components.length,
                id: ID,
                children: components.map((name) =>
                  rawNode(
                    name,
                    components.map((inner) => rawNode(inner, [])),
                  ),
                ),
              };
              const joined = chains.map((chain) =>
                chain.flatMap((component, i) => (i === 0 ? [component] : [SLASH, component])),
              );
              const paths = joined.map((parts) => indexPathOfBytes(concatBytes(parts)));
              const result = sut(tree, paths);
              for (const chain of chains) expect(keyCoversPath(result, chain)).toBe(false);
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
