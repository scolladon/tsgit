import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  rebaseAbort,
  rebaseContinue,
  rebaseRun,
  rebaseSkip,
} from '../../../../src/application/commands/rebase.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  CommitData,
  ObjectId,
  RefName,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const FEAT_AUTHOR: AuthorIdentity = {
  name: 'Feat',
  email: 'feat@y',
  timestamp: 100,
  timezoneOffset: '+0200',
};

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;
const setUser = (ctx: Context): Promise<void> =>
  ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = rb@x\n');

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const writeAddCommit = async (
  ctx: Context,
  name: string,
  body: string,
  message: string,
  author = FEAT_AUTHOR,
): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(work(ctx, name), body);
  await add(ctx, [name]);
  return (await commit(ctx, { message, author })).id;
};

const reflogMessages = async (ctx: Context, ref: string): Promise<ReadonlyArray<string>> => {
  const entries = await readReflog(ctx, ref as RefName);
  return entries.map((e) => e.message).reverse(); // newest first
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

/** main: base; topic off base adds t1, t2; main advances with m1. HEAD on topic. */
const seedDivergent = async (): Promise<{
  ctx: Context;
  mainTip: ObjectId;
  t1Author: AuthorIdentity;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { target: 'topic' });
  await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
  await writeAddCommit(ctx, 't2.txt', 't2\n', 't2');
  await checkout(ctx, { target: 'main' });
  const mainTip = await writeAddCommit(ctx, 'm1.txt', 'm1\n', 'm1');
  await checkout(ctx, { target: 'topic' });
  return { ctx, mainTip, t1Author: FEAT_AUTHOR };
};

