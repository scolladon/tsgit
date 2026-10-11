import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  assertBoundaryCommit,
  type BundleCreateOptions,
  type BundleCreateResult,
  bundleCreate,
  selectBundleVersion,
} from '../../../../src/application/commands/bundle-create.js';
import * as buildPackMod from '../../../../src/application/primitives/build-pack.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import * as enumerateBundleObjectsMod from '../../../../src/application/primitives/enumerate-bundle-objects.js';
import * as closureEngineMod from '../../../../src/application/primitives/internal/closure-engine.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type GitObject,
  type ObjectId,
  type Tag,
} from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { packNameHash } from '../../../../src/domain/storage/index.js';
import type { Context } from '../../../../src/ports/context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const AUTHOR: AuthorIdentity = {
  name: 'Test',
  email: 't@t.com',
  timestamp: 1_000_000_000,
  timezoneOffset: '+0000',
};

const BLOB_MODE = '100644' as FileMode;

const enc = new TextEncoder();

const makeBlob = async (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: enc.encode(content),
  });

const makeCommitObj = async (
  ctx: Context,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
  ts: number,
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message,
  });

const setRef = async (ctx: Context, refPath: string, oid: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${refPath}`, `${oid}\n`);

const initRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

const initRepoWithAlgorithm = async (algorithm: 'sha1' | 'sha256'): Promise<Context> => {
  const ctx = createMemoryContext({ algorithm });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

// ─────────────────────────────────────────────────────────────────────────────
// Repo fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface SingleCommitRepo {
  readonly ctx: Context;
  readonly commit1: ObjectId;
}

const buildSingleCommitRepo = async (): Promise<SingleCommitRepo> => {
  const ctx = await initRepo();
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'initial commit', 1);
  await setRef(ctx, 'refs/heads/main', commit1);
  return { ctx, commit1 };
};

const buildSingleCommitRepoWithAlgorithm = async (
  algorithm: 'sha1' | 'sha256',
): Promise<SingleCommitRepo> => {
  const ctx = await initRepoWithAlgorithm(algorithm);
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'initial commit', 1);
  await setRef(ctx, 'refs/heads/main', commit1);
  return { ctx, commit1 };
};

interface TwoCommitRepo {
  readonly ctx: Context;
  readonly commit1: ObjectId;
  readonly commit2: ObjectId;
}

const buildTwoCommitRepo = async (): Promise<TwoCommitRepo> => {
  const ctx = await initRepo();
  const tree1 = await writeTree(ctx, []);
  const commit1 = await makeCommitObj(ctx, tree1, [], 'first commit', 1);
  const blob = await makeBlob(ctx, 'hello');
  const tree2 = await writeTree(ctx, [treeEntry(BLOB_MODE, 'a.txt', blob)]);
  const commit2 = await makeCommitObj(ctx, tree2, [commit1], 'second commit', 2);
  await setRef(ctx, 'refs/heads/main', commit2);
  return { ctx, commit1, commit2 };
};

interface DivergentRepo {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly mainCommit: ObjectId;
  readonly featureCommit: ObjectId;
}

const buildDivergentRepo = async (): Promise<DivergentRepo> => {
  const ctx = await initRepo();
  const tree0 = await writeTree(ctx, []);
  const base = await makeCommitObj(ctx, tree0, [], 'base commit', 1);
  const blobM = await makeBlob(ctx, 'main');
  const treeM = await writeTree(ctx, [treeEntry(BLOB_MODE, 'm.txt', blobM)]);
  const mainCommit = await makeCommitObj(ctx, treeM, [base], 'main change', 2);
  const blobF = await makeBlob(ctx, 'feat');
  const treeF = await writeTree(ctx, [treeEntry(BLOB_MODE, 'f.txt', blobF)]);
  const featureCommit = await makeCommitObj(ctx, treeF, [base], 'feature change', 3);
  await setRef(ctx, 'refs/heads/main', mainCommit);
  await setRef(ctx, 'refs/heads/feature', featureCommit);
  return { ctx, base, mainCommit, featureCommit };
};

interface NonCommitRefRepo {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly main: ObjectId;
  readonly baseTree: ObjectId;
}

const makeTagOf = async (
  ctx: Context,
  object: ObjectId,
  objectType: Tag['data']['objectType'],
  tagName: string,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tag',
    id: '' as ObjectId,
    data: { object, objectType, tagName, message: tagName, extraHeaders: [] },
  });

/** `base` <- `main`, `main`'s tree reusing `base`'s blob; refs name both trees, a tag of `main`'s tree and a tag of that tag. */
const buildNonCommitRefRepo = async (): Promise<NonCommitRefRepo> => {
  const ctx = await initRepo();
  const baseBlob = await makeBlob(ctx, 'base');
  const baseTree = await writeTree(ctx, [treeEntry(BLOB_MODE, 'base.txt', baseBlob)]);
  const base = await makeCommitObj(ctx, baseTree, [], 'base commit', 1);
  const mainTree = await writeTree(ctx, [
    treeEntry(BLOB_MODE, 'base.txt', baseBlob),
    treeEntry(BLOB_MODE, 'tip.txt', await makeBlob(ctx, 'tip')),
  ]);
  const main = await makeCommitObj(ctx, mainTree, [base], 'main commit', 2);
  const tagTree = await makeTagOf(ctx, mainTree, 'tree', 'tag-tree');
  await setRef(ctx, 'refs/heads/main', main);
  await setRef(ctx, 'refs/heads/base', base);
  await setRef(ctx, 'refs/tags/main-tree', mainTree);
  await setRef(ctx, 'refs/tags/base-tree', baseTree);
  await setRef(ctx, 'refs/tags/tag-tree', tagTree);
  await setRef(ctx, 'refs/tags/tag-tag', await makeTagOf(ctx, tagTree, 'tag', 'tag-tag'));
  return { ctx, base, main, baseTree };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extract the BUNDLE_EMPTY data or rethrow
// ─────────────────────────────────────────────────────────────────────────────

const catchBundleEmpty = async (
  fn: () => Promise<BundleCreateResult>,
): Promise<{ code: string; reason: string }> => {
  try {
    await fn();
    throw new Error('Expected bundleCreate to throw');
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'BUNDLE_EMPTY') {
      return err.data as { code: string; reason: string };
    }
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('bundleCreate', () => {
  // ── Repository guard ──────────────────────────────────────────────────────

  describe('Given a context that is not a git repository', () => {
    describe('When bundleCreate is called', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext(); // no HEAD written
        const opts: BundleCreateOptions = { revs: [{ tip: 'HEAD' }] };

        // Act
        let caught: unknown;
        try {
          await bundleCreate(ctx, opts);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  // ── Empty-bundle refusals ─────────────────────────────────────────────────

  describe('Given a repository with one commit on main', () => {
    describe('When bundleCreate is called with an option set that yields no bundle content', () => {
      it.each([
        {
          label: 'no revs and no pseudo-ref flags',
          buildOpts: (): BundleCreateOptions => ({}),
          reason: 'no-refs',
        },
        {
          label: 'a bare-rev tip that names no ref',
          buildOpts: (commit1: ObjectId): BundleCreateOptions => ({
            revs: [{ tip: commit1 }], // raw OID tip
          }),
          reason: 'no-refs',
        },
        {
          label: 'a range whose endpoints are equal',
          buildOpts: (): BundleCreateOptions => ({
            revs: [{ range: ['refs/heads/main', 'refs/heads/main'] }],
          }),
          reason: 'no-refs',
        },
      ])('Then throws BUNDLE_EMPTY with reason $reason ($label)', async ({ buildOpts, reason }) => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();
        const opts = buildOpts(commit1);

        // Act
        const result = await catchBundleEmpty(() => bundleCreate(ctx, opts));

        // Assert
        expect(result.code).toBe('BUNDLE_EMPTY');
        expect(result.reason).toBe(reason);
      });
    });
  });

  // ── Tips the walk leaves uninteresting ────────────────────────────────────

  describe('Given refs naming commits, trees and tags of trees', () => {
    describe.each([
      { label: 'a tree', exclude: 'main-tree' },
      { label: 'a tag of a tree', exclude: 'tag-tree' },
    ])('When bundleCreate excludes $label', ({ exclude }) => {
      it('Then it bundles main without that tree or a prerequisite', async () => {
        // Arrange
        const { ctx, main } = await buildNonCommitRefRepo();
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, { revs: [{ tip: 'main' }, { exclude }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: main }]);
        expect(result.prerequisites).toEqual([]);
        expect(result.objectCount).toBe(3);
      });
    });

    describe('When bundleCreate wants a tag of a tree the excluded tag-of-tag reaches', () => {
      it('Then it writes no ref line for that tag', async () => {
        // Arrange
        const { ctx, main } = await buildNonCommitRefRepo();
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, {
          revs: [{ tip: 'main' }, { tip: 'tag-tree' }, { exclude: 'tag-tag' }],
        });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: main }]);
      });
    });

    describe('When bundleCreate wants a commit that is an ancestor of an excluded commit', () => {
      it('Then it writes no ref line for that commit', async () => {
        // Arrange
        const { ctx, base, main } = await buildNonCommitRefRepo();
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, {
          revs: [{ tip: 'base' }, { tip: 'main' }, { exclude: 'base' }],
        });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: main }]);
        expect(result.prerequisites).toEqual([{ oid: base, comment: 'base commit' }]);
      });
    });

    describe("When bundleCreate wants the boundary commit's own tree alongside a range", () => {
      it('Then it writes that tree ref line, though the boundary keeps the tree out of the pack', async () => {
        // Arrange
        const { ctx, main, baseTree } = await buildNonCommitRefRepo();
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, {
          revs: [{ range: ['base', 'main'] }, { tip: 'base-tree' }],
        });

        // Assert
        expect(result.refs).toEqual([
          { name: 'refs/heads/main', oid: main },
          { name: 'refs/tags/base-tree', oid: baseTree },
        ]);
        expect(result.objectCount).toBe(3);
      });
    });
  });

  describe('Given a closure that leaves nothing to pack for a surviving ref', () => {
    describe('When bundleCreate is called', () => {
      it('Then it writes the bundle with an empty pack, as git does', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();
        const enumerateSpy = vi
          .spyOn(enumerateBundleObjectsMod, 'enumerateBundleObjects')
          .mockResolvedValue({ objects: [], boundary: [], uninteresting: new Set() });
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, { revs: [{ tip: 'main' }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: commit1 }]);
        expect(result.objectCount).toBe(0);
        enumerateSpy.mockRestore();
      });
    });
  });

  // ── Tip → ref line ────────────────────────────────────────────────────────

  describe('Given a repository with one commit on main', () => {
    describe('When bundleCreate is called with tip refs/heads/main', () => {
      it('Then returns version 2', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(result.version).toBe(2);
      });

      it('Then returns refs containing refs/heads/main', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: commit1 }]);
      });

      it('Then returns empty prerequisites', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(result.prerequisites).toEqual([]);
      });

      it('Then returns objectCount greater than zero', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(result.objectCount).toBeGreaterThan(0);
      });

      it('Then returns bytes starting with the v2 bundle magic', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        const magic = new TextEncoder().encode('# v2 git bundle\n');

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(Array.from(result.bytes.slice(0, magic.length))).toEqual(Array.from(magic));
      });

      it('Then returns packSha as a 40-char hex string', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(result.packSha).toMatch(/^[0-9a-f]{40}$/);
      });

      it('Then calls buildPack with delta: true', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        expect(buildPackSpy).toHaveBeenCalledTimes(1);
        expect(buildPackSpy.mock.calls[0]![1]).toEqual(expect.objectContaining({ delta: true }));
        buildPackSpy.mockRestore();
      });
    });

    describe('When bundleCreate is called with tip HEAD', () => {
      it('Then returns refs containing HEAD with the current commit oid', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'HEAD' }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'HEAD', oid: commit1 }]);
      });
    });

    describe('When bundleCreate is called with short name tip main', () => {
      it('Then returns refs containing refs/heads/main resolved via short-name expansion', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'main' }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: commit1 }]);
      });
    });
  });

  // ── Name hash: buildPack receives { id, nameHash } straight from the closure ──

  describe('Given a repository with one commit whose tree has a nested blob', () => {
    describe('When bundleCreate is called with tip refs/heads/main', () => {
      it('Then calls buildPack with the commit at nameHash 0 and the nested blob at its folded path hash, no recency', async () => {
        // Arrange
        const ctx = await initRepo();
        const blob = await makeBlob(ctx, 'nested content');
        const subTree = await writeTree(ctx, [treeEntry(BLOB_MODE, 'f.txt', blob)]);
        const rootTree = await writeTree(ctx, [treeEntry(FILE_MODE.DIRECTORY, 'dir', subTree)]);
        const commit1 = await makeCommitObj(ctx, rootTree, [], 'nested commit', 1);
        await setRef(ctx, 'refs/heads/main', commit1);
        const buildPackSpy = vi.spyOn(buildPackMod, 'buildPack');

        // Act
        await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });

        // Assert
        const captured = buildPackSpy.mock.calls[0]![1].objects;
        const commitInput = captured.find((object) => object.id === commit1);
        const blobInput = captured.find((object) => object.id === blob);
        expect(commitInput).toMatchObject({ id: commit1, nameHash: 0 });
        expect(blobInput).toMatchObject({
          id: blob,
          nameHash: packNameHash(new TextEncoder().encode('dir/f.txt')),
        });
        expect(captured.some((object) => object.recency !== undefined)).toBe(false);
        buildPackSpy.mockRestore();
      });
    });
  });

  // ── Annotated tag → tag-object oid in ref line ────────────────────────────

  describe('Given a repository with a commit and an annotated tag on that commit', () => {
    describe('When bundleCreate is called with tip refs/tags/v1', () => {
      it('Then returns refs containing refs/tags/v1 with the tag-object oid', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commit1,
            objectType: 'commit',
            tagName: 'v1',
            message: 'release v1',
            extraHeaders: [],
          },
        };
        const tagOid = await writeObject(ctx, tag);
        await setRef(ctx, 'refs/tags/v1', tagOid);

        // Act
        const result = await bundleCreate(ctx, { revs: [{ tip: 'refs/tags/v1' }] });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/tags/v1', oid: tagOid }]);
      });
    });
  });

  // ── Exclude → prerequisite ────────────────────────────────────────────────

  describe('Given a repository with two commits on main', () => {
    describe('When bundleCreate is called with tip refs/heads/main and exclude commit1', () => {
      it('Then prerequisites contains commit1 with its subject as comment', async () => {
        // Arrange
        const { ctx, commit1, commit2 } = await buildTwoCommitRepo();
        const opts: BundleCreateOptions = {
          revs: [{ tip: 'refs/heads/main' }, { exclude: commit1 }],
        };

        // Act
        const result = await bundleCreate(ctx, opts);

        // Assert
        expect(result.prerequisites).toEqual([{ oid: commit1, comment: 'first commit' }]);
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: commit2 }]);
      });

      it('Then objectCount is less than the full closure', async () => {
        // Arrange
        const { ctx, commit1 } = await buildTwoCommitRepo();
        const fullResult = await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });
        const partialResult = await bundleCreate(ctx, {
          revs: [{ tip: 'refs/heads/main' }, { exclude: commit1 }],
        });

        // Assert — partial bundle has fewer objects than the full bundle
        expect(partialResult.objectCount).toBeLessThan(fullResult.objectCount);
      });
    });
  });

  // ── Multi-line subject → folded prerequisite comment ─────────────────────

  describe('Given a repository where the excluded commit has a multi-line subject paragraph', () => {
    describe('When bundleCreate is called with that commit excluded', () => {
      it('Then the prerequisite comment is the full first paragraph joined with spaces', async () => {
        // Arrange — commit whose message has two non-blank subject lines, then a blank, then body
        const ctx = await initRepo();
        const tree1 = await writeTree(ctx, []);
        const commit1 = await makeCommitObj(
          ctx,
          tree1,
          [],
          'First line of subject\nSecond line of subject\n\nBody paragraph here',
          1,
        );
        const blob = await makeBlob(ctx, 'hello');
        const tree2 = await writeTree(ctx, [treeEntry(BLOB_MODE, 'a.txt', blob)]);
        const commit2 = await makeCommitObj(ctx, tree2, [commit1], 'second commit', 2);
        await setRef(ctx, 'refs/heads/main', commit2);
        const opts: BundleCreateOptions = {
          revs: [{ tip: 'refs/heads/main' }, { exclude: commit1 }],
        };

        // Act
        const result = await bundleCreate(ctx, opts);

        // Assert — the prerequisite comment must be the whole first paragraph, not just the first line
        expect(result.prerequisites).toEqual([
          { oid: commit1, comment: 'First line of subject Second line of subject' },
        ]);
      });
    });
  });

  // ── Range → prerequisite ──────────────────────────────────────────────────

  describe('Given a repository with two commits on main', () => {
    describe('When bundleCreate is called with range [commit1, refs/heads/main]', () => {
      it('Then prerequisites contains commit1 and refs contain refs/heads/main', async () => {
        // Arrange
        const { ctx, commit1, commit2 } = await buildTwoCommitRepo();
        const opts: BundleCreateOptions = {
          revs: [{ range: [commit1, 'refs/heads/main'] }],
        };

        // Act
        const result = await bundleCreate(ctx, opts);

        // Assert
        expect(result.prerequisites).toEqual([{ oid: commit1, comment: 'first commit' }]);
        expect(result.refs).toEqual([{ name: 'refs/heads/main', oid: commit2 }]);
      });
    });
  });

  // ── SymmetricRange → merge-base prerequisites ─────────────────────────────

  describe('Given a repository with main and feature branches diverging from base', () => {
    describe('When bundleCreate is called with symmetricRange [refs/heads/main, refs/heads/feature]', () => {
      it('Then prerequisites contains the merge-base (base commit) with its subject', async () => {
        // Arrange
        const { ctx, base, mainCommit, featureCommit } = await buildDivergentRepo();
        const opts: BundleCreateOptions = {
          revs: [{ symmetricRange: ['refs/heads/main', 'refs/heads/feature'] }],
        };

        // Act
        const result = await bundleCreate(ctx, opts);

        // Assert
        expect(result.prerequisites).toEqual([{ oid: base, comment: 'base commit' }]);
        expect(result.refs).toEqual([
          { name: 'refs/heads/main', oid: mainCommit },
          { name: 'refs/heads/feature', oid: featureCommit },
        ]);
      });
    });
  });

  describe('Given a symmetric range whose sides are not both commits', () => {
    describe.each([
      { left: 'tree', right: 'main', bad: ['tree'] },
      { left: 'main', right: 'tree', bad: ['tree'] },
      { left: 'tree', right: 'tree', bad: ['tree', 'tree'] },
    ])(
      'When bundleCreate is called with symmetricRange [$left, $right]',
      ({ left, right, bad }) => {
        it('Then it refuses the expression, naming each side that is no commit', async () => {
          // Arrange
          const { ctx, mainCommit } = await buildDivergentRepo();
          const tree = (await readObjectMod.readObject(ctx, mainCommit)) as {
            data: { tree: string };
          };
          const name = (side: string): string => (side === 'tree' ? tree.data.tree : side);
          const sut = bundleCreate;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, { revs: [{ symmetricRange: [name(left), name(right)] }] });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_SYMMETRIC_RANGE',
            expression: `${name(left)}...${name(right)}`,
            nonCommits: bad.map(() => ({ id: tree.data.tree, type: 'tree' })),
          });
        });
      },
    );
  });

  // ── SymmetricRange with multiple merge bases (criss-cross) ────────────────

  describe('Given a criss-cross history where main and feature share two merge bases', () => {
    describe('When bundleCreate is called with symmetricRange [refs/heads/main, refs/heads/feature]', () => {
      it('Then prerequisites list both merge bases in oid-sorted order', async () => {
        // Arrange — b1 and b2 are independent roots; main and feature each merge
        // both, so merge-base(main, feature) = { b1, b2 }. Both merges list the
        // higher-oid base first, so the boundary is discovered in DESCENDING oid
        // order — the header must still emit both, re-sorted ascending.
        const ctx = await initRepo();
        const tree = await writeTree(ctx, []);
        const b1 = await makeCommitObj(ctx, tree, [], 'base one', 1);
        const b2 = await makeCommitObj(ctx, tree, [], 'base two', 2);
        const bases = [
          { oid: b1, comment: 'base one' },
          { oid: b2, comment: 'base two' },
        ].sort((x, y) => (x.oid < y.oid ? -1 : 1));
        const [lo, hi] = bases as [(typeof bases)[number], (typeof bases)[number]];
        const mainCommit = await makeCommitObj(ctx, tree, [hi.oid, lo.oid], 'main merge', 3);
        const featureCommit = await makeCommitObj(ctx, tree, [hi.oid, lo.oid], 'feature merge', 4);
        await setRef(ctx, 'refs/heads/main', mainCommit);
        await setRef(ctx, 'refs/heads/feature', featureCommit);

        // Act
        const result = await bundleCreate(ctx, {
          revs: [{ symmetricRange: ['refs/heads/main', 'refs/heads/feature'] }],
        });

        // Assert — both bases present (all merge bases), oid-sorted ascending.
        expect(result.prerequisites).toEqual([lo, hi]);
      });
    });
  });

  // ── Bounded prerequisite building ───────────────────────────────────────

  describe('Given more excluded boundary commits than the ioBound limit', () => {
    describe('When bundleCreate builds prerequisites', () => {
      it('Then prerequisite building peaks at exactly the bound', async () => {
        // Arrange — an explicit ioBound distinct from cpuBound so a
        // bucket-swap regression (deriving the pool from the wrong bucket)
        // fails loudly. `boundary` only records an excluded commit that is
        // the DIRECT PARENT of an interesting one, so each root needs its
        // own interesting leaf; the octopus tip merges all of them so every
        // root becomes its own sibling boundary read.
        const ioBound = 3;
        const width = ioBound + 4;
        const base = await initRepo();
        const tree = await writeTree(base, []);
        const roots: ObjectId[] = [];
        const leaves: ObjectId[] = [];
        for (let i = 0; i < width; i++) {
          const root = await makeCommitObj(base, tree, [], `root ${i}`, i * 2 + 1);
          roots.push(root);
          leaves.push(await makeCommitObj(base, tree, [root], `leaf ${i}`, i * 2 + 2));
        }
        const tip = await makeCommitObj(base, tree, leaves, 'tip', width * 2 + 1);
        await setRef(base, 'refs/heads/main', tip);
        const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
        let inFlight = 0;
        let maxInFlight = 0;
        const realReadObject = readObjectMod.readObject;
        const spy = vi
          .spyOn(readObjectMod, 'readObject')
          .mockImplementation(async (spyCtx, id, opts) => {
            if (!roots.includes(id)) return realReadObject(spyCtx, id, opts);
            inFlight += 1;
            if (inFlight > maxInFlight) maxInFlight = inFlight;
            await Promise.resolve();
            inFlight -= 1;
            return realReadObject(spyCtx, id, opts);
          });

        // Act
        try {
          const result = await bundleCreate(ctx, {
            revs: [{ tip: 'refs/heads/main' }, ...roots.map((oid) => ({ exclude: oid }))],
          });

          // Assert
          expect(result.prerequisites).toHaveLength(width);
          expect(maxInFlight).toBe(ioBound);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });

  // ── --all ordering ────────────────────────────────────────────────────────

  describe('Given a repository with main, feature branches and a tag', () => {
    describe('When bundleCreate is called with all: true', () => {
      it('Then refs are sorted by full refname with HEAD appended last', async () => {
        // Arrange
        const { ctx, base, mainCommit, featureCommit } = await buildDivergentRepo();
        const blobT = await makeBlob(ctx, 'tag');
        const treeT = await writeTree(ctx, [treeEntry(BLOB_MODE, 't.txt', blobT)]);
        const tagCommit = await makeCommitObj(ctx, treeT, [base], 'tag commit', 4);
        await setRef(ctx, 'refs/tags/v1', tagCommit);

        // Act
        const result = await bundleCreate(ctx, { all: true });

        // Assert: refs sorted, HEAD last
        const refNames = result.refs.map((r) => r.name);
        expect(refNames).toEqual(['refs/heads/feature', 'refs/heads/main', 'refs/tags/v1', 'HEAD']);
        expect(result.refs.find((r) => r.name === 'refs/heads/main')?.oid).toBe(mainCommit);
        expect(result.refs.find((r) => r.name === 'refs/heads/feature')?.oid).toBe(featureCommit);
      });
    });
  });

  // ── --branches ────────────────────────────────────────────────────────────

  describe('Given a repository with main and feature branches and a tag', () => {
    describe('When bundleCreate is called with branches: true', () => {
      it('Then refs contain only refs/heads/* refs sorted by name with no HEAD', async () => {
        // Arrange
        const { ctx, mainCommit, featureCommit } = await buildDivergentRepo();
        await setRef(ctx, 'refs/tags/v1', mainCommit); // add a tag (should not appear)

        // Act
        const result = await bundleCreate(ctx, { branches: true });

        // Assert
        const refNames = result.refs.map((r) => r.name);
        expect(refNames).toEqual(['refs/heads/feature', 'refs/heads/main']);
        expect(result.refs.find((r) => r.name === 'refs/heads/main')?.oid).toBe(mainCommit);
        expect(result.refs.find((r) => r.name === 'refs/heads/feature')?.oid).toBe(featureCommit);
        expect(refNames).not.toContain('HEAD');
        expect(refNames.some((n) => (n as string).startsWith('refs/tags/'))).toBe(false);
      });
    });
  });

  // ── --tags ────────────────────────────────────────────────────────────────

  describe('Given a repository with a commit and a tag', () => {
    describe('When bundleCreate is called with tags: true', () => {
      it('Then refs contain only refs/tags/* refs with no HEAD and no branches', async () => {
        // Arrange
        const { ctx, commit1 } = await buildSingleCommitRepo();
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commit1,
            objectType: 'commit',
            tagName: 'v1',
            message: 'release v1',
            extraHeaders: [],
          },
        };
        const tagOid = await writeObject(ctx, tag);
        await setRef(ctx, 'refs/tags/v1', tagOid);

        // Act
        const result = await bundleCreate(ctx, { tags: true });

        // Assert
        const refNames = result.refs.map((r) => r.name);
        expect(refNames).toEqual(['refs/tags/v1']);
        expect(result.refs[0]?.oid).toBe(tagOid); // tag-object oid
        expect(refNames).not.toContain('HEAD');
        expect(refNames.some((n) => (n as string).startsWith('refs/heads/'))).toBe(false);
      });
    });
  });

  // ── Ref deduplication (git 2.54.0 empirical golden) ──────────────────────
  // Verified against real git 2.54.0:
  //   git bundle create test.bundle --branches --all
  //   git bundle list-heads test.bundle
  //   → refs/heads/main (from --branches, first occurrence)
  //   → HEAD            (from --all, added after refs/* dedup)
  // git emits each refname at most once in argument/first-occurrence order.

  describe('Given a repository where combined options would add the same ref twice', () => {
    describe('When bundleCreate is called with branches:true and all:true', () => {
      it('Then refs are deduplicated in first-occurrence order: refs/heads/main then HEAD', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();

        // Act
        const result = await bundleCreate(ctx, { branches: true, all: true });

        // Assert — explicit ordered golden from real git 2.54.0
        const refNames = result.refs.map((r) => r.name as string);
        expect(refNames).toEqual(['refs/heads/main', 'HEAD']);
      });
    });
  });

  describe('Given a repository whose config holds an invalid core.maxTreeDepth', () => {
    describe('When bundleCreate is called', () => {
      it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
        invalidateConfigCache(ctx);

        // Act
        let caught: unknown;
        try {
          await bundleCreate(ctx, { all: true });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          readonly code: string;
          readonly key: string;
          readonly value: string;
          readonly reason: string;
        };
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect(data.key).toBe('core.maxtreedepth');
        expect(data.value).toBe('2.5');
        expect(data.reason).toBe('invalid unit');
      });
    });
  });

  // ── Bundle version selection ──────────────────────────────────────────────

  describe('Given a SHA-256 repository', () => {
    describe('When bundleCreate runs with no version option', () => {
      it('Then the result version is 3 and the header carries @object-format=sha256', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepoWithAlgorithm('sha256');

        // Act
        const result = await bundleCreate(ctx, { all: true });

        // Assert
        expect(result.version).toBe(3);
        const headerText = new TextDecoder().decode(result.bytes.subarray(0, 38));
        expect(headerText).toBe('# v3 git bundle\n@object-format=sha256\n');
      });
    });
  });

  describe('Given a SHA-1 repository and no options', () => {
    describe('When bundleCreate runs', () => {
      it('Then the version is 2 and the header magic carries no capability line (R6)', async () => {
        // Arrange — SHA-1 output must be unaffected by version selection.
        const { ctx } = await buildSingleCommitRepoWithAlgorithm('sha1');

        // Act
        const result = await bundleCreate(ctx, { all: true });

        // Assert
        expect(result.version).toBe(2);
        const headerText = new TextDecoder().decode(result.bytes.subarray(0, 16));
        expect(headerText).toBe('# v2 git bundle\n');
      });
    });
  });

  describe('Given a SHA-1 repository and version 3 requested', () => {
    describe('When bundleCreate runs', () => {
      it('Then it writes v3 with @object-format=sha1', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepoWithAlgorithm('sha1');

        // Act
        const result = await bundleCreate(ctx, { all: true, version: 3 });

        // Assert
        expect(result.version).toBe(3);
        const headerText = new TextDecoder().decode(result.bytes.subarray(0, 36));
        expect(headerText).toBe('# v3 git bundle\n@object-format=sha1\n');
      });
    });
  });

  describe('Given a SHA-256 repository and version 2 requested', () => {
    describe('When bundleCreate runs', () => {
      it('Then it throws BUNDLE_UNSUPPORTED_VERSION with version 2 and no path (the serialize arm)', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepoWithAlgorithm('sha256');

        // Act
        let thrown: unknown;
        try {
          await bundleCreate(ctx, { all: true, version: 2 });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const data = (thrown as TsgitError).data as {
          code: string;
          version: number;
          path?: string;
        };
        expect(data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
        expect(data.version).toBe(2);
        expect(data.path).toBeUndefined();
      });
    });
  });

  describe.each([
    { label: 'version 1', requested: 1 },
    { label: 'version 4', requested: 4 },
  ])('Given a repository and $label requested', ({ requested }) => {
    describe('When bundleCreate runs', () => {
      it('Then it throws BUNDLE_UNSUPPORTED_VERSION with the requested version', async () => {
        // Arrange
        const { ctx } = await buildSingleCommitRepoWithAlgorithm('sha1');

        // Act
        let thrown: unknown;
        try {
          await bundleCreate(ctx, { all: true, version: requested as unknown as 2 });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const data = (thrown as TsgitError).data as { code: string; version: number };
        expect(data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
        expect(data.version).toBe(requested);
      });
    });
  });

  // ── Non-commit boundary object (invariant guard) ──────────────────────────
  // assertBoundaryCommit is tested in a standalone describe below because
  // triggering it through bundleCreate requires defeating readObject hash
  // verification — the invariant (boundary oids always come from
  // peel-to-commit) makes the branch structurally unreachable in normal use.

  // ── pack.depth / pack.window / pack.windowMemory eager refusal ────────────

  describe('Given a malformed pack.depth value', () => {
    describe('When bundleCreate is called', () => {
      it('Then it refuses with CONFIG_BAD_NUMERIC_VALUE before building any pack', async () => {
        // Arrange
        const { ctx } = await buildTwoCommitRepo();
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[pack]\n\tdepth = abc\n');

        // Act
        let caught: unknown;
        try {
          await bundleCreate(ctx, { revs: [{ tip: 'refs/heads/main' }] });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const err = caught as TsgitError;
        expect(err.data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        expect((err.data as { key: string }).key).toBe('pack.depth');
        expect((err.data as { reason: string }).reason).toBe('invalid unit');
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectBundleVersion — the pure version-selection rule, unit-tested directly
// ─────────────────────────────────────────────────────────────────────────────

describe('selectBundleVersion', () => {
  describe('Given algorithm sha1, no filter, no requested version', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it returns 2', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        const result = sut({ algorithm: 'sha1', filter: false });

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given algorithm sha256, no filter, no requested version', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it returns 3', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        const result = sut({ algorithm: 'sha256', filter: false });

        // Assert
        expect(result).toBe(3);
      });
    });
  });

  describe('Given algorithm sha1, a filter present, no requested version', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it returns 3 — the filter alone triggers v3, independent of the algorithm', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        const result = sut({ algorithm: 'sha1', filter: true });

        // Assert
        expect(result).toBe(3);
      });
    });
  });

  describe('Given algorithm sha1, no filter, version 2 requested', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it returns 2', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        const result = sut({ algorithm: 'sha1', filter: false, requested: 2 });

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given algorithm sha256, no filter, version 3 requested', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it returns 3', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        const result = sut({ algorithm: 'sha256', filter: false, requested: 3 });

        // Assert
        expect(result).toBe(3);
      });
    });
  });

  describe('Given algorithm sha256, no filter, version 2 requested', () => {
    describe('When selectBundleVersion runs', () => {
      it('Then it throws BUNDLE_UNSUPPORTED_VERSION with version 2', () => {
        // Arrange
        const sut = selectBundleVersion;

        // Act
        let thrown: unknown;
        try {
          sut({ algorithm: 'sha256', filter: false, requested: 2 });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const data = (thrown as TsgitError).data as { code: string; version: number };
        expect(data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
        expect(data.version).toBe(2);
      });
    });
  });

  describe.each([{ requested: 1 }, { requested: 4 }])(
    'Given requested version $requested outside {2, 3}',
    ({ requested }) => {
      describe('When selectBundleVersion runs', () => {
        it('Then it throws BUNDLE_UNSUPPORTED_VERSION with that version', () => {
          // Arrange
          const sut = selectBundleVersion;

          // Act
          let thrown: unknown;
          try {
            sut({ algorithm: 'sha1', filter: false, requested });
          } catch (err) {
            thrown = err;
          }

          // Assert
          expect(thrown).toBeInstanceOf(TsgitError);
          const data = (thrown as TsgitError).data as { code: string; version: number };
          expect(data.code).toBe('BUNDLE_UNSUPPORTED_VERSION');
          expect(data.version).toBe(requested);
        });
      });
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// assertBoundaryCommit — invariant guard
// ─────────────────────────────────────────────────────────────────────────────

describe('assertBoundaryCommit', () => {
  const FAKE_OID = 'a'.repeat(40) as ObjectId;

  describe('Given a blob object', () => {
    describe('When assertBoundaryCommit is called', () => {
      it('Then throws BUNDLE_PREREQUISITE_NOT_COMMIT with the oid and objectType', () => {
        // Arrange
        const blob: GitObject = {
          type: 'blob',
          id: FAKE_OID,
          content: new Uint8Array(),
        };

        // Act
        let thrown: unknown;
        try {
          assertBoundaryCommit(blob, FAKE_OID);
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(TsgitError);
        const tsErr = thrown as TsgitError;
        expect(tsErr.data.code).toBe('BUNDLE_PREREQUISITE_NOT_COMMIT');
        expect((tsErr.data as { oid: string }).oid).toBe(FAKE_OID);
        expect((tsErr.data as { objectType: string }).objectType).toBe('blob');
      });
    });
  });

  describe('Given a commit object', () => {
    describe('When assertBoundaryCommit is called', () => {
      it('Then returns the commit object unchanged', async () => {
        // Arrange
        const { ctx, commit1 } = await buildTwoCommitRepo();
        const { readObject } = await import(
          '../../../../src/application/primitives/read-object.js'
        );
        const commitObj = await readObject(ctx, commit1 as ObjectId);

        // Act
        const result = assertBoundaryCommit(commitObj, commit1 as ObjectId);

        // Assert
        expect(result.type).toBe('commit');
        expect(result.id).toBe(commit1);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Object types — the bundle walk and its pack-objects feed each type objects
// ─────────────────────────────────────────────────────────────────────────────

describe('bundleCreate: object types assigned while enumerating', () => {
  const MISSING = `cd${'0'.repeat(38)}` as ObjectId;

  interface TypingRepo {
    readonly ctx: Context;
    readonly logged: string[];
    readonly blob: ObjectId;
    readonly root: ObjectId;
    readonly empty: ObjectId;
  }

  const buildTypingRepo = async (): Promise<TypingRepo> => {
    const base = await initRepo();
    const logged: string[] = [];
    const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
    const blob = await makeBlob(ctx, 'hi\n');
    const empty = await writeTree(ctx, []);
    const root = await makeCommitObj(ctx, empty, [], 'root', 1);
    await setRef(ctx, 'refs/heads/root', root);
    return { ctx, logged, blob, root, empty };
  };

  /** A commit stored as spelt, naming `tree` and `parents` whatever they are. */
  const writeCommitNaming = (
    ctx: Context,
    tree: ObjectId,
    parents: ReadonlyArray<ObjectId>,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree,
        parents,
        author: { ...AUTHOR, timestamp: 2 },
        committer: { ...AUTHOR, timestamp: 2 },
        message: 'm\n',
        extraHeaders: [],
      },
    });

  const refusalOf = async (ctx: Context, opts: BundleCreateOptions): Promise<unknown> => {
    try {
      await bundleCreate(ctx, opts);
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe('Given a blob named before a branch whose commit names that blob as its tree', () => {
    describe('When bundleCreate resolves both', () => {
      it('Then the blob typing conflicts with the tree pointer and the branch is a bad object', async () => {
        // Arrange
        const { ctx, logged, blob, root } = await buildTypingRepo();
        const named = await writeCommitNaming(ctx, blob, [root]);
        await setRef(ctx, 'refs/heads/main', named);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ tip: blob }, { tip: 'main' }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: 'main' },
          logged: [
            `object ${blob} is a blob, not a tree`,
            `bad tree pointer ${blob} in commit ${named}`,
          ],
        });
      });
    });
  });

  describe('Given a blob and a commit naming that blob as its tree', () => {
    describe('When bundleCreate reads the range from the blob to the commit', () => {
      it('Then the tree pointer conflicts and the range is invalid', async () => {
        // Arrange
        const { ctx, logged, blob, root } = await buildTypingRepo();
        const named = await writeCommitNaming(ctx, blob, [root]);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ range: [blob, named] }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'INVALID_REVISION_RANGE', expression: `${blob}..${named}` },
          logged: [
            `object ${blob} is a blob, not a tree`,
            `bad tree pointer ${blob} in commit ${named}`,
          ],
        });
      });
    });

    describe('When bundleCreate reads the range from the commit to the blob', () => {
      it('Then the blob conflicts with its tree typing and the range is invalid', async () => {
        // Arrange
        const { ctx, logged, blob, root } = await buildTypingRepo();
        const named = await writeCommitNaming(ctx, blob, [root]);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ range: [named, blob] }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'INVALID_REVISION_RANGE', expression: `${named}..${blob}` },
          logged: [`object ${blob} is a tree, not a blob`],
        });
      });
    });

    describe('When bundleCreate reads the symmetric range from the blob to the commit', () => {
      it('Then the tree pointer conflicts and the symmetric difference is invalid', async () => {
        // Arrange
        const { ctx, logged, blob, root } = await buildTypingRepo();
        const named = await writeCommitNaming(ctx, blob, [root]);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ symmetricRange: [blob, named] }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: {
            code: 'INVALID_SYMMETRIC_RANGE',
            expression: `${blob}...${named}`,
            nonCommits: [],
          },
          logged: [
            `object ${blob} is a blob, not a tree`,
            `bad tree pointer ${blob} in commit ${named}`,
          ],
        });
      });
    });
  });

  describe.each([
    [['root', MISSING], `root..${MISSING}`],
    [[MISSING, 'root'], `${MISSING}..root`],
  ] as const)('Given the range %j with an end the store lacks', (range, expression) => {
    describe('When bundleCreate reads it', () => {
      it('Then the range is invalid', async () => {
        // Arrange
        const { ctx } = await buildTypingRepo();
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ range }] });

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'INVALID_REVISION_RANGE', expression });
      });
    });
  });

  describe('Given a symmetric range whose walk reaches a parent the store lacks', () => {
    describe('When bundleCreate reads it', () => {
      it("Then it logs both of git's lines and refuses the whole range as one name", async () => {
        // Arrange
        const { ctx, logged, empty } = await buildTypingRepo();
        const broken = await writeCommitNaming(ctx, empty, [MISSING]);
        await setRef(ctx, 'refs/heads/broken', broken);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ symmetricRange: ['root', 'broken'] }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: 'root...broken' },
          logged: [`Could not read ${MISSING}`, `could not parse commit ${MISSING}`],
        });
      });
    });
  });

  describe('Given a symmetric range whose walk fails and whose whole spelling names a commit', () => {
    describe('When bundleCreate reads it', () => {
      it('Then the commit the whole spelling names is the tip', async () => {
        // Arrange
        const { ctx, logged, empty, root } = await buildTypingRepo();
        const alpha = await makeCommitObj(ctx, empty, [root], 'alpha - broken', 3);
        await setRef(ctx, 'refs/heads/alpha', alpha);
        await setRef(ctx, 'refs/heads/broken', await writeCommitNaming(ctx, empty, [MISSING]));
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, {
          revs: [{ tip: 'alpha' }, { symmetricRange: [':/alpha', 'broken'] }],
        });

        // Assert
        expect({ refs: result.refs, objectCount: result.objectCount, logged }).toEqual({
          refs: [{ name: 'refs/heads/alpha', oid: alpha }],
          objectCount: 3,
          logged: [`Could not read ${MISSING}`, `could not parse commit ${MISSING}`],
        });
      });
    });
  });

  describe('Given a symmetric range with an end the store lacks', () => {
    describe('When bundleCreate reads it', () => {
      it('Then the symmetric difference is invalid with no non-commit side', async () => {
        // Arrange
        const { ctx } = await buildTypingRepo();
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ symmetricRange: ['root', MISSING] }] });

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_SYMMETRIC_RANGE',
          expression: `root...${MISSING}`,
          nonCommits: [],
        });
      });
    });
  });

  describe.each([
    ['tags', { tags: true }, 'b'],
    ['all', { all: true }, 'refs/tags/b'],
  ] as const)(
    'Given a tag on a commit naming a blob as its tree, then a tag on that blob',
    (label, opts, name) => {
      describe(`When bundleCreate expands --${label}`, () => {
        it('Then the blob conflicts with its tree typing and its ref is a bad object', async () => {
          // Arrange
          const { ctx, logged, blob, root } = await buildTypingRepo();
          await setRef(ctx, 'refs/tags/a', await writeCommitNaming(ctx, blob, [root]));
          await setRef(ctx, 'refs/tags/b', blob);
          const sut = refusalOf;

          // Act
          const caught = await sut(ctx, opts);

          // Assert
          expect({ data: (caught as TsgitError).data, logged }).toEqual({
            data: { code: 'OBJECT_NOT_FOUND', id: name },
            logged: [`object ${blob} is a tree, not a blob`],
          });
        });
      });
    },
  );

  describe.each([
    ['branches', { branches: true }, 'gone'],
    ['all', { all: true }, 'refs/heads/gone'],
  ] as const)('Given a branch on an object the store lacks', (label, opts, name) => {
    describe(`When bundleCreate expands --${label}`, () => {
      it('Then its ref is a bad object', async () => {
        // Arrange
        const { ctx } = await buildTypingRepo();
        await setRef(ctx, 'refs/heads/gone', MISSING);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, opts);

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: name });
      });
    });
  });

  describe('Given an unborn HEAD beside a branch', () => {
    describe('When bundleCreate expands --all', () => {
      it('Then HEAD adds no ref and the branch alone is bundled', async () => {
        // Arrange
        const { ctx, root } = await buildTypingRepo();
        const sut = bundleCreate;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        expect(result.refs).toEqual([{ name: 'refs/heads/root', oid: root }]);
      });
    });
  });

  describe('Given a detached HEAD on an object the store lacks', () => {
    describe('When bundleCreate expands --all', () => {
      it('Then HEAD is a bad object', async () => {
        // Arrange
        const { ctx } = await buildTypingRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${MISSING}\n`);
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { all: true });

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: 'HEAD' });
      });
    });
  });

  describe('Given a branch whose commit names a blob as its tree', () => {
    describe('When bundleCreate packs it', () => {
      it('Then it logs the blob is not a tree and refuses it as a bad tree object', async () => {
        // Arrange
        const { ctx, logged, blob, root } = await buildTypingRepo();
        await setRef(ctx, 'refs/heads/main', await writeCommitNaming(ctx, blob, [root]));
        const sut = refusalOf;

        // Act
        const caught = await sut(ctx, { revs: [{ tip: 'main' }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'BAD_TREE_OBJECT', id: blob },
          logged: [`Object ${blob} not a tree`],
        });
      });
    });
  });

  describe.each([
    ['names a blob as its parent', (repo: TypingRepo) => [repo.blob], 'blob'],
    ['names a parent the store lacks', () => [MISSING], 'missing'],
  ] as const)('Given a branch whose commit %s', (_label, parentsOf, kind) => {
    const loggedFor = (repo: TypingRepo): string =>
      kind === 'blob' ? `Object ${repo.blob} not a commit` : `Could not read ${MISSING}`;

    describe('When bundleCreate walks it alone', () => {
      it('Then it fails to traverse the parents of that commit', async () => {
        // Arrange
        const repo = await buildTypingRepo();
        const tip = await writeCommitNaming(repo.ctx, repo.empty, parentsOf(repo));
        await setRef(repo.ctx, 'refs/heads/main', tip);
        const sut = refusalOf;

        // Act
        const caught = await sut(repo.ctx, { revs: [{ tip: 'main' }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged: repo.logged }).toEqual({
          data: { code: 'REVISION_WALK_FAILED', commit: tip },
          logged: [loggedFor(repo)],
        });
      });
    });

    describe('When bundleCreate walks it as a range from an excluded root', () => {
      it('Then it fails the walk setup', async () => {
        // Arrange
        const repo = await buildTypingRepo();
        const parents = [repo.root, ...parentsOf(repo)];
        await setRef(
          repo.ctx,
          'refs/heads/main',
          await writeCommitNaming(repo.ctx, repo.empty, parents),
        );
        const sut = refusalOf;

        // Act
        const caught = await sut(repo.ctx, { revs: [{ range: ['root', 'main'] }] });

        // Assert
        expect({ data: (caught as TsgitError).data, logged: repo.logged }).toEqual({
          data: { code: 'REVISION_WALK_FAILED' },
          logged: [loggedFor(repo)],
        });
      });
    });
  });

  describe('Given a range, a tip the exclusion reaches and a symmetric range', () => {
    describe('When bundleCreate feeds its pack walk', () => {
      it("Then the tips follow git's pending order, flagged as the bundle walk left them", async () => {
        // Arrange
        const { ctx, root, empty } = await buildTypingRepo();
        const left = await makeCommitObj(ctx, empty, [root], 'left', 3);
        const right = await makeCommitObj(ctx, empty, [root], 'right', 4);
        await setRef(ctx, 'refs/heads/left', left);
        await setRef(ctx, 'refs/heads/right', right);
        const closureSpy = vi.spyOn(closureEngineMod, 'computeClosure');
        const sut = bundleCreate;

        // Act
        await sut(ctx, {
          revs: [
            { range: ['root', 'left'] },
            { tip: 'root' },
            { symmetricRange: ['left', 'right'] },
          ],
        });

        // Assert
        const request = closureSpy.mock.calls[0]?.[1];
        expect({ tips: request?.tips, typed: request?.objectTypes !== undefined }).toEqual({
          tips: [
            { id: root, excluded: true },
            { id: left, excluded: false },
            { id: root, excluded: true },
            { id: root, excluded: true },
            { id: left, excluded: false },
            { id: right, excluded: false },
            { id: root, excluded: true },
          ],
          typed: true,
        });
        closureSpy.mockRestore();
      });
    });
  });
});

