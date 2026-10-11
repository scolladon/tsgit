import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { computeClosure } from '../../../../../src/application/primitives/internal/closure-engine.js';
import { createObjectTypeTable } from '../../../../../src/application/primitives/internal/object-type-table.js';
import * as readObjectModule from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { ObjectId } from '../../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, seedMaxTreeDepth } from '../fixtures.js';

const AUTHOR = { name: 'A', email: 'a@x', timestamp: 1_700_000_000, timezoneOffset: '+0000' };

const blob = (ctx: Context, text: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: new TextEncoder().encode(text) });

const commit = (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  timestamp = AUTHOR.timestamp,
): Promise<ObjectId> => {
  const signature = { ...AUTHOR, timestamp };
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents,
      author: signature,
      committer: signature,
      message: 'c\n',
      extraHeaders: [],
    },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

interface RenamedDirectory {
  readonly ctx: Context;
  readonly upstream: ObjectId;
  readonly head: ObjectId;
  /** `x/`, held under `d/` upstream and moved under `e/` by head. */
  readonly moved: ObjectId;
  readonly movedBlob: ObjectId;
}

/** Upstream holds `d/x/a`; head moves `x/` under `e/` beside a new `y`. */
const renamedDirectory = async (): Promise<RenamedDirectory> => {
  const ctx = createMemoryContext();
  const movedBlob = await blob(ctx, 'a\n');
  const moved = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', movedBlob)]);
  const underD = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'x', moved)]);
  const upstream = await commit(
    ctx,
    await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'd', underD)]),
    [],
  );
  const underE = await writeTree(ctx, [
    treeEntry(FILE_MODE.DIRECTORY, 'x', moved),
    treeEntry(FILE_MODE.REGULAR, 'y', await blob(ctx, 'y\n')),
  ]);
  const head = await commit(
    ctx,
    await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'e', underE)]),
    [upstream],
  );
  return { ctx, upstream, head, moved, movedBlob };
};

describe('Given a head that moves a directory its upstream holds', () => {
  describe('When the closure marks the excluded side sparsely', () => {
    it('Then the moved directory and its contents stay in the closure, as git sparse marking leaves them', async () => {
      // Arrange
      const { ctx, upstream, head, moved, movedBlob } = await renamedDirectory();
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
        sparse: true,
      });

      // Assert
      const ids = result.objects.map((object) => object.id);
      expect(ids).toContain(moved);
      expect(ids).toContain(movedBlob);
      expect(ids).toHaveLength(6);
    });
  });

  describe('When the closure marks the excluded side densely', () => {
    it('Then every object the upstream tree reaches is excluded', async () => {
      // Arrange
      const { ctx, upstream, head, moved, movedBlob } = await renamedDirectory();
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
      });

      // Assert
      const ids = result.objects.map((object) => object.id);
      expect(ids).not.toContain(moved);
      expect(ids).not.toContain(movedBlob);
      expect(ids).toHaveLength(4);
    });
  });
});

describe('Given a head that renames a file its upstream holds at the root', () => {
  describe('When the closure marks the excluded side sparsely', () => {
    it('Then the file stays excluded, as a child of an excluded tree is marked whatever its path', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const kept = await blob(ctx, 'k\n');
      const upstream = await commit(
        ctx,
        await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', kept)]),
        [],
      );
      const head = await commit(
        ctx,
        await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'b', kept)]),
        [upstream],
      );
      const sut = computeClosure;

      // Act
      const result = await sut(ctx, {
        wants: [head],
        not: [upstream],
        objects: true,
        tier: 'walk',
        sparse: true,
      });

      // Assert
      expect(result.objects.map((object) => object.id)).not.toContain(kept);
    });
  });
});

