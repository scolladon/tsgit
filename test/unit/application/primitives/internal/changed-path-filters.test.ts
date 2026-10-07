import { describe, expect, it } from 'vitest';
import {
  changedPathFilters,
  firstParentChangedPaths,
  storedFilterLookup,
} from '../../../../../src/application/primitives/internal/changed-path-filters.js';
import type { LocalGraphLayer } from '../../../../../src/application/primitives/internal/local-commit-graph-layers.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import {
  type BloomFilterSettings,
  changedPathFilter,
  DEFAULT_BLOOM_FILTER_SETTINGS,
} from '../../../../../src/domain/commit/bloom-filter.js';
import { parseCommitGraphLayer } from '../../../../../src/domain/commit/commit-graph.js';
import { serializeCommitGraph } from '../../../../../src/domain/commit/commit-graph-writer.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { FILE_MODE, type ObjectId, SHA1_CONFIG } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const IDENTITY = {
  name: 'Test',
  email: 'test@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const NO_LIMIT = 512;

const text = (paths: readonly Uint8Array[]): string[] =>
  paths.map((path) => new TextDecoder().decode(path));

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const commitOf = (ctx: Context, tree: ObjectId, parents: readonly ObjectId[]): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: IDENTITY, committer: IDENTITY, message: 'm', extraHeaders: [] },
  });

describe('firstParentChangedPaths', () => {
  describe('Given a root tree with a nested file', () => {
    describe('When diffed against no parent', () => {
      it('Then every leaf is a changed path, in tree order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leaf = await blob(ctx, 'x');
        const inner = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'b', leaf)]);
        const root = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', leaf),
          treeEntry(FILE_MODE.DIRECTORY, 'd', inner),
        ]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, root, undefined, NO_LIMIT);

        // Assert
        expect(text(result)).toEqual(['a', 'd/b']);
      });
    });
  });

  describe('Given a parent and a child that edits one file of two subtrees', () => {
    describe('When diffed', () => {
      it('Then only the edited leaf is reported, the untouched subtree skipped', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [x, y] = [await blob(ctx, 'x'), await blob(ctx, 'y')];
        const kept = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'k', x)]);
        const before = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', x)]);
        const after = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', y)]);
        const parent = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'e', before),
          treeEntry(FILE_MODE.DIRECTORY, 'k', kept),
        ]);
        const child = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'e', after),
          treeEntry(FILE_MODE.DIRECTORY, 'k', kept),
        ]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, child, parent, NO_LIMIT);

        // Assert
        expect(text(result)).toEqual(['e/f']);
      });
    });
  });

  describe('Given a file replaced by a directory of the same name, and a removed directory', () => {
    describe('When diffed', () => {
      it('Then the file, the new leaves and the removed leaves are each reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const x = await blob(ctx, 'x');
        const sub = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'y', x)]);
        const parent = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'gone', sub),
          treeEntry(FILE_MODE.REGULAR, 'p', x),
        ]);
        const child = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'p', sub)]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, child, parent, NO_LIMIT);

        // Assert
        expect(text(result)).toEqual(['gone/y', 'p', 'p/y']);
      });
    });
  });

  describe('Given a file whose mode alone changes', () => {
    describe('When diffed', () => {
      it('Then it is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const x = await blob(ctx, 'x');
        const parent = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'run', x)]);
        const child = await writeTree(ctx, [treeEntry(FILE_MODE.EXECUTABLE, 'run', x)]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, child, parent, NO_LIMIT);

        // Assert
        expect(text(result)).toEqual(['run']);
      });
    });
  });

  describe('Given a raw high-bit entry name', () => {
    describe('When diffed against no parent', () => {
      it('Then the path keeps its bytes undecoded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const x = await blob(ctx, 'x');
        const name = Uint8Array.of(0xe9, 0xff);
        const root = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, name, x)]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, root, undefined, NO_LIMIT);

        // Assert
        expect(result).toEqual([name]);
      });
    });
  });

  describe('Given more changed leaves than the limit, spread over subtrees', () => {
    describe('When diffed', () => {
      it('Then the walk stops one path past the limit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const x = await blob(ctx, 'x');
        const pair = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'a', x),
          treeEntry(FILE_MODE.REGULAR, 'b', x),
        ]);
        const root = await writeTree(ctx, [
          treeEntry(FILE_MODE.DIRECTORY, 'd1', pair),
          treeEntry(FILE_MODE.DIRECTORY, 'd2', pair),
          treeEntry(FILE_MODE.REGULAR, 'z', x),
        ]);
        const sut = firstParentChangedPaths;

        // Act
        const result = await sut(ctx, root, undefined, 2);

        // Assert
        expect(text(result)).toEqual(['d1/a', 'd1/b', 'd2/a']);
      });
    });
  });
});

