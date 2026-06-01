import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { bindRebaseNamespace } from '../../../../src/application/commands/internal/rebase-namespace.js';
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

const readMerge = (ctx: Context, name: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/rebase-merge/${name}`);

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

const dataOf = async (
  run: () => Promise<unknown>,
): Promise<{ code: string; operation?: string; paths?: ReadonlyArray<string> }> => {
  try {
    await run();
    throw new Error('expected an error');
  } catch (err) {
    return (err as TsgitError).data as {
      code: string;
      operation?: string;
      paths?: ReadonlyArray<string>;
    };
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

  describe('Given a 3-commit topic whose middle commit conflicts on replay', () => {
    describe('When rebased', () => {
      it('Then it stops detached with byte-faithful rebase-merge state at the conflict', async () => {
        // Arrange — base f; topic t1 adds a, t2 edits f (conflicts), t3 adds c;
        // main edits f conflictingly. So t1 replays clean, t2 stops, t3 remains.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'f.txt', 'l1\nl2\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        const t1 = await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        const t2 = await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
        const t3 = await writeAddCommit(ctx, 'c.txt', 'c\n', 't3');
        await checkout(ctx, { target: 'main' });
        const mainTip = await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        await checkout(ctx, { target: 'topic' });
        const short = (oid: ObjectId): string => oid.slice(0, 7);

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert — result
        expect(sut.kind).toBe('conflict');
        if (sut.kind === 'conflict') {
          expect(sut.commit).toBe(t2);
          expect(sut.remaining).toBe(1);
        }
        // HEAD detached at the last good pick; REBASE_HEAD + stopped-sha = t2
        expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`)).startsWith('ref:')).toBe(false);
        expect((await ctx.fs.readUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`)).trim()).toBe(t2);
        expect(await readMerge(ctx, 'stopped-sha')).toBe(`${t2}\n`);
        // Byte-faithful state files
        expect(await readMerge(ctx, 'head-name')).toBe('refs/heads/topic\n');
        expect(await readMerge(ctx, 'onto')).toBe(`${mainTip}\n`);
        expect(await readMerge(ctx, 'orig-head')).toBe(`${t3}\n`);
        expect(await readMerge(ctx, 'git-rebase-todo')).toBe(`pick ${t3} # t3\n`);
        expect(await readMerge(ctx, 'done')).toBe(`pick ${t1} # t1\npick ${t2} # t2\n`);
        expect(await readMerge(ctx, 'end')).toBe('3\n');
        expect(await readMerge(ctx, 'msgnum')).toBe('2\n');
        expect(await readMerge(ctx, 'message')).toBe('t2\n\n# Conflicts:\n#\tf.txt\n');
        expect(await readMerge(ctx, 'author-script')).toContain("GIT_AUTHOR_NAME='Feat'");
        // rewritten-list maps the clean t1 to its replayed oid
        expect(await readMerge(ctx, 'rewritten-list')).toMatch(
          new RegExp(`^${t1} [0-9a-f]{40}\\n$`),
        );
        // patch is the failed pick's `a/`..`b/` unified diff
        const patch = await readMerge(ctx, 'patch');
        expect(patch).toContain('--- a/f.txt');
        expect(patch).toContain('+++ b/f.txt');
        expect(patch).toContain('@@');
        // backup: 7-char abbreviated header + the fixed help block
        const backup = await readMerge(ctx, 'git-rebase-todo.backup');
        expect(backup).toContain(
          `# Rebase ${short(mainTip)}..${short(t3)} onto ${short(mainTip)} (3 commands)\n`,
        );
        expect(backup).toContain('# Commands:\n');
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

    describe('When the branch ref is corrupt (present but not a valid oid)', () => {
      it('Then the underlying error propagates — it is NOT masked as NO_INITIAL_COMMIT', async () => {
        // Arrange — a real (non-REF_NOT_FOUND) failure resolving HEAD's branch must
        // not be swallowed into the unborn-branch path.
        const { ctx } = await seedDivergent();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/topic`, 'not-a-valid-oid\n');

        // Act
        const code = await codeOf(() => rebaseRun(ctx, { upstream: 'main' }));

        // Assert
        expect(code).toBeDefined();
        expect(code).not.toBe('NO_INITIAL_COMMIT');
      });
    });

    describe.each([
      ['run', (ctx: Context) => rebaseRun(ctx, { upstream: 'main' }), 'rebase'],
      ['continue', (ctx: Context) => rebaseContinue(ctx), 'rebase --continue'],
      ['skip', (ctx: Context) => rebaseSkip(ctx), 'rebase --skip'],
      ['abort', (ctx: Context) => rebaseAbort(ctx), 'rebase --abort'],
    ])('When %s runs in a bare repository', (_verb, call, operation) => {
      it(`Then it refuses with BARE_REPOSITORY for "${operation}"`, async () => {
        // Arrange — a fresh repo so the bare config is the first one read (the
        // config cache is keyed on Context identity).
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = true\n');

        // Act
        const data = await dataOf(() => call(ctx));

        // Assert
        expect(data.code).toBe('BARE_REPOSITORY');
        expect(data.operation).toBe(operation);
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
        if (sut.kind === 'rebased') {
          // the resolution of the stopped commit is the single replayed commit
          expect(sut.commits.length).toBe(1);
        }
        expect(await headIsSymbolic(ctx)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(false);
        const tipId = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        const tip = await readCommit(ctx, tipId);
        expect(tip.author).toEqual(FEAT_AUTHOR);
        expect(tip.message).toBe('t2\n');
        expect(tip.parents.length).toBe(1); // single-parent on the replayed base
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).toContain('rebase (continue): t2');
      });
    });
  });

  describe('Given an unresolved (still-conflicted) index', () => {
    describe('When continued', () => {
      it('Then it refuses with MERGE_HAS_CONFLICTS naming the conflicted path', async () => {
        // Arrange
        const ctx = await seedConflict();

        // Act
        const data = await dataOf(() => rebaseContinue(ctx));

        // Assert
        expect(data.code).toBe('MERGE_HAS_CONFLICTS');
        expect(data.paths).toContain('f.txt');
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

describe('rebase edge cases', () => {
  describe('Given a commit that becomes empty only after replay (not a patch-id pre-drop)', () => {
    describe('When rebased', () => {
      it('Then it is dropped, not committed empty', async () => {
        // Arrange — topic adds x='v'; main adds x='v' AND y='w' in one commit, so
        // their patch-ids differ (no pre-drop), yet replaying topic's add onto main
        // yields no net change → it must drop as empty.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 'x.txt', 'v\n', 'add x');
        // A real follow-up commit: the empty `add x` must release its index lock
        // before this one acquires it, else the replay deadlocks.
        await writeAddCommit(ctx, 'z.txt', 'z\n', 'add z');
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'x.txt'), 'v\n');
        await ctx.fs.writeUtf8(work(ctx, 'y.txt'), 'w\n');
        await add(ctx, ['x.txt', 'y.txt']);
        await commit(ctx, { message: 'add x and y', author: FEAT_AUTHOR });
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert — only `add z` replayed; `add x` dropped as empty
        expect(sut.kind).toBe('rebased');
        if (sut.kind === 'rebased') expect(sut.commits.length).toBe(1);
        expect(await ctx.fs.exists(work(ctx, 'z.txt'))).toBe(true);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).not.toContain('rebase (pick): add x');
        expect(head).toContain('rebase (pick): add z');
      });
    });
  });

  describe('Given --onto a base that does not contain the fork point', () => {
    describe('When rebased', () => {
      it('Then only upstream..HEAD is replayed — the merge-base commit is excluded', async () => {
        // Arrange — main: R -> A -> B; topic forks at A and adds t1; newbase forks
        // at R (before A) and adds n1. `--onto newbase main` must replay only t1,
        // NOT A (the merge-base), so a.txt never appears on the result.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        const root = await writeAddCommit(ctx, 'base.txt', 'base\n', 'R');
        await writeAddCommit(ctx, 'a.txt', 'a\n', 'A');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { target: 'topic' });
        await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
        await checkout(ctx, { target: 'main' });
        await writeAddCommit(ctx, 'b.txt', 'b\n', 'B');
        await branchCreate(ctx, { name: 'newbase', startPoint: root });
        await checkout(ctx, { target: 'newbase' });
        await writeAddCommit(ctx, 'n1.txt', 'n1\n', 'n1');
        await checkout(ctx, { target: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main', onto: 'newbase' });

        // Assert — t1 replayed onto newbase; a.txt (from the excluded merge-base) absent
        expect(sut.kind).toBe('rebased');
        if (sut.kind === 'rebased') expect(sut.commits.length).toBe(1);
        expect(await ctx.fs.exists(work(ctx, 't1.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'n1.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'a.txt'))).toBe(false);
      });
    });
  });

  describe('Given a continue whose next commit also conflicts', () => {
    describe('When it re-stops', () => {
      it('Then the rewritten-list carries every commit replayed so far', async () => {
        // Arrange — base f=l1/l2/l3; topic t1 adds a, t2 edits l2, t3 edits l3; main
        // edits both l2 and l3, so t2 conflicts, then (after continue) t3 conflicts.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        const t1 = await (async () => {
          await writeAddCommit(ctx, 'f.txt', 'l1\nl2\nl3\n', 'base');
          await branchCreate(ctx, { name: 'topic' });
          await checkout(ctx, { target: 'topic' });
          return writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        })();
        await writeAddCommit(ctx, 'f.txt', 'l1\nT2\nl3\n', 't2');
        await writeAddCommit(ctx, 'f.txt', 'l1\nT2\nT3\n', 't3');
        await checkout(ctx, { target: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nM2\nM3\n', 'm1');
        await checkout(ctx, { target: 'topic' });
        const firstStop = await rebaseRun(ctx, { upstream: 'main' });
        expect(firstStop.kind).toBe('conflict'); // t2 conflicts on line 2
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nR2\nM3\n');
        await add(ctx, ['f.txt']);

        // Act — continue commits t2's resolution, then t3 conflicts → re-stop
        const reStop = await rebaseContinue(ctx);

        // Assert — re-stopped, rewritten-list maps both t1 and t2 to replayed oids
        expect(reStop.kind).toBe('conflict');
        const rewritten = await readMerge(ctx, 'rewritten-list');
        const lines = rewritten.trimEnd().split('\n');
        expect(lines.length).toBe(2);
        expect(lines[0]?.startsWith(t1)).toBe(true);
      });
    });
  });
});

describe('bindRebaseNamespace', () => {
  describe('Given the bound namespace', () => {
    describe('When each verb is called', () => {
      it('Then it runs the guard and forwards to the command', async () => {
        // Arrange
        const { ctx } = await seedDivergent();
        let guarded = 0;
        const ns = bindRebaseNamespace(ctx, () => {
          guarded += 1;
        });

        // Act
        const run = await ns.run({ upstream: 'main' });

        // Assert — run forwarded; the other verbs forward + throw (nothing in progress)
        expect(run.kind).toBe('rebased');
        await expect(ns.continue()).rejects.toThrow();
        await expect(ns.skip()).rejects.toThrow();
        await expect(ns.abort()).rejects.toThrow();
        expect(guarded).toBe(4);
        expect(Object.isFrozen(ns)).toBe(true);
      });
    });
  });
});
