import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate, branchDelete } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import {
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../../../src/application/commands/rebase.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { CommitData, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Feat', email: 'feat@y', timestamp: 100, timezoneOffset: '+0000' };

const commitFile = async (ctx: Context, name: string, body = `${name}\n`): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author: AUTHOR })).id;
};

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const headReflog = async (ctx: Context, count: number): Promise<ReadonlyArray<string>> =>
  (await readReflog(ctx, 'HEAD' as RefName))
    .map((e) => e.message)
    .reverse()
    .slice(0, count);

const rewrittenRefs = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await getRefStore(ctx).listRefs('refs/rewritten/' as RefName)).map((ref) => ref.name);

const gitFile = (ctx: Context, name: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/${name}`);

/**
 * topic: base ── c1 ── c2 ── M ── c3, side s1 forked from c1 and merged by M;
 * main advances with u1 unless `advanceMain` is false.
 */
const seed = async (
  opts: { advanceMain?: boolean; upstreamFile?: string } = {},
): Promise<{ ctx: Context }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 'c1');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'y');
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 'c2');
  await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
  await commitFile(ctx, 'c3');
  if (opts.advanceMain !== false) {
    await checkout(ctx, { rev: 'main' });
    await commitFile(ctx, opts.upstreamFile ?? 'u1');
    await checkout(ctx, { rev: 'topic' });
  }
  return { ctx };
};

describe('rebaseRun with rebaseMerges', () => {
  describe('Given interactive instructions, When rebased with rebaseMerges', () => {
    it('Then it refuses, as the instructions cannot carry merges', async () => {
      // Arrange
      const { ctx } = await seed();
      const sut = rebaseRun;
      let caught: TsgitError | undefined;

      // Act
      try {
        await sut(ctx, { upstream: 'main', rebaseMerges: true, interactive: [] });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data).toEqual({
        code: 'INVALID_OPTION',
        option: 'rebaseMerges',
        reason: 'interactive instructions cannot carry merges',
      });
    });
  });

  describe('Given a topic that merged a side branch, When rebased onto an advanced main', () => {
    it('Then the merge is recreated over the rebased side and topic commits', async () => {
      // Arrange
      const { ctx } = await seed();
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', rebaseMerges: true });

      // Assert
      expect(result.kind).toBe('rebased');
      const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
      const merge = await readCommit(ctx, tip.parents[0]!);
      expect(merge.parents).toHaveLength(2);
      expect(merge.message).toBe("Merge branch 'side' into topic\n");
      expect(await headReflog(ctx, 8)).toEqual([
        'rebase (finish): returning to refs/heads/topic',
        'rebase (pick): c3',
        "rebase (merge): Merge branch 'side' into topic",
        'rebase (pick): c2',
        "rebase (reset): 'branch-point'",
        'rebase (pick): y',
        'rebase (pick): c1',
        'rebase (start): checkout main',
      ]);
      expect(await rewrittenRefs(ctx)).toEqual([]);
    });
  });

  describe('Given main already carries the merged side commit, When rebased with rebaseMerges', () => {
    it('Then the merge has nothing left to merge and is dropped', async () => {
      // Arrange
      const { ctx } = await seed({ upstreamFile: 'y' });
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', rebaseMerges: true });

      // Assert
      expect(result.kind).toBe('rebased');
      const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
      expect((await readCommit(ctx, tip.parents[0]!)).message).toBe('c2\n');
      expect(await headReflog(ctx, 3)).toEqual([
        'rebase (finish): returning to refs/heads/topic',
        'rebase (pick): c3',
        'rebase (pick): c2',
      ]);
    });
  });

  describe('Given a topic with a merge already on main, When rebased with rebaseMerges', () => {
    it('Then every instruction fast-forwards and the branch keeps its commits', async () => {
      // Arrange
      const { ctx } = await seed({ advanceMain: false });
      const before = await resolveRef(ctx, 'refs/heads/topic' as RefName);
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', rebaseMerges: 'no-rebase-cousins' });

      // Assert
      expect(result.kind).toBe('rebased');
      expect(await resolveRef(ctx, 'refs/heads/topic' as RefName)).toBe(before);
      expect(await headReflog(ctx, 7)).toEqual([
        'rebase (finish): returning to refs/heads/topic',
        'rebase: fast-forward',
        'rebase: fast-forward',
        'rebase: fast-forward',
        "rebase (reset): 'branch-point'",
        'rebase: fast-forward',
        'rebase: fast-forward',
      ]);
    });
  });

  describe.each([
    [
      true,
      [
        'rebase (finish): returning to refs/heads/topic',
        "rebase (merge): Merge branch 'side' into topic",
        'rebase: fast-forward',
        "rebase (reset): '<abbrev>'",
        'rebase (pick): s1',
        'rebase (start): checkout main',
      ],
    ],
    [
      'no-rebase-cousins',
      [
        'rebase (finish): returning to refs/heads/topic',
        "rebase (merge): Merge branch 'side' into topic",
        'rebase: fast-forward',
        "rebase (reset): '<abbrev>'",
        'rebase (pick): s1',
        'rebase (start): checkout main',
      ],
    ],
    [
      'rebase-cousins',
      [
        'rebase (finish): returning to refs/heads/topic',
        "rebase (merge): Merge branch 'side' into topic",
        'rebase (pick): c1',
        "rebase (reset): 'onto'",
        'rebase (pick): s1',
        'rebase (start): checkout main',
      ],
    ],
  ] as const)(
    'Given a merged side branch rooted outside the range, When rebased with rebaseMerges %s',
    (mode, reflog) => {
      it('Then the cousin lands where git puts it', async () => {
        // Arrange
        const ctx = await cousinSeed();
        const sut = rebaseRun;

        // Act
        await sut(ctx, { upstream: 'main', rebaseMerges: mode });

        // Assert
        const messages = (await headReflog(ctx, reflog.length)).map((message) =>
          message.replace(/'[0-9a-f]{7}'/, "'<abbrev>'"),
        );
        expect(messages).toEqual(reflog);
      });
    },
  );

  describe('Given a topic commit that starts empty, When rebased with rebaseMerges', () => {
    it('Then the replay keeps it as an empty commit over the rebased parent', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      await ctx.fs.appendUtf8(
        `${ctx.layout.gitDir}/config`,
        '\n[user]\n\tname = Ada\n\temail = a@x\n',
      );
      await commitFile(ctx, 'base');
      await branchCreate(ctx, { name: 'topic' });
      await checkout(ctx, { rev: 'topic' });
      await commitFile(ctx, 't1');
      await commit(ctx, { message: 'empty', author: AUTHOR, allowEmpty: true });
      await checkout(ctx, { rev: 'main' });
      await commitFile(ctx, 'u1');
      await checkout(ctx, { rev: 'topic' });
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', rebaseMerges: true });

      // Assert
      expect(result.kind).toBe('rebased');
      const kept = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
      const parent = await readCommit(ctx, kept.parents[0]!);
      expect(kept.message).toBe('empty\n');
      expect(kept.tree).toBe(parent.tree);
      expect(parent.message).toBe('t1\n');
    });
  });

  describe('Given the recreated merge conflicts', () => {
    describe('When rebased with rebaseMerges', () => {
      it('Then it stops on the merge with git-shaped state', async () => {
        // Arrange
        const { ctx, merge } = await conflictingSeed();
        const sut = rebaseRun;

        // Act
        const result = await sut(ctx, { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(result).toMatchObject({ kind: 'conflict', commit: merge, remaining: 1 });
        expect(await gitFile(ctx, 'MERGE_MODE')).toBe('no-ff');
        expect(await gitFile(ctx, 'MERGE_HEAD')).toBe(
          await resolveRef(ctx, 'refs/rewritten/side' as RefName),
        );
        expect(await gitFile(ctx, 'MERGE_MSG')).toBe("Merge branch 'side' into topic\n");
        expect(await gitFile(ctx, 'rebase-merge/refs-to-delete')).toBe(
          'refs/rewritten/onto\nrefs/rewritten/branch-point\nrefs/rewritten/side\n',
        );
        expect(await gitFile(ctx, 'rebase-merge/patch')).toBe('');
      });
    });

    describe('When rebased with rebaseMerges and stopped on the merge', () => {
      it("Then the message is the merge's own and its rewrite to HEAD is recorded", async () => {
        // Arrange
        const { ctx, merge } = await conflictingSeed();
        const sut = rebaseRun;

        // Act
        await sut(ctx, { upstream: 'main', rebaseMerges: true });

        // Assert
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        expect(await gitFile(ctx, 'rebase-merge/message')).toBe("Merge branch 'side' into topic\n");
        const recorded = (await gitFile(ctx, 'rebase-merge/rewritten-list')).trimEnd().split('\n');
        expect(recorded.at(-1)).toBe(`${merge} ${head}`);
      });
    });

    describe('When the conflict is resolved and the rebase continued', () => {
      it('Then the resolution commits as the two-parent merge and the labels go', async () => {
        // Arrange
        const { ctx } = await conflictingSeed();
        await rebaseRun(ctx, { upstream: 'main', rebaseMerges: true });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y`, 'st\n');
        await add(ctx, ['y']);
        const sut = rebaseContinue;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.kind).toBe('rebased');
        const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
        const merge = await readCommit(ctx, tip.parents[0]!);
        expect(merge.parents).toHaveLength(2);
        expect(merge.author).toEqual(AUTHOR);
        expect((await headReflog(ctx, 3))[2]).toBe(
          "rebase (continue): Merge branch 'side' into topic",
        );
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await rewrittenRefs(ctx)).toEqual([]);
      });
    });

    describe('When the merge is skipped', () => {
      it('Then the rebase finishes without it', async () => {
        // Arrange
        const { ctx } = await conflictingSeed();
        await rebaseRun(ctx, { upstream: 'main', rebaseMerges: true });
        const sut = rebaseSkip;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.kind).toBe('rebased');
        const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
        expect((await readCommit(ctx, tip.parents[0]!)).parents).toHaveLength(1);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });

    describe('When the rebase is aborted', () => {
      it('Then the labels are deleted', async () => {
        // Arrange
        const { ctx } = await conflictingSeed();
        await rebaseRun(ctx, { upstream: 'main', rebaseMerges: true });
        const sut = rebaseAbort;

        // Act
        await sut(ctx);

        // Assert
        expect(await rewrittenRefs(ctx)).toEqual([]);
      });
    });
  });
});

/** main: base, m1, u1; side s1 off m1; topic c1 off base merges side — s1's block is a cousin. */
const cousinSeed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 'c1');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'm1');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 's1');
  await checkout(ctx, { rev: 'topic' });
  await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
  await branchDelete(ctx, { name: 'side', force: true });
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'u1');
  await checkout(ctx, { rev: 'topic' });
  return ctx;
};

/** The merge resolved a `y` add/add conflict by hand, so replaying it conflicts again. */
const conflictingSeed = async (): Promise<{ ctx: Context; merge: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 'c1');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'y', 's\n');
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 'y', 't\n');
  await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/y`, 'st\n');
  await add(ctx, ['y']);
  const merge = (await commit(ctx, { message: "Merge branch 'side' into topic", author: AUTHOR }))
    .id;
  await commitFile(ctx, 'c3');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'u1');
  await checkout(ctx, { rev: 'topic' });
  return { ctx, merge };
};
