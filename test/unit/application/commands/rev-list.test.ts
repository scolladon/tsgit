import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate, branchDelete } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { revList } from '../../../../src/application/commands/rev-list.js';
import { tagCreate } from '../../../../src/application/commands/tag.js';
import { worktreeAdd } from '../../../../src/application/commands/worktree.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { deriveWorktreeContext } from '../../../../src/application/primitives/internal/worktree-context.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type {
  AuthorIdentity,
  Blob,
  Commit,
  FileMode,
  GitObject,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { serializeObject } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  type BitmapEntrySpec,
  type BitmapStreamSpec,
  buildBitmap,
} from '../../domain/storage/arbitraries.js';
import {
  type EntrySpec,
  writeSyntheticBitmap,
  writeSyntheticPack,
} from '../primitives/pack-fixture.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface SeededRepo {
  readonly ctx: Context;
  readonly commitIds: ReadonlyArray<ObjectId>;
}

/** Three commits on `main`, each adding one distinct file. */
const seedThree = async (): Promise<SeededRepo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const commitIds: ObjectId[] = [];
  for (const [path, content, message] of [
    ['a.txt', 'a', 'first'],
    ['b.txt', 'b', 'second'],
    ['c.txt', 'c', 'third'],
  ] as const) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
    await add(ctx, [path]);
    const result = await commit(ctx, { message, author: AUTHOR });
    commitIds.push(result.id);
  }
  return { ctx, commitIds };
};

/**
 * An n-commit chain where each generation replaces the single prior file, so
 * every commit owns a distinct tree and blob — nothing shared across
 * generations. `maxCount`/`noWalk` boundary tests need that: an excluded
 * ancestor's own objects must be absent, not merely un-counted.
 */
