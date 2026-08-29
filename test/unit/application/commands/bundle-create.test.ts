import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  assertBoundaryCommit,
  type BundleCreateOptions,
  type BundleCreateResult,
  bundleCreate,
  selectBundleVersion,
} from '../../../../src/application/commands/bundle-create.js';
import { invalidateConfigCache } from '../../../../src/application/primitives/config-read.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  FileMode,
  GitObject,
  ObjectId,
  Tag,
} from '../../../../src/domain/objects/index.js';
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
  const tree2 = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blob }]);
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
  const treeM = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'm.txt', id: blobM }]);
  const mainCommit = await makeCommitObj(ctx, treeM, [base], 'main change', 2);
  const blobF = await makeBlob(ctx, 'feat');
  const treeF = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'f.txt', id: blobF }]);
  const featureCommit = await makeCommitObj(ctx, treeF, [base], 'feature change', 3);
  await setRef(ctx, 'refs/heads/main', mainCommit);
  await setRef(ctx, 'refs/heads/feature', featureCommit);
  return { ctx, base, mainCommit, featureCommit };
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
          reason: 'no-objects',
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
        const tree2 = await writeTree(ctx, [{ mode: BLOB_MODE, name: 'a.txt', id: blob }]);
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
        const treeT = await writeTree(ctx, [{ mode: BLOB_MODE, name: 't.txt', id: blobT }]);
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