describe('changedPathFilters', () => {
  describe('Given a commit whose parent is written alongside it and one whose parent is not', () => {
    describe('When their filters are computed', () => {
      it("Then each filter hashes the diff against its first parent's tree", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [x, y] = [await blob(ctx, 'x'), await blob(ctx, 'y')];
        const firstTree = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', x)]);
        const secondTree = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f', x),
          treeEntry(FILE_MODE.REGULAR, 'g', y),
        ]);
        const outside = await commitOf(ctx, firstTree, []);
        const middle = await commitOf(ctx, secondTree, [outside]);
        const tip = await commitOf(ctx, firstTree, [middle]);
        const commits = [
          { id: tip, rootTree: firstTree, parents: [middle], committerDate: 1 },
          { id: middle, rootTree: secondTree, parents: [outside], committerDate: 1 },
        ];
        const sut = changedPathFilters;

        // Act
        const result = await sut(ctx, commits, DEFAULT_BLOOM_FILTER_SETTINGS);

        // Assert
        const onlyG = changedPathFilter(
          [new TextEncoder().encode('g')],
          DEFAULT_BLOOM_FILTER_SETTINGS,
        );
        expect(result).toEqual(
          new Map([
            [tip, onlyG],
            [middle, onlyG],
          ]),
        );
      });
    });
  });

  describe('Given a commit whose first parent outside the write is not a commit', () => {
    describe('When its filter is computed', () => {
      it('Then it refuses with the unexpected object type', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await writeTree(ctx, []);
        const id = 'c'.repeat(40) as ObjectId;
        const commits = [{ id, rootTree: tree, parents: [tree], committerDate: 1 }];
        const sut = changedPathFilters;

        // Act
        const result = await sut(ctx, commits, DEFAULT_BLOOM_FILTER_SETTINGS).catch(
          (error: TsgitError) => error.data,
        );

        // Assert
        expect(result).toMatchObject({ code: 'UNEXPECTED_OBJECT_TYPE', expected: 'commit' });
      });
    });
  });
});

describe('storedFilterLookup', () => {
  const V2: BloomFilterSettings = { ...DEFAULT_BLOOM_FILTER_SETTINGS, hashVersion: 2 };
  const idOf = (char: string): ObjectId => char.repeat(40) as ObjectId;

  /** A layer holding one commit `id`, its stored filter `filter`, at `settings` (none when undefined). */
  const layerWith = (
    id: ObjectId,
    filter: Uint8Array,
    settings: BloomFilterSettings | undefined,
  ): LocalGraphLayer => {
    const commit = { id, rootTree: id, parents: [], committerDate: 1 };
    const changedPaths = settings && { settings, filters: new Map([[id, filter]]) };
    const bytes = serializeCommitGraph([commit], SHA1_CONFIG, undefined, changedPaths);
    return { hash: id, path: `graph-${id}`, layer: parseCommitGraphLayer(bytes), local: true };
  };

  describe('Given a base layer at other settings under a top layer at the written ones', () => {
    const base = layerWith(idOf('a'), Uint8Array.of(0x01), { ...V2, numHashes: 3 });
    const top = layerWith(idOf('b'), Uint8Array.of(0x02), V2);

    describe.each([
      { label: "the top layer's commit", id: idOf('b'), expected: [0x02] },
      { label: "the mismatched base layer's commit", id: idOf('a'), expected: undefined },
      { label: 'a commit no layer holds', id: idOf('c'), expected: undefined },
    ])('When $label is looked up', ({ id, expected }) => {
      it(`Then the stored filter is ${expected ? 'returned' : 'not reused'}`, () => {
        // Arrange
        const sut = storedFilterLookup;

        // Act
        const result = sut([base, top], V2)(id);

        // Assert
        expect(result && [...result]).toEqual(expected);
      });
    });
  });

  describe.each([
    { label: 'no layer storing filters', settings: undefined },
    { label: 'filters stored at another hash version', settings: DEFAULT_BLOOM_FILTER_SETTINGS },
  ])('Given $label', ({ settings }) => {
    describe('When a held commit is looked up', () => {
      it('Then nothing is reused', () => {
        // Arrange
        const layers = [layerWith(idOf('a'), Uint8Array.of(0x01), settings)];
        const sut = storedFilterLookup;

        // Act
        const result = sut(layers, V2)(idOf('a'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('changedPathFilters, with stored filters', () => {
  describe.each([
    { label: 'a non-empty stored filter', stored: Uint8Array.of(0xab), reused: true },
    { label: 'an empty stored filter', stored: new Uint8Array(0), reused: false },
  ])('Given $label for a root commit', ({ stored, reused }) => {
    describe('When its filter is computed', () => {
      it(`Then the stored bytes are ${reused ? 'copied' : 'replaced by a recompute'}`, async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree = await writeTree(ctx, []);
        const id = 'c'.repeat(40) as ObjectId;
        const sut = changedPathFilters;

        // Act
        const result = await sut(
          ctx,
          [{ id, rootTree: tree, parents: [], committerDate: 1 }],
          DEFAULT_BLOOM_FILTER_SETTINGS,
          () => stored,
        );

        // Assert
        expect([...result.get(id)!]).toEqual(reused ? [0xab] : [0x00]);
      });
    });
  });
});