const seedChain = async (length: number): Promise<SeededRepo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const commitIds: ObjectId[] = [];
  for (let i = 0; i < length; i += 1) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/gen.txt`, `gen-${i}`);
    await add(ctx, ['gen.txt']);
    const result = await commit(ctx, { message: `gen-${i}`, author: AUTHOR });
    commitIds.push(result.id);
  }
  return { ctx, commitIds };
};

interface MergeFixture {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly mainCommit: ObjectId;
  readonly featureCommit: ObjectId;
  readonly mergeCommit: ObjectId;
}

/**
 * `base` on `main`, diverging into `mainCommit` (main-only file) and
 * `featureCommit` (feature-only file), merged back into `main` as a real
 * two-parent merge commit — `mainCommit` first, `featureCommit` second,
 * mirroring `mergeRun`'s own parent order.
 */
const seedMergeFixture = async (): Promise<MergeFixture> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'base');
  await add(ctx, ['base.txt']);
  const base = (await commit(ctx, { message: 'base', author: AUTHOR })).id;

  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feature.txt`, 'feature');
  await add(ctx, ['feature.txt']);
  const featureCommit = (await commit(ctx, { message: 'feature-side', author: AUTHOR })).id;

  await checkout(ctx, { rev: 'main' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/main.txt`, 'main-side');
  await add(ctx, ['main.txt']);
  const mainCommit = (await commit(ctx, { message: 'main-side', author: AUTHOR })).id;

  const result = await mergeRun(ctx, { rev: 'feature', message: 'merge feature', author: AUTHOR });
  if (result.kind !== 'merge') throw new Error('expected a real two-parent merge commit');
  return { ctx, base, mainCommit, featureCommit, mergeCommit: result.id };
};

describe('revList', () => {
  describe('Given a repository with three commits', () => {
    describe('When revList is called with no options', () => {
      it('Then wants defaults to HEAD and count equals entries.length on the same call', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(new Set(result.entries.map((e) => e.id))).toEqual(new Set(commitIds));
        expect(result.entries.every((e) => e.type === 'commit')).toBe(true);
        expect(result.count).toBe(result.entries.length);
        expect(result.count).toBe(3);
      });
    });
  });

  describe('Given the same repository', () => {
    describe('When revList is called with objects: true', () => {
      it('Then count moves with objects (commits, trees, and blobs are all counted)', async () => {
        // Arrange
        const { ctx } = await seedThree();
        const sut = revList;

        // Act
        const withoutObjects = await sut(ctx, { objects: false });
        const withObjects = await sut(ctx, { objects: true });

        // Assert
        expect(withoutObjects.count).toBe(3);
        expect(withObjects.count).toBeGreaterThan(withoutObjects.count);
        expect(withObjects.count).toBe(withObjects.entries.length);
        expect(withObjects.entries.some((e) => e.type === 'tree')).toBe(true);
        expect(withObjects.entries.some((e) => e.type === 'blob')).toBe(true);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with wants: ["HEAD~2"]', () => {
      it('Then it resolves through the full revision grammar to the root commit alone', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['HEAD~2'] });

        // Assert — HEAD~2 from the third commit is the first (parentless) commit.
        expect(result.entries).toEqual([{ id: commitIds[0], type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with an oid prefix as a want', () => {
      it('Then it resolves through revParse to the same closure as the full oid', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const tip = commitIds[2] as ObjectId;
        const prefix = tip.slice(0, 7);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [prefix] });

        // Assert
        expect(new Set(result.entries.map((e) => e.id))).toEqual(new Set(commitIds));
      });
    });
  });

  describe('Given a repository with a tag ref pointing at the tip', () => {
    describe('When revList is called with the tag name as a want', () => {
      it('Then it resolves through revParse via the tag ref to the tip alone', async () => {
        // Arrange — HEAD~1 as `not` isolates the resolution to the tag's own
        // commit, proving the tag ref (not HEAD) drove the walk's seed.
        const { ctx, commitIds } = await seedThree();
        const tip = commitIds[2] as ObjectId;
        const middle = commitIds[1] as ObjectId;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/v1`, `${tip}\n`);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['v1'], not: [middle] });

        // Assert
        expect(result.entries).toEqual([{ id: tip, type: 'commit', path: undefined }]);
      });
    });
  });

  describe('Given a repository with three commits', () => {
    describe('When revList is called with not excluding the root commit', () => {
      it('Then the excluded commit is absent from the entries', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: ['HEAD'], not: [commitIds[0] as ObjectId] });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids.has(commitIds[0] as ObjectId)).toBe(false);
        expect(ids.has(commitIds[1] as ObjectId)).toBe(true);
        expect(ids.has(commitIds[2] as ObjectId)).toBe(true);
      });
    });
  });

  describe('Given a context that is not a repository', () => {
    describe('When revList is called', () => {
      it('Then it throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = revList;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a repository with two branches, a lightweight tag, and an annotated tag', () => {
    describe('When revList is called with all: true', () => {
      it('Then the entries union every ref tip with no duplicate ids', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'base');
        await add(ctx, ['base.txt']);
        const base = (await commit(ctx, { message: 'base', author: AUTHOR })).id;
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { rev: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feature.txt`, 'feature');
        await add(ctx, ['feature.txt']);
        const featureTip = (await commit(ctx, { message: 'feature', author: AUTHOR })).id;
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n  name = Ada\n  email = ada@example.com\n',
        );
        __resetConfigCacheForTests();
        await tagCreate(ctx, { name: 'v-light', target: base });
        await tagCreate(ctx, { name: 'v-annotated', target: featureTip, message: 'release' });
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        // Without objects git lists the commits alone, never the annotated tag.
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([base, featureTip]));
        expect(result.entries).toHaveLength(2);
      });
    });
  });

  describe('Given a ref tip and a commit reachable only by id (its branch deleted)', () => {
    describe('When revList is called with all: true and an explicit want naming the dangling commit', () => {
      it('Then the result unions both sources, deduplicated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/base.txt`, 'base');
        await add(ctx, ['base.txt']);
        const base = (await commit(ctx, { message: 'base', author: AUTHOR })).id;
        await branchCreate(ctx, { name: 'orphan' });
        await checkout(ctx, { rev: 'orphan' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/orphan.txt`, 'orphan');
        await add(ctx, ['orphan.txt']);
        const dangling = (await commit(ctx, { message: 'orphan', author: AUTHOR })).id;
        await checkout(ctx, { rev: 'main' });
        // Forced: `orphan` carries a commit `main` never saw, which is what
        // leaves the tip dangling — the unforced delete refuses exactly that.
        await branchDelete(ctx, { name: 'orphan', force: true });
        const sut = revList;

        // Act — `main` duplicates one of `all`'s own ref tips; the dangling
        // commit is reachable only through the explicit want.
        const result = await sut(ctx, { all: true, wants: [dangling, 'main'] });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([base, dangling]));
        expect(result.entries).toHaveLength(2);
      });
    });
  });

  describe('Given a freshly initialized repository with no commits', () => {
    describe('When revList is called with all: true', () => {
      it('Then the unborn HEAD ref is skipped and the result is empty rather than refusing', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        expect(result.entries).toEqual([]);
        expect(result.count).toBe(0);
      });
    });
  });

  describe('Given a 3-commit chain', () => {
    describe('When revList is called with maxCount: 2 (N-1)', () => {
      it('Then only the two most recent commits are entries', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, { maxCount: 2 });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([commitIds[2], commitIds[1]]));
        expect(result.count).toBe(2);
      });
    });
  });

  describe('Given the same 3-commit chain', () => {
    describe('When revList is called with maxCount: 3 (N)', () => {
      it('Then every commit is an entry', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, { maxCount: 3 });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set(commitIds));
        expect(result.count).toBe(3);
      });
    });
  });

  describe('Given the same 3-commit chain', () => {
    describe('When revList is called with maxCount: 4 (N+1)', () => {
      it('Then the bound exceeds the reachable set and every commit is still an entry', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, { maxCount: 4 });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set(commitIds));
        expect(result.count).toBe(3);
      });
    });
  });

  describe('Given the same 3-commit chain', () => {
    describe('When revList is called with maxCount: 0', () => {
      it('Then the result is empty, not unbounded', async () => {
        // Arrange
        const { ctx } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, { maxCount: 0 });

        // Assert
        expect(result.entries).toEqual([]);
        expect(result.count).toBe(0);
      });
    });
  });

  describe('Given the same 3-commit chain', () => {
    describe('When revList is called with maxCount: 2 and objects: true', () => {
      it('Then only the two newest commits and their own trees/blobs are entries', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, { maxCount: 2, objects: true });

        // Assert — 2 commits + 2 distinct trees + 2 distinct blobs, the root
        // commit's own generation excluded entirely.
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids.has(commitIds[0] as ObjectId)).toBe(false);
        expect(result.count).toBe(6);
        expect(result.entries.filter((e) => e.type === 'commit')).toHaveLength(2);
        expect(result.entries.filter((e) => e.type === 'tree')).toHaveLength(2);
        expect(result.entries.filter((e) => e.type === 'blob')).toHaveLength(2);
      });
    });
  });

  describe('Given a 3-commit chain with the root excluded via not', () => {
    describe('When revList is called with maxCount: 1', () => {
      it('Then only the newest commit remains', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(3);
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          not: [commitIds[0] as ObjectId],
          maxCount: 1,
        });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([commitIds[2]]));
        expect(result.count).toBe(1);
      });
    });
  });

  describe('Given a fixture with a real merge commit', () => {
    describe('When revList is called with and without firstParent', () => {
      it('Then the commit set differs — firstParent excludes the second-parent branch', async () => {
        // Arrange
        const { ctx, base, mainCommit, featureCommit, mergeCommit } = await seedMergeFixture();
        const sut = revList;

        // Act
        const withFirstParent = await sut(ctx, { wants: [mergeCommit], firstParent: true });
        const withoutFirstParent = await sut(ctx, { wants: [mergeCommit] });

        // Assert
        const firstParentIds = new Set(withFirstParent.entries.map((e) => e.id));
        const allIds = new Set(withoutFirstParent.entries.map((e) => e.id));
        expect(firstParentIds).toEqual(new Set([mergeCommit, mainCommit, base]));
        expect(allIds).toEqual(new Set([mergeCommit, mainCommit, featureCommit, base]));
      });
    });
  });

  describe('Given the same merge fixture', () => {
    describe('When revList is called with objects: true, with and without firstParent', () => {
      it('Then the object set differs — the feature commit and its own tree are excluded', async () => {
        // Arrange
        const { ctx, featureCommit, mergeCommit } = await seedMergeFixture();
        const sut = revList;

        // Act
        const withFirstParent = await sut(ctx, {
          wants: [mergeCommit],
          firstParent: true,
          objects: true,
        });
        const withoutFirstParent = await sut(ctx, { wants: [mergeCommit], objects: true });

        // Assert
        const firstParentIds = new Set(withFirstParent.entries.map((e) => e.id));
        const allIds = new Set(withoutFirstParent.entries.map((e) => e.id));
        expect(firstParentIds.has(featureCommit)).toBe(false);
        expect(allIds.has(featureCommit)).toBe(true);
        expect(firstParentIds.size).toBeLessThan(allIds.size);
      });
    });
  });

  describe('Given a fixture with a real merge commit', () => {
    describe('When revList is called with firstParent: true and maxCount: 2', () => {
      it('Then only the merge commit and its first parent are entries', async () => {
        // Arrange
        const { ctx, base, mainCommit, mergeCommit } = await seedMergeFixture();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [mergeCommit],
          firstParent: true,
          maxCount: 2,
        });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([mergeCommit, mainCommit]));
        expect(ids.has(base)).toBe(false);
        expect(result.count).toBe(2);
      });
    });
  });

  describe('Given a 5-commit chain', () => {
    describe('When revList is called with and without noWalk from the tip', () => {
      it('Then noWalk emits only the tip while the default walk reaches every ancestor', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(5);
        const tip = commitIds[4] as ObjectId;
        const sut = revList;

        // Act
        const withNoWalk = await sut(ctx, { wants: [tip], noWalk: true });
        const withoutNoWalk = await sut(ctx, { wants: [tip] });

        // Assert
        expect(new Set(withNoWalk.entries.map((e) => e.id))).toEqual(new Set([tip]));
        expect(new Set(withoutNoWalk.entries.map((e) => e.id))).toEqual(new Set(commitIds));
      });
    });
  });

  describe('Given the same 5-commit chain', () => {
    describe('When revList is called with noWalk: true and objects: true', () => {
      it('Then only the tip and its own tree/blob are entries, no ancestor content', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(5);
        const tip = commitIds[4] as ObjectId;
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [tip], noWalk: true, objects: true });

        // Assert — the tip commit + its own tree + its own blob, nothing from
        // the excluded ancestors.
        const ids = new Set(result.entries.map((e) => e.id));
        expect(result.count).toBe(3);
        expect(ids.has(commitIds[3] as ObjectId)).toBe(false);
        expect(result.entries.some((e) => e.type === 'tree')).toBe(true);
        expect(result.entries.some((e) => e.type === 'blob')).toBe(true);
      });
    });
  });

  describe('Given the same 5-commit chain', () => {
    describe('When revList is called with noWalk: true and two tips, one an ancestor of the other', () => {
      it('Then only the two tips are entries, not the commits between them', async () => {
        // Arrange
        const { ctx, commitIds } = await seedChain(5);
        const older = commitIds[1] as ObjectId;
        const newer = commitIds[3] as ObjectId;
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [older, newer], noWalk: true });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([older, newer]));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// useBitmapIndex — the bitmap tier's own control
// ---------------------------------------------------------------------------

function stripHeader(bytes: Uint8Array): Uint8Array {
  const nul = bytes.indexOf(0);
  return bytes.subarray(nul + 1);
}

async function idOf(ctx: Context, object: GitObject): Promise<string> {
  return ctx.hash.hashHex(serializeObject(object, ctx.hashConfig));
}

function rawContentOf(ctx: Context, object: GitObject): Uint8Array {
  return stripHeader(serializeObject(object, ctx.hashConfig));
}

function indexPositionOf(ids: ReadonlyArray<string>, id: string): number {
  return [...ids].sort().indexOf(id);
}

interface DiamondRepo {
  readonly ctx: Context;
  readonly mergeCommitId: ObjectId;
}

/**
 * A diamond history — root, two divergent branches, and a merge — packed
 * and covered by a single hand-crafted bitmap entry for the merge commit
 * alone, whose reconstructed set is the WHOLE 12-object closure. `wants`
 * always names the merge commit, so `firstParent`/`noWalk` narrowing (a
 * real walk would drop the other branch, or every ancestor) is what these
 * tests can observe.
 */
async function buildDiamondBitmapRepo(): Promise<DiamondRepo> {
  const ctx = createMemoryContext();
  await init(ctx);
  const enc = new TextEncoder();
  const entries: EntrySpec[] = [];
  const ids: string[] = [];

  const writeGen = async (prefix: string, parents: ReadonlyArray<string>): Promise<string> => {
    const blob: Blob = { type: 'blob', id: '' as ObjectId, content: enc.encode(prefix) };
    const blobId = await idOf(ctx, blob);
    entries.push({ kind: 'base', type: 'blob', content: rawContentOf(ctx, blob) });
    ids.push(blobId);

    const tree: Tree = {
      type: 'tree',
      id: '' as ObjectId,
      entries: [treeEntry('100644' as FileMode, `${prefix}.txt`, blobId as ObjectId)],
    };
    const treeId = await idOf(ctx, tree);
    entries.push({ kind: 'base', type: 'tree', content: rawContentOf(ctx, tree) });
    ids.push(treeId);

    const commitObj: Commit = {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree: treeId as ObjectId,
        parents: parents as ReadonlyArray<ObjectId>,
        author: AUTHOR,
        committer: AUTHOR,
        message: prefix,
        extraHeaders: [],
      },
    };
    const commitId = await idOf(ctx, commitObj);
    entries.push({ kind: 'base', type: 'commit', content: rawContentOf(ctx, commitObj) });
    ids.push(commitId);
    return commitId;
  };

  const rootId = await writeGen('root', []);
  const branchAId = await writeGen('branch-a', [rootId]);
  const branchBId = await writeGen('branch-b', [rootId]);
  const mergeId = await writeGen('merge', [branchAId, branchBId]);

  const packName = 'diamond';
  await writeSyntheticPack(ctx, packName, entries);
  const objectCount = ids.length;
  const idxOf = (id: string) => indexPositionOf(ids, id);

  const commitPositions = [2, 5, 8, 11];
  const treePositions = [1, 4, 7, 10];
  const blobPositions = [0, 3, 6, 9];
  const typeStream = (bits: ReadonlyArray<number>): BitmapStreamSpec => ({
    bitSize: objectCount,
    bits,
  });
  const entrySpec: BitmapEntrySpec = {
    position: idxOf(mergeId),
    xorOffset: 0,
    flags: 0,
    bitSize: objectCount,
    bits: Array.from({ length: objectCount }, (_unused, i) => i),
  };
  const body = buildBitmap({
    optionFlags: 1,
    digestLength: ctx.hashConfig.digestLength,
    checksum: new Uint8Array(ctx.hashConfig.digestLength).fill(0xbb),
    typeStreams: [
      typeStream(commitPositions),
      typeStream(treePositions),
      typeStream(blobPositions),
      typeStream([]),
    ],
    entries: [entrySpec],
    trailingBytes: 0,
  });
  await writeSyntheticBitmap(
    ctx,
    `${ctx.layout.gitDir}/objects/pack/pack-${packName}.bitmap`,
    body,
  );

  return { ctx, mergeCommitId: mergeId as ObjectId };
}

describe('revList — useBitmapIndex', () => {
  describe('Given a bitmap-covered merge commit', () => {
    describe('When revList is called with objects: true and no useBitmapIndex', () => {
      it('Then it reproduces git — useBitmapIndex defaults to false and the walk answers, entries carrying paths', async () => {
        // Arrange
        const { ctx, mergeCommitId } = await buildDiamondBitmapRepo();
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [mergeCommitId], objects: true });

        // Assert
        expect(result.entries.some((e) => e.path !== undefined)).toBe(true);
      });
    });
  });

  describe('Given the same bitmap-covered merge commit', () => {
    describe('When revList is called with objects: true and useBitmapIndex: true', () => {
      it('Then it reproduces git — the bitmap tier answers and no entry carries a path', async () => {
        // Arrange
        const { ctx, mergeCommitId } = await buildDiamondBitmapRepo();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [mergeCommitId],
          objects: true,
          useBitmapIndex: true,
        });

        // Assert
        expect(result.entries.length).toBeGreaterThan(0);
        expect(result.entries.every((e) => e.path === undefined)).toBe(true);
      });
    });
  });

  describe('Given the same bitmap-covered merge commit', () => {
    describe('When revList is called with maxCount and useBitmapIndex: true', () => {
      it('Then it reproduces git — maxCount forces the walk, and entries carry paths', async () => {
        // Arrange
        const { ctx, mergeCommitId } = await buildDiamondBitmapRepo();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [mergeCommitId],
          objects: true,
          useBitmapIndex: true,
          maxCount: 1,
        });

        // Assert
        expect(result.entries.some((e) => e.path !== undefined)).toBe(true);
      });
    });
  });

  describe('Given the same bitmap-covered merge commit', () => {
    describe('When revList is called with firstParent and useBitmapIndex: true', () => {
      it('Then it reproduces git — firstParent is ignored on the bitmap tier and the full closure returns', async () => {
        // Arrange
        const { ctx, mergeCommitId } = await buildDiamondBitmapRepo();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [mergeCommitId],
          useBitmapIndex: true,
          firstParent: true,
        });

        // Assert — a real first-parent walk would exclude the second branch;
        // the bitmap tier returns every commit regardless.
        expect(result.entries.filter((e) => e.type === 'commit')).toHaveLength(4);
      });
    });
  });

  describe('Given the same bitmap-covered merge commit', () => {
    describe('When revList is called with noWalk and useBitmapIndex: true', () => {
      it('Then it reproduces git — noWalk is ignored on the bitmap tier and the full closure returns', async () => {
        // Arrange
        const { ctx, mergeCommitId } = await buildDiamondBitmapRepo();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: [mergeCommitId],
          useBitmapIndex: true,
          noWalk: true,
        });

        // Assert — a real noWalk call would return only the merge commit itself.
        expect(result.entries.filter((e) => e.type === 'commit')).toHaveLength(4);
      });
    });
  });
});

interface SkewedExclusion {
  readonly ctx: Context;
  readonly ancestor: ObjectId;
  readonly tip: ObjectId;
  readonly excluded: ObjectId;
}

/** A commit owning one distinct blob, dated `timestamp` seconds. */
const writeDatedCommit = async (
  ctx: Context,
  name: string,
  timestamp: number,
  parents: ReadonlyArray<ObjectId>,
): Promise<ObjectId> => {
  const blob: Blob = { type: 'blob', id: '' as ObjectId, content: new TextEncoder().encode(name) };
  const tree = await writeTree(ctx, [
    treeEntry('100644' as FileMode, `${name}.txt`, await writeObject(ctx, blob)),
  ]);
  const signature: AuthorIdentity = { ...AUTHOR, timestamp };
  const object: Commit = {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents,
      author: signature,
      committer: signature,
      message: name,
      extraHeaders: [],
    },
  };
  return writeObject(ctx, object);
};

/**
 * `tip` (newest) on `ancestor`, and an excluded line reaching `ancestor`
 * through `depth` commits all dated BEFORE `ancestor` — clock skew that
 * makes git's limited walk give up on the excluded side before it reaches
 * `ancestor`.
 */
const seedSkewedExclusion = async (depth: number): Promise<SkewedExclusion> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const ancestor = await writeDatedCommit(ctx, 'ancestor', 500, []);
  const tip = await writeDatedCommit(ctx, 'tip', 1000, [ancestor]);
  let line = ancestor;
  for (let step = 1; step <= depth; step += 1) {
    line = await writeDatedCommit(ctx, `skewed-${step}`, 300 - step, [line]);
  }
  const excluded = await writeDatedCommit(ctx, 'excluded', 400, [line]);
  return { ctx, ancestor, tip, excluded };
};

describe('Given an excluded line six clock-skewed commits away from the shared ancestor', () => {
  describe('When revList walks the tip excluding that line', () => {
    it('Then the ancestor is listed, because the walk stops looking five commits after it went all-uninteresting', async () => {
      // Arrange
      const { ctx, ancestor, tip, excluded } = await seedSkewedExclusion(6);
      const sut = revList;

      // Act
      const result = await sut(ctx, { wants: [tip], not: [excluded] });

      // Assert
      expect(new Set(result.entries.map((entry) => entry.id))).toEqual(new Set([tip, ancestor]));
    });
  });

  describe('When revList walks the tip excluding that line with objects', () => {
    it('Then the ancestor keeps its tree and blob too', async () => {
      // Arrange
      const { ctx, tip, excluded } = await seedSkewedExclusion(6);
      const sut = revList;

      // Act
      const result = await sut(ctx, { wants: [tip], not: [excluded], objects: true });

      // Assert
      expect(result.count).toBe(6);
    });
  });
});

describe('Given an excluded line three clock-skewed commits away from the shared ancestor', () => {
  describe('When revList walks the tip excluding that line', () => {
    it('Then the ancestor is excluded, reached within the five-commit slack', async () => {
      // Arrange
      const { ctx, tip, excluded } = await seedSkewedExclusion(3);
      const sut = revList;

      // Act
      const result = await sut(ctx, { wants: [tip], not: [excluded], objects: true });

      // Assert
      expect(result.entries.map((entry) => entry.id).filter((id) => id === tip)).toEqual([tip]);
      expect(result.count).toBe(3);
    });
  });
});

interface SkewedMerge {
  readonly ctx: Context;
  readonly ids: Readonly<Record<'r' | 'a1' | 'a' | 'b' | 'm' | 't', ObjectId>>;
}

/** m (100) merges a (50, on a1 at 80) and b (90); t (95) is a second tip; all on r. */
const seedSkewedMerge = async (): Promise<SkewedMerge> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const r = await writeDatedCommit(ctx, 'r', 10, []);
  const a1 = await writeDatedCommit(ctx, 'a1', 80, [r]);
  const a = await writeDatedCommit(ctx, 'a', 50, [a1]);
  const b = await writeDatedCommit(ctx, 'b', 90, [r]);
  const m = await writeDatedCommit(ctx, 'm', 100, [a, b]);
  const t = await writeDatedCommit(ctx, 't', 95, [r]);
  return { ctx, ids: { r, a1, a, b, m, t } };
};

describe('Given a merge whose first parent is dated before its second', () => {
  describe.each([
    { wants: ['m'], firstParent: false, maxCount: 2, expected: ['m', 'b'] },
    { wants: ['t', 'm'], firstParent: true, maxCount: 3, expected: ['m', 't', 'a'] },
    { wants: ['t', 'm'], firstParent: false, maxCount: 4, expected: ['m', 't', 'b', 'a'] },
  ] as const)(
    'When revList walks $wants with firstParent $firstParent and maxCount $maxCount',
    ({ wants, firstParent, maxCount, expected }) => {
      it('Then it keeps the commits git shows first in commit-date order', async () => {
        // Arrange
        const { ctx, ids } = await seedSkewedMerge();
        const sut = revList;

        // Act
        const result = await sut(ctx, {
          wants: wants.map((name) => ids[name]),
          firstParent,
          maxCount,
        });

        // Assert
        expect(new Set(result.entries.map((entry) => entry.id))).toEqual(
          new Set(expected.map((name) => ids[name])),
        );
      });
    },
  );
});

describe('revList all: broken refs', () => {
  const writeLooseRef = (ctx: Context, name: string, content: string): Promise<void> =>
    ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, content);

  const caughtFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return expect.unreachable();
  };

  describe('Given a loose branch whose content is neither an id nor a symref', () => {
    describe('When revList is called with all: true', () => {
      it('Then it refuses naming the broken ref as a bad object', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/broken', 'garbage\n');
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'refs/heads/broken',
        });
      });
    });
  });

  describe('Given a loose branch naming an object the repository lacks', () => {
    describe('When revList is called with all: true', () => {
      it('Then it refuses naming the ref as a bad object, not the absent id', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/missing', `${'1'.repeat(40)}\n`);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'refs/heads/missing',
        });
      });
    });
  });

  describe('Given two broken loose branches', () => {
    describe('When revList is called with all: true', () => {
      it('Then the refusal names the first in ref order', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/z-broken', 'garbage\n');
        await writeLooseRef(ctx, 'refs/heads/a-broken', 'garbage\n');
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'refs/heads/a-broken',
        });
      });
    });
  });

  describe('Given a symbolic branch whose target is broken', () => {
    describe('When revList is called with all: true', () => {
      it('Then the symbolic branch is skipped and the refusal names the broken target', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/zz', 'garbage\n');
        await writeLooseRef(ctx, 'refs/heads/aa', 'ref: refs/heads/zz\n');
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'refs/heads/zz',
        });
      });
    });
  });

  describe('Given a symbolic branch whose target does not exist', () => {
    describe('When revList is called with all: true', () => {
      it('Then the dangling symbolic branch is skipped', async () => {
        // Arrange
        const { ctx, commitIds } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/sym', 'ref: refs/heads/nope\n');
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        expect(new Set(result.entries.map((entry) => entry.id))).toEqual(new Set(commitIds));
      });
    });
  });

  describe('Given a loose branch whose read faults', () => {
    describe('When revList is called with all: true', () => {
      it('Then the fault propagates unchanged', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await writeLooseRef(ctx, 'refs/heads/faulty', 'garbage\n');
        const faultyPath = `${ctx.layout.gitDir}/refs/heads/faulty`;
        const ioError = new Error('EIO: simulated read failure');
        const faultyCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path, mode) => {
              if (path === faultyPath) throw ioError;
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(faultyCtx, { all: true }));

        // Assert
        expect(caught).toBe(ioError);
      });
    });
  });
});

describe('revList: explicit wants naming an absent object', () => {
  const ABSENT = '1'.repeat(40);

  const readTreeOf = async (ctx: Context, id: ObjectId): Promise<ObjectId> => {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error(`${id} is not a commit`);
    return object.data.tree;
  };

  const caughtFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe.each([
    ['a want', { wants: [ABSENT] }],
    ['a negated want', { wants: ['HEAD', `^${ABSENT}`] }],
    ['a not tip', { wants: ['HEAD'], not: [ABSENT] }],
    ['an absent want before an unknown name', { wants: [ABSENT, 'nope'] }],
    ['a parents shorthand', { wants: [`${ABSENT}^@`] }],
    ['an exclude-parents shorthand', { wants: [`${ABSENT}^!`] }],
    ['an exclude-parent shorthand', { wants: [`${ABSENT}^-`] }],
    ['a negated parents shorthand', { wants: ['HEAD', `^${ABSENT}^@`] }],
  ] as const)('Given %s spelling a full id the repository lacks', (_label, opts) => {
    describe('When revList is called', () => {
      it('Then it refuses naming the argument as typed as a bad object', async () => {
        // Arrange
        const { ctx } = await seedThree();
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, opts));

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: ABSENT });
      });
    });
  });

  describe.each(['^@', '^!', '^-'])('Given a tree followed by the %s shorthand', (mark) => {
    describe('When revList is called', () => {
      it('Then the whole argument is an unknown revision and nothing is logged', async () => {
        // Arrange
        const { ctx: base, commitIds } = await seedThree();
        const logged: string[] = [];
        const record = (message: string): void => {
          logged.push(message);
        };
        const ctx = { ...base, logger: { error: record, warn: record, info: record } };
        const tree = await readTreeOf(ctx, commitIds[0]!);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [`${tree}${mark}`] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'REVPARSE_UNRESOLVED', expression: `${tree}${mark}` },
          logged: [],
        });
      });
    });
  });

  describe.each([
    ['t^@', 't'],
    ['t^!', 't'],
    ['t^-', 't'],
    ['t', ABSENT],
  ])('Given a tag t whose target the repository lacks, wanted as %s', (want, id) => {
    describe('When revList is called', () => {
      it("Then it refuses with git's bad object name", async () => {
        // Arrange
        const { ctx } = await seedThree();
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: ABSENT as ObjectId,
            objectType: 'commit',
            tagName: 't',
            tagger: AUTHOR,
            message: 't\n',
            extraHeaders: [],
          },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${tag}\n`);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [want] }));

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
      });
    });
  });

  describe.each([
    ['a want', { wants: ['missing'] }, 'missing'],
    ['a fully spelt want', { wants: ['refs/heads/missing'] }, 'refs/heads/missing'],
    ['a not tip', { wants: ['HEAD'], not: ['missing'] }, 'missing'],
  ] as const)('Given %s naming a branch whose object the repository lacks', (_label, opts, id) => {
    describe('When revList is called', () => {
      it('Then it refuses naming the branch as typed', async () => {
        // Arrange
        const { ctx } = await seedThree();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/missing`, `${ABSENT}\n`);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, opts));

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
      });
    });
  });
});

describe('revList all: other worktrees', () => {
  const caughtFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  const seedLinked = async (): Promise<
    SeededRepo & { readonly linkedHead: string; readonly linkedCtx: Context }
  > => {
    const seeded = await seedThree();
    const { id, path } = await worktreeAdd(seeded.ctx, { path: 'wt', detach: true });
    return {
      ...seeded,
      linkedHead: `${seeded.ctx.layout.gitDir}/worktrees/${id}/HEAD`,
      linkedCtx: deriveWorktreeContext(seeded.ctx, id, path),
    };
  };

  describe('Given the main worktree HEAD names an absent object', () => {
    describe('When revList is called with all: true from a linked worktree', () => {
      it('Then it refuses naming the main worktree HEAD', async () => {
        // Arrange
        const { ctx, linkedCtx } = await seedLinked();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${'1'.repeat(40)}\n`);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(linkedCtx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'main-worktree/HEAD',
        });
      });
    });
  });

  describe('Given a linked worktree whose detached HEAD only it reaches', () => {
    describe('When revList is called with all: true', () => {
      it('Then that HEAD is a tip too', async () => {
        // Arrange
        const { ctx, commitIds, linkedHead } = await seedLinked();
        const only = await writeDatedCommit(ctx, 'linked', 1_700_000_100, [commitIds[2]!]);
        await ctx.fs.writeUtf8(linkedHead, `${only}\n`);
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        expect(result.entries.map(({ id }) => id)).toContain(only);
      });
    });
  });

  describe('Given a linked worktree whose HEAD names an absent object', () => {
    describe('When revList is called with all: true', () => {
      it('Then it refuses naming that worktree HEAD', async () => {
        // Arrange
        const { ctx, linkedHead } = await seedLinked();
        await ctx.fs.writeUtf8(linkedHead, `${'1'.repeat(40)}\n`);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { all: true }));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: 'worktrees/wt/HEAD',
        });
      });
    });
  });

  describe.each([
    ['unreadable', 'garbage\n'],
    ['a dangling symref', 'ref: refs/heads/nope\n'],
  ])('Given a linked worktree whose HEAD is %s', (_label, content) => {
    describe('When revList is called with all: true', () => {
      it('Then that HEAD is skipped', async () => {
        // Arrange
        const { ctx, commitIds, linkedHead } = await seedLinked();
        await ctx.fs.writeUtf8(linkedHead, content);
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        expect(result.entries.map(({ id }) => id)).toEqual([...commitIds].reverse());
      });
    });
  });
});