describe('closure sparse marking under typing', () => {
  interface Typed {
    readonly ctx: Context;
    readonly logged: string[];
    readonly stray: ObjectId;
    readonly other: ObjectId;
    readonly empty: ObjectId;
  }

  const typedRepo = async (): Promise<Typed> => {
    const logged: string[] = [];
    const base = createMemoryContext();
    const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
    const stray = await blob(ctx, 'hi\n');
    const other = await blob(ctx, 'yo\n');
    return { ctx, logged, stray, other, empty: await writeTree(ctx, []) };
  };

  const subNaming = (ctx: Context, id: ObjectId): Promise<ObjectId> =>
    writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', id)]);

  const sparseClosure = (ctx: Context, want: ObjectId, excluded: ObjectId): Promise<unknown> =>
    computeClosure(ctx, {
      wants: [want],
      not: [excluded],
      objects: true,
      tier: 'walk',
      sparse: true,
      objectTypes: createObjectTypeTable(),
    }).then(
      (result) => result.objects.map((object) => object.id),
      (error: unknown) => (error as TsgitError).data,
    );

  describe.each([
    [
      'names a blob as its tree',
      async ({ stray, empty }: Typed) => ({ excludedTree: empty, includedTree: stray }),
    ],
    [
      'holds a blob as a subtree the excluded tree holds as a tree',
      async ({ ctx, stray, other }: Typed) => {
        const good = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', other)]);
        return {
          excludedTree: await subNaming(ctx, good),
          includedTree: await subNaming(ctx, stray),
        };
      },
    ],
  ] as const)('Given an included commit that %s', (_label, treesOf) => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then sparse marking and the listing each fail to parse the blob as a tree', async () => {
        // Arrange
        const repo = await typedRepo();
        const { ctx, logged, stray } = repo;
        const { excludedTree, includedTree } = await treesOf(repo);
        const excluded = await commit(ctx, excludedTree, []);
        const included = await commit(ctx, includedTree, [excluded]);
        const sut = sparseClosure;

        // Act
        const result = await sut(ctx, included, excluded);

        // Assert
        expect({ result, logged }).toEqual({
          result: { code: 'BAD_TREE_OBJECT', id: stray },
          logged: [`Object ${stray} not a tree`, `Object ${stray} not a tree`],
        });
      });
    });
  });

  describe('Given an excluded commit that names a blob as its tree', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then sparse marking logs the blob is not a tree and the closure lists the included side', async () => {
        // Arrange
        const { ctx, logged, stray, other } = await typedRepo();
        const good = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', other)]);
        const excluded = await commit(ctx, stray, []);
        const included = await commit(ctx, good, [excluded]);
        const sut = sparseClosure;

        // Act
        const result = await sut(ctx, included, excluded);

        // Assert
        expect({ result, logged }).toEqual({
          result: [included, good, other],
          logged: [`Object ${stray} not a tree`],
        });
      });
    });
  });

  describe('Given an excluded tree holding a blob as a subtree the included tree holds as a file', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then marking types the blob a tree and the included entry is not a blob', async () => {
        // Arrange
        const { ctx, logged, stray, other } = await typedRepo();
        const good = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', other)]);
        const excluded = await commit(ctx, await subNaming(ctx, stray), []);
        const includedTree = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'f', stray),
          treeEntry(FILE_MODE.DIRECTORY, 'sub', good),
        ]);
        const included = await commit(ctx, includedTree, [excluded]);
        const sut = sparseClosure;

        // Act
        const result = await sut(ctx, included, excluded);

        // Assert
        expect({ result, logged }).toEqual({
          result: {
            code: 'TREE_ENTRY_TYPE_MISMATCH',
            tree: includedTree,
            entry: 'f',
            mode: 'blob',
          },
          logged: [`Object ${stray} not a tree`, `object ${stray} is a tree, not a blob`],
        });
      });
    });
  });

  describe('Given a group of subtrees one of which an excluded tree typed a blob', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then marking, the group lookup and the descent each log the blob is not a tree', async () => {
        // Arrange
        const { ctx, logged, stray, other } = await typedRepo();
        const firstExcluded = await commit(
          ctx,
          await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'f', stray),
            treeEntry(FILE_MODE.DIRECTORY, 'sub', await writeTree(ctx, [])),
          ]),
          [],
        );
        const secondExcluded = await commit(ctx, await subNaming(ctx, stray), []);
        const includedSub = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', other)]);
        const included = await commit(ctx, await subNaming(ctx, includedSub), [
          firstExcluded,
          secondExcluded,
        ]);
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [included],
          not: [firstExcluded, secondExcluded],
          objects: true,
          tier: 'walk',
          sparse: true,
          objectTypes: createObjectTypeTable(),
        });

        // Assert
        expect({ ids: result.objects.map(({ id }) => id), logged }).toEqual({
          ids: [included, await subNaming(ctx, includedSub), includedSub, other],
          logged: [
            `object ${stray} is a blob, not a tree`,
            `object ${stray} is a blob, not a tree`,
            `object ${stray} is a blob, not a tree`,
          ],
        });
      });
    });
  });
});

describe('closure sparse marking over the commits the limited walk lists', () => {
  describe('Given a listed commit the excluded line reaches only through an older commit', () => {
    describe.each([
      { sparse: true, blobListed: false },
      { sparse: false, blobListed: true },
    ])(
      'When the closure marks the excluded side with sparse: $sparse',
      ({ sparse, blobListed }) => {
        it(`Then the blob only its excluded ancestor holds is ${blobListed ? 'listed' : 'excluded'}`, async () => {
          // Arrange
          const ctx = createMemoryContext();
          const shared = await blob(ctx, 'shared\n');
          const rootTree = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'a', shared)]);
          const midTree = await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'b', await blob(ctx, 'b\n')),
          ]);
          const tipTree = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'w', shared)]);
          const excludedTree = await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'c', await blob(ctx, 'c\n')),
          ]);
          const root = await commit(ctx, rootTree, [], 100);
          const mid = await commit(ctx, midTree, [root], 900);
          const excludedParent = await commit(ctx, excludedTree, [mid], 300);
          const excluded = await commit(ctx, excludedTree, [excludedParent], 500);
          const tip = await commit(ctx, tipTree, [mid], 1000);
          const sut = computeClosure;

          // Act
          const result = await sut(ctx, {
            wants: [tip],
            not: [excluded],
            objects: true,
            tier: 'walk',
            sparse,
          });

          // Assert
          expect(result.objects.map(({ id }) => id).includes(shared)).toBe(blobListed);
        });
      },
    );
  });
});