describe('rebaseRun', () => {
  describe('Given a topic branch diverged from an advanced main', () => {
    describe('When rebased onto main', () => {
      it('Then it replays each commit single-parent, preserving authors, atop main', async () => {
        // Arrange
        const { ctx, mainTip } = await seedDivergent();

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        const t2 = await readCommit(ctx, tip);
        expect(t2.parents.length).toBe(1);
        const t1 = await readCommit(ctx, t2.parents[0] as ObjectId);
        expect(t1.parents[0]).toBe(mainTip);
        expect(t1.author).toEqual(FEAT_AUTHOR);
        expect(t1.committer.name).toBe('Ada');
      });

      it('Then the branch reflog records a single `rebase (finish): … onto <oid>`', async () => {
        // Arrange
        const { ctx, mainTip } = await seedDivergent();

        // Act
        await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        const branch = await reflogMessages(ctx, 'refs/heads/topic');
        expect(branch[0]).toBe(`rebase (finish): refs/heads/topic onto ${mainTip}`);
      });

      it('Then the HEAD reflog records start, one pick per commit, and finish', async () => {
        // Arrange
        const { ctx } = await seedDivergent();

        // Act
        await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head.slice(0, 4)).toEqual([
          'rebase (finish): returning to refs/heads/topic',
          'rebase (pick): t2',
          'rebase (pick): t1',
          'rebase (start): checkout main',
        ]);
      });
    });
  });

  describe('Given a topic already on top of upstream', () => {
    describe('When rebased', () => {
      it('Then it is a no-op with no rebase reflog entries', async () => {
        // Arrange — main = base; topic = base + t1, so onto === merge-base.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        const before = await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('up-to-date');
        expect(await resolveRef(ctx, 'refs/heads/topic' as RefName)).toBe(before);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head.some((m) => m.startsWith('rebase'))).toBe(false);
      });
    });
  });

  describe('Given a topic that is an ancestor of upstream', () => {
    describe('When rebased', () => {
      it('Then it fast-forwards to upstream with the rebase reflog dance and no picks', async () => {
        // Arrange — topic = base; main = base + m1 + m2.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await writeAddCommit(ctx, 'm1.txt', 'm1\n', 'm1');
        const mainTip = await writeAddCommit(ctx, 'm2.txt', 'm2\n', 'm2');
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        expect(await resolveRef(ctx, 'refs/heads/topic' as RefName)).toBe(mainTip);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/topic');
        expect(head.some((m) => m.startsWith('rebase (pick)'))).toBe(false);
      });
    });
  });

  describe('Given --onto a new base', () => {
    describe('When rebased', () => {
      it('Then it replays the upstream..HEAD commits onto the new base', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
        await checkout(ctx, { target: 'main' });
        await branchCreate(ctx, { name: 'newbase' });
        await checkout(ctx, { target: 'newbase' });
        const newbaseTip = await writeAddCommit(ctx, 'n1.txt', 'n1\n', 'n1');
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main', onto: 'newbase' });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        const t1 = await readCommit(ctx, tip);
        expect(t1.parents[0]).toBe(newbaseTip);
        const branch = await reflogMessages(ctx, 'refs/heads/topic');
        expect(branch[0]).toBe(`rebase (finish): refs/heads/topic onto ${newbaseTip}`);
      });
    });
  });

  describe('Given a commit that conflicts on replay', () => {
    describe('When rebased', () => {
      it('Then it stops with a detached HEAD, REBASE_HEAD and the rebase-merge state', async () => {
        // Arrange — base has f; topic t1 adds a, t2 edits f; main edits f conflictingly.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'f.txt', 'l1\nl2\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        const t2 = await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
        await checkout(ctx, { target: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind === 'conflict') expect(sut.commit).toBe(t2);
        expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`)).trim()).toBe(t2);
        expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).startsWith('ref:')).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge`)).toBe(true);
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When rebased onto main cleanly', () => {
      it('Then it replays onto main and leaves HEAD detached at the new tip (no finish reflog)', async () => {
        // Arrange — detach at topic's tip, then rebase onto the advanced main.
        const { ctx, mainTip } = await seedDivergent();
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        await checkout(ctx, { target: topicTip, detach: true });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        expect(await headIsSymbolic(ctx)).toBe(false);
        const tip = await readCommit(ctx, await resolveRef(ctx, 'HEAD' as RefName));
        const parent = await readCommit(ctx, tip.parents[0] as ObjectId);
        expect(parent.parents[0]).toBe(mainTip);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head.some((m) => m.startsWith('rebase (finish)'))).toBe(false);
        expect(head).toContain('rebase (start): checkout main');
      });
    });
  });

  describe('Given a detached-HEAD rebase that conflicts', () => {
    describe('When aborted', () => {
      it('Then it returns HEAD to the original detached oid with that reflog', async () => {
        // Arrange — build the conflict scenario but on a detached HEAD.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'f.txt', 'l1\nl2\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
        await checkout(ctx, { target: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        await checkout(ctx, { target: topicTip, detach: true });
        const origDetached = await resolveRef(ctx, 'HEAD' as RefName);
        await rebaseRun(ctx, { upstream: 'main' });

        // Act
        const sut = await rebaseAbort(ctx);

        // Assert
        expect(sut.headName).toBe('detached HEAD');
        expect(sut.head).toBe(origDetached);
        expect(await headIsSymbolic(ctx)).toBe(false);
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(origDetached);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe(`rebase (abort): returning to ${origDetached}`);
      });
    });
  });

  describe('Given a topic commit already present upstream (cherry-pick equivalent)', () => {
    describe('When rebased', () => {
      it('Then it is pre-dropped before replay, so a would-be conflict never happens', async () => {
        // Arrange — topic's `dup` edits f a->b; main applies the same a->b patch
        // then edits b->c. Replaying `dup` onto main WOULD conflict (a->b vs c),
        // but git drops it by patch-id first, so only the unique `t2` replays.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'f.txt', 'a\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 'f.txt', 'b\n', 'dup');
        const t2 = await writeAddCommit(ctx, 't2.txt', 't2\n', 't2');
        await checkout(ctx, { target: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'b\n', 'dup on main');
        await writeAddCommit(ctx, 'f.txt', 'c\n', 'm2 diverges');
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        if (sut.kind === 'rebased') {
          expect(sut.commits.map((entry) => entry.source)).toEqual([t2]);
        }
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).toContain('rebase (pick): t2');
        expect(head).not.toContain('rebase (pick): dup');
      });
    });
  });

  describe('Given refusal conditions', () => {
    describe('When the working tree is dirty', () => {
      it('Then it refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange
        const { ctx } = await seedDivergent();
        await ctx.fs.writeUtf8(work(ctx, 't1.txt'), 'dirty edit\n');

        // Act + Assert
        expect(await codeOf(() => rebaseRun(ctx, { upstream: 'main' }))).toBe('WORKING_TREE_DIRTY');
      });
    });

    describe('When another operation is already in progress', () => {
      it('Then it refuses with OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedDivergent();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'0'.repeat(40)}\n`);

        // Act + Assert
        expect(await codeOf(() => rebaseRun(ctx, { upstream: 'main' }))).toBe(
          'OPERATION_IN_PROGRESS',
        );
      });
    });

    describe('When the branch is unborn', () => {
      it('Then it refuses with NO_INITIAL_COMMIT', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);

        // Act + Assert
        expect(await codeOf(() => rebaseRun(ctx, { upstream: 'main' }))).toBe('NO_INITIAL_COMMIT');
      });
    });

    describe('When the repository is bare', () => {
      it('Then it refuses with BARE_REPOSITORY', async () => {
        // Arrange — a fresh repo so the bare config is the first one read (the
        // config cache is keyed on Context identity).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = true\n');

        // Act + Assert
        expect(await codeOf(() => rebaseRun(ctx, { upstream: 'main' }))).toBe('BARE_REPOSITORY');
      });
    });
  });
});