describe('revList: object types assigned during one invocation', () => {
  interface MistypedTag {
    readonly ctx: Context;
    readonly logged: string[];
    readonly blob: ObjectId;
    readonly tag: ObjectId;
  }

  /** `refs/tags/t` naming a tag that declares `type commit` for a blob. */
  const seedMistypedTag = async (): Promise<MistypedTag> => {
    const { ctx: base } = await seedThree();
    const logged: string[] = [];
    const ctx: Context = { ...base, logger: { error: (message: string) => logged.push(message) } };
    const blob = await writeObject(ctx, {
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode('hi\n'),
    });
    const tag = await writeObject(ctx, {
      type: 'tag',
      id: '' as ObjectId,
      data: {
        object: blob,
        objectType: 'commit',
        tagName: 't',
        tagger: AUTHOR,
        message: 't\n',
        extraHeaders: [],
      },
    });
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/tags/t`, `${tag}\n`);
    return { ctx, logged, blob, tag };
  };

  const caughtFrom = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  describe.each([
    ['the tag alone', { wants: ['t'] }],
    ['every ref', { all: true }],
  ] as const)('Given a tag declaring a commit for a blob, walked from %s', (_label, opts) => {
    describe('When revList peels it', () => {
      it('Then the blob already typed a commit is a bad object', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, opts));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: [`object ${blob} is a commit, not a blob`],
        });
      });
    });
  });

  describe('Given a tag declaring a commit for a blob wanted before it', () => {
    describe('When revList parses the tag', () => {
      it('Then the tag pointer is bad and the tag is a bad object', async () => {
        // Arrange
        const { ctx, logged, blob, tag } = await seedMistypedTag();
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [blob, 't'], objects: true }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: 't' },
          logged: [
            `object ${blob} is a blob, not a commit`,
            `bad tag pointer to ${blob} in ${tag}`,
          ],
        });
      });
    });
  });

  describe('Given a tag declaring a commit for a blob wanted before the blob peeled', () => {
    describe('When revList reads the peel', () => {
      it('Then each read of the blob conflicts and the peel names no object', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: ['t', `${blob}^{}`] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: [
            `object ${blob} is a commit, not a blob`,
            `object ${blob} is a commit, not a blob`,
          ],
        });
      });
    });
  });

  describe('Given an earlier invocation typed the blob', () => {
    describe('When revList walks the tag in a later one', () => {
      it('Then the earlier typing does not carry over', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        await revList(ctx, { wants: [blob], objects: true });
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: ['t'] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: [`object ${blob} is a commit, not a blob`],
        });
      });
    });
  });

  /** A commit naming `tree` and `parents` as stored, whatever they are. */
  const writeCommitNaming = (
    ctx: Context,
    tree: ObjectId,
    parents: ReadonlyArray<ObjectId>,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: { tree, parents, author: AUTHOR, committer: AUTHOR, message: 'm\n', extraHeaders: [] },
    });

  const writeEmptyTree = (ctx: Context): Promise<ObjectId> =>
    writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });

  describe.each([
    ['its tree', 'tree', 'bad tree pointer'],
    ['a parent', 'commit', 'bad parent'],
  ] as const)('Given a blob wanted before a commit naming it as %s', (_label, kind, pointer) => {
    describe('When revList parses the commit', () => {
      it('Then the pointer is bad and the commit is a bad object', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const tree = kind === 'tree' ? blob : await writeEmptyTree(ctx);
        const named = await writeCommitNaming(ctx, tree, kind === 'commit' ? [blob] : []);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [blob, named] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: named },
          logged: [
            `object ${blob} is a blob, not a ${kind}`,
            `${pointer} ${blob} in commit ${named}`,
          ],
        });
      });
    });
  });

  describe('Given a commit naming one tree as both its tree and its parent', () => {
    describe('When revList parses it', () => {
      it('Then the parent already typed a tree is bad and the commit is a bad object', async () => {
        // Arrange
        const { ctx, logged } = await seedMistypedTag();
        const tree = await writeEmptyTree(ctx);
        const named = await writeCommitNaming(ctx, tree, [tree]);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [named] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: named },
          logged: [
            `object ${tree} is a tree, not a commit`,
            `bad parent ${tree} in commit ${named}`,
          ],
        });
      });
    });
  });

  describe.each([
    ['its tree', 'tree', 'bad tree pointer'],
    ['a parent', 'commit', 'bad parent'],
  ] as const)(
    'Given a blob wanted before a commit whose parent names it as %s',
    (_label, kind, pointer) => {
      describe('When the walk parses that parent', () => {
        it('Then it fails to traverse the parents of the commit that reached it', async () => {
          // Arrange
          const { ctx, logged, blob } = await seedMistypedTag();
          const empty = await writeEmptyTree(ctx);
          const parent = await writeCommitNaming(
            ctx,
            kind === 'tree' ? blob : empty,
            kind === 'commit' ? [blob] : [],
          );
          const child = await writeCommitNaming(ctx, empty, [parent]);
          const sut = revList;

          // Act
          const caught = await caughtFrom(() => sut(ctx, { wants: [blob, child] }));

          // Assert
          expect({ data: (caught as TsgitError).data, logged }).toEqual({
            data: { code: 'REVISION_WALK_FAILED', commit: child },
            logged: [
              `object ${blob} is a blob, not a ${kind}`,
              `${pointer} ${blob} in commit ${parent}`,
            ],
          });
        });
      });
    },
  );

  describe('Given a blob wanted, a newer excluded line and an included line whose parents name it', () => {
    describe('When the limited walk parses both lines', () => {
      it('Then the excluded line logs and goes on, the included one fails the walk setup', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const excludedParent = await writeCommitNaming(ctx, blob, []);
        const newer = { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 };
        const excluded = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: empty,
            parents: [excludedParent],
            author: newer,
            committer: newer,
            message: 'm\n',
            extraHeaders: [],
          },
        });
        const includedParent = await writeCommitNaming(ctx, empty, [blob]);
        const included = await writeCommitNaming(ctx, empty, [includedParent]);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() =>
          sut(ctx, { wants: [blob, included], not: [excluded] }),
        );

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'REVISION_WALK_FAILED' },
          logged: [
            `object ${blob} is a blob, not a tree`,
            `bad tree pointer ${blob} in commit ${excludedParent}`,
            `object ${blob} is a blob, not a commit`,
            `bad parent ${blob} in commit ${includedParent}`,
          ],
        });
      });
    });
  });

  describe('Given an included commit whose parent object is corrupt and an excluded line', () => {
    describe('When the limited walk reads that parent', () => {
      it('Then the read fault surfaces as it is, not as a walk setup failure', async () => {
        // Arrange
        const { ctx } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const corrupt = `ab${'0'.repeat(38)}` as ObjectId;
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/ab/${'0'.repeat(38)}`,
          new TextEncoder().encode('not zlib'),
        );
        const included = await writeCommitNaming(ctx, empty, [corrupt]);
        const excluded = await writeCommitNaming(ctx, empty, []);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [included], not: [excluded] }));

        // Assert
        expect((caught as TsgitError).data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });

  describe('Given a blob and an annotated tag of it wanted without objects', () => {
    describe('When revList lists them', () => {
      it('Then nothing is listed, as git lists only commits then', async () => {
        // Arrange
        const { ctx, blob } = await seedMistypedTag();
        const tag = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: blob,
            objectType: 'blob',
            tagName: 'b',
            tagger: AUTHOR,
            message: 'b\n',
            extraHeaders: [],
          },
        });
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [blob, tag] });

        // Assert
        expect(result).toEqual({ entries: [], count: 0 });
      });
    });
  });

  describe('Given a blob wanted before a commit with a tree', () => {
    describe('When revList lists objects', () => {
      it('Then it lists the commits, then the wanted blob, then the commit trees, as git does', async () => {
        // Arrange
        const { ctx, blob } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const parent = await writeCommitNaming(ctx, empty, []);
        const child = await writeCommitNaming(ctx, empty, [parent]);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [blob, child], objects: true });

        // Assert
        expect(result.entries).toEqual([
          { id: child, type: 'commit' },
          { id: parent, type: 'commit' },
          { id: blob, type: 'blob' },
          { id: empty, type: 'tree', path: '' },
        ]);
      });
    });
  });

  describe('Given a shallow commit whose stored parent is a blob wanted before it', () => {
    describe('When revList parses the commit', () => {
      it('Then the cut parent is never typed and the commit is listed', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const tree = await writeEmptyTree(ctx);
        const named = await writeCommitNaming(ctx, tree, [blob]);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${named}\n`);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [blob, named], objects: true });

        // Assert
        expect({ listed: new Set(result.entries), logged }).toEqual({
          listed: new Set([
            { id: named, type: 'commit' },
            { id: blob, type: 'blob' },
            { id: tree, type: 'tree', path: '' },
          ]),
          logged: [],
        });
      });
    });
  });

  const TREE_MODE = '40000' as FileMode;
  const BLOB_MODE = '100644' as FileMode;

  const writeTreeOf = (
    ctx: Context,
    entries: ReadonlyArray<readonly [FileMode, string, ObjectId]>,
  ): Promise<ObjectId> =>
    writeObject(ctx, {
      type: 'tree',
      id: '' as ObjectId,
      entries: entries.map(([mode, name, id]) => treeEntry(mode, name, id)),
    });

  describe.each([
    ['at the root', false],
    ['in a subtree', true],
  ] as const)('Given a tree %s listing one tree as a tree and then as a blob', (_label, nested) => {
    describe('When revList walks its objects', () => {
      it('Then the blob-mode entry is not a blob and the walk refuses', async () => {
        // Arrange
        const { ctx, logged } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const holder = await writeTreeOf(ctx, [
          [TREE_MODE, 'a', empty],
          [BLOB_MODE, 'b', empty],
        ]);
        const root = nested ? await writeTreeOf(ctx, [[TREE_MODE, 'd', holder]]) : holder;
        const named = await writeCommitNaming(ctx, root, []);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [named], objects: true }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'TREE_ENTRY_TYPE_MISMATCH', tree: holder, entry: 'b', mode: 'blob' },
          logged: [`object ${empty} is a tree, not a blob`],
        });
      });
    });
  });

  describe('Given a blob tip before a commit whose tree lists it with tree mode', () => {
    describe('When revList walks its objects', () => {
      it('Then the tree-mode entry is not a tree and the walk refuses', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const holder = await writeTreeOf(ctx, [[TREE_MODE, 'b', blob]]);
        const named = await writeCommitNaming(ctx, holder, []);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [blob, named], objects: true }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'TREE_ENTRY_TYPE_MISMATCH', tree: holder, entry: 'b', mode: 'tree' },
          logged: [`object ${blob} is a blob, not a tree`],
        });
      });
    });
  });

  describe('Given the tag and the blob walked by two concurrent invocations', () => {
    describe('When both run at once', () => {
      it('Then only the tag invocation refuses, as two git processes do', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const sut = revList;

        // Act
        const [tagWalk, blobWalk] = await Promise.all([
          caughtFrom(() => sut(ctx, { wants: ['t'] })),
          sut(ctx, { wants: [blob], objects: true }),
        ]);

        // Assert
        expect({ data: (tagWalk as TsgitError).data, blobWalk, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: blob },
          blobWalk: { entries: [{ id: blob, type: 'blob' }], count: 1 },
          logged: [`object ${blob} is a commit, not a blob`],
        });
      });
    });
  });

  describe('Given an invocation with no tips started just before one walking the tag', () => {
    describe('When the first settles while the second is in flight', () => {
      it('Then the second still types its own lookups', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const sut = revList;

        // Act
        const [, tagWalk] = await Promise.all([
          sut(ctx, { wants: [] }),
          caughtFrom(() => sut(ctx, { wants: ['t', `${blob}^{}`] })),
        ]);

        // Assert
        expect({ data: (tagWalk as TsgitError).data, logged }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: blob },
          logged: [
            `object ${blob} is a commit, not a blob`,
            `object ${blob} is a commit, not a blob`,
          ],
        });
      });
    });
  });

  describe('Given a commit whose parent is a blob nothing typed before', () => {
    describe('When the walk parses that parent', () => {
      it('Then the object is not a commit and the walk fails at the commit naming it', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const parent = await writeCommitNaming(ctx, empty, [blob]);
        const child = await writeCommitNaming(ctx, empty, [parent]);
        const sut = revList;

        // Act
        const caught = await caughtFrom(() => sut(ctx, { wants: [child] }));

        // Assert
        expect({ data: (caught as TsgitError).data, logged }).toEqual({
          data: { code: 'REVISION_WALK_FAILED', commit: parent },
          logged: [`Object ${blob} not a commit`],
        });
      });
    });
  });

  describe('Given an excluded commit whose parent is a blob nothing typed before', () => {
    describe('When the limited walk parses that parent gently', () => {
      it('Then it logs the object is not a commit and lists the included commit', async () => {
        // Arrange
        const { ctx, logged, blob } = await seedMistypedTag();
        const empty = await writeEmptyTree(ctx);
        const newer = { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 };
        const excluded = await writeObject(ctx, {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: empty,
            parents: [blob],
            author: newer,
            committer: newer,
            message: 'm\n',
            extraHeaders: [],
          },
        });
        const included = await writeCommitNaming(ctx, empty, []);
        const sut = revList;

        // Act
        const result = await sut(ctx, { wants: [included], not: [excluded] });

        // Assert
        expect({ entries: result.entries, logged }).toEqual({
          entries: [{ id: included, type: 'commit' }],
          logged: [`Object ${blob} not a commit`],
        });
      });
    });
  });
});
