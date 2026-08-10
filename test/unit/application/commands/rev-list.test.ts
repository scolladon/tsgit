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
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

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
        const annotated = await tagCreate(ctx, {
          name: 'v-annotated',
          target: featureTip,
          message: 'release',
        });
        const sut = revList;

        // Act
        const result = await sut(ctx, { all: true });

        // Assert
        const ids = new Set(result.entries.map((e) => e.id));
        expect(ids).toEqual(new Set([base, featureTip, annotated.id]));
        expect(result.entries).toHaveLength(3);
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
        await branchDelete(ctx, { name: 'orphan' });
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