describe('Given a wanted branch, a second wanted branch and an excluded commit', () => {
  describe('When bundleCreate enumerates the bundle objects', () => {
    it('Then the wants are the wanted tips and the haves the excluded ones, in pending order', async () => {
      // Arrange
      const { ctx, mainCommit, featureCommit, base } = await buildDivergentRepo();
      const enumerateSpy = vi.spyOn(enumerateBundleObjectsMod, 'enumerateBundleObjects');
      const sut = bundleCreate;

      // Act
      await sut(ctx, { revs: [{ tip: 'main' }, { tip: 'feature' }, { exclude: 'main~1' }] });

      // Assert
      const input = enumerateSpy.mock.calls[0]?.[1];
      expect({ wants: input?.wants, haves: input?.haves }).toEqual({
        wants: [mainCommit, featureCommit],
        haves: [base],
      });
      enumerateSpy.mockRestore();
    });
  });
});

describe('Given a repository with one commit on main', () => {
  describe('When bundleCreate bundles every ref with all: true', () => {
    it('Then the pack holds the commit and its tree', async () => {
      // Arrange
      const { ctx } = await buildSingleCommitRepo();
      const sut = bundleCreate;

      // Act
      const result = await sut(ctx, { all: true });

      // Assert
      expect(result.objectCount).toBe(2);
    });
  });
});