describe('closure sparse marking depth', () => {
  const MAX_DEPTH = 2;

  /** `levels` nested directories around a leaf tree holding one blob. */
  const nested = async (ctx: Context, levels: number, text: string): Promise<ObjectId> => {
    let current = await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', await blob(ctx, text))]);
    for (let level = 0; level < levels; level += 1) {
      current = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'sub', current)]);
    }
    return current;
  };

  const sparseClosureAtDepth = async (levels: number, maxCount?: number): Promise<unknown> => {
    const ctx = await buildSeededContext();
    await seedMaxTreeDepth(ctx, String(MAX_DEPTH));
    const excluded = await commit(ctx, await nested(ctx, levels, 'excluded\n'), [], 100);
    const included = await commit(ctx, await nested(ctx, levels, 'included\n'), [excluded], 200);
    const tip = await commit(ctx, await nested(ctx, 0, 'tip\n'), [included], 300);
    return computeClosure(ctx, {
      wants: [tip],
      not: [excluded],
      objects: true,
      tier: 'walk',
      sparse: true,
      ...(maxCount === undefined ? {} : { maxCount }),
    }).then(
      (result) => result.objects.length,
      (error: unknown) => (error as TsgitError).data,
    );
  };

  describe('Given both sides nesting directories exactly core.maxTreeDepth deep', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then it completes', async () => {
        // Arrange
        const sut = sparseClosureAtDepth;

        // Act
        const result = await sut(MAX_DEPTH);

        // Assert
        expect(result).toBe(MAX_DEPTH + 6);
      });
    });
  });

  describe('Given both sides nesting directories one level past core.maxTreeDepth, under a count that lists only the shallow tip', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then it refuses with TREE_DEPTH_EXCEEDED at that depth, as marking sees every commit the walk keeps', async () => {
        // Arrange
        const sut = sparseClosureAtDepth;

        // Act
        const result = await sut(MAX_DEPTH + 1, 1);

        // Assert
        expect(result).toEqual({ code: 'TREE_DEPTH_EXCEEDED', depth: MAX_DEPTH + 1 });
      });
    });
  });
});

describe('closure sparse marking groups', () => {
  describe('Given a subtree only the included commit holds', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then marking never reads that subtree, only the listing does', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const onlyTree = await writeTree(ctx, [
          treeEntry(FILE_MODE.REGULAR, 'g', await blob(ctx, 'only\n')),
        ]);
        const excluded = await commit(
          ctx,
          await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', await blob(ctx, 'e\n'))]),
          [],
        );
        const included = await commit(
          ctx,
          await writeTree(ctx, [
            treeEntry(FILE_MODE.REGULAR, 'f', await blob(ctx, 'i\n')),
            treeEntry(FILE_MODE.DIRECTORY, 'only', onlyTree),
          ]),
          [excluded],
        );
        const readSpy = vi.spyOn(readObjectModule, 'readObject');
        const sut = computeClosure;

        // Act
        await sut(ctx, {
          wants: [included],
          not: [excluded],
          objects: true,
          tier: 'walk',
          sparse: true,
        });

        // Assert
        const reads = readSpy.mock.calls.filter((call) => call[1] === onlyTree);
        expect(reads).toHaveLength(1);
      });
    });
  });

  describe('Given an excluded tree whose gitlink names the oid the included tree holds as a blob', () => {
    describe('When the closure marks the excluded side sparsely', () => {
      it('Then the gitlink is not read as a blob, so the included blob is still listed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const shared = await blob(ctx, 'shared\n');
        const excluded = await commit(
          ctx,
          await writeTree(ctx, [treeEntry(FILE_MODE.GITLINK, 'sub', shared)]),
          [],
        );
        const included = await commit(
          ctx,
          await writeTree(ctx, [treeEntry(FILE_MODE.REGULAR, 'f', shared)]),
          [excluded],
        );
        const sut = computeClosure;

        // Act
        const result = await sut(ctx, {
          wants: [included],
          not: [excluded],
          objects: true,
          tier: 'walk',
          sparse: true,
        });

        // Assert
        expect(result.objects.map(({ id }) => id)).toContain(shared);
      });
    });
  });
});