/** base f=l1/l2; topic adds a.txt (t1) then edits f (t2); main edits f conflictingly. */
const seedConflict = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await writeAddCommit(ctx, 'f.txt', 'l1\nl2\n', 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { target: 'topic' });
  await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
  await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
  await checkout(ctx, { target: 'main' });
  await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
  await checkout(ctx, { target: 'topic' });
  await rebaseRun(ctx, { upstream: 'main' });
  return ctx;
};

const headIsSymbolic = async (ctx: Context): Promise<boolean> =>
  (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).startsWith('ref:');

describe('rebaseContinue', () => {
  describe('Given a conflict resolved with `add`', () => {
    describe('When continued', () => {
      it('Then it commits the resolution and finishes, reattaching HEAD', async () => {
        // Arrange
        const ctx = await seedConflict();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nRESOLVED\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await rebaseContinue(ctx);

        // Assert
        expect(sut.kind).toBe('rebased');
        expect(await headIsSymbolic(ctx)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(false);
        const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/topic' as RefName));
        expect(tip.author).toEqual(FEAT_AUTHOR);
        expect(tip.message).toBe('t2\n');
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).toContain('rebase (continue): t2');
      });
    });
  });

  describe('Given an unresolved (still-conflicted) index', () => {
    describe('When continued', () => {
      it('Then it refuses with MERGE_HAS_CONFLICTS', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act + Assert
        expect(await codeOf(() => rebaseContinue(ctx))).toBe('MERGE_HAS_CONFLICTS');
      });
    });
  });

  describe('Given no rebase in progress', () => {
    describe('When continued', () => {
      it('Then it refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedDivergent();

        // Act + Assert
        expect(await codeOf(() => rebaseContinue(ctx))).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });
});

describe('rebaseSkip', () => {
  describe('Given a conflicted commit', () => {
    describe('When skipped', () => {
      it('Then it drops the commit and finishes with only the clean picks', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act
        const sut = await rebaseSkip(ctx);

        // Assert
        expect(sut.kind).toBe('rebased');
        if (sut.kind === 'rebased') expect(sut.commits.length).toBe(0);
        expect(await headIsSymbolic(ctx)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(false);
        // f.txt holds main's version (t2 dropped); a.txt (t1) survived.
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('l1\nMAIN\n');
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(true);
      });
    });
  });

  describe('Given no rebase in progress', () => {
    describe('When skipped', () => {
      it('Then it refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedDivergent();

        // Act + Assert
        expect(await codeOf(() => rebaseSkip(ctx))).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });
});

describe('rebaseAbort', () => {
  describe('Given a conflict stop', () => {
    describe('When aborted', () => {
      it('Then it restores the pre-rebase tip, reattaches HEAD, and leaves the branch reflog untouched', async () => {
        // Arrange
        const ctx = await seedConflict();
        const branchBefore = await reflogMessages(ctx, 'refs/heads/topic');

        // Act
        const sut = await rebaseAbort(ctx);

        // Assert
        expect(sut.headName).toBe('refs/heads/topic');
        expect(await headIsSymbolic(ctx)).toBe(true);
        expect(await resolveRef(ctx, 'refs/heads/topic' as RefName)).toBe(sut.head);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('l1\nTOPIC\n');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge`)).toBe(false);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (abort): returning to refs/heads/topic');
        // The branch never moved during the replay → no new branch reflog entry.
        expect(await reflogMessages(ctx, 'refs/heads/topic')).toEqual(branchBefore);
      });
    });
  });

  describe('Given no rebase in progress', () => {
    describe('When aborted', () => {
      it('Then it refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedDivergent();

        // Act + Assert
        expect(await codeOf(() => rebaseAbort(ctx))).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });
});
