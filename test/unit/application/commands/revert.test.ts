import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { merge } from '../../../../src/application/commands/merge.js';
import { revertContinue, revertRun } from '../../../../src/application/commands/revert.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
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

const MAIN_AUTHOR: AuthorIdentity = {
  name: 'Main',
  email: 'main@z',
  timestamp: 1,
  timezoneOffset: '+0000',
};

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

const setUser = (ctx: Context): Promise<void> =>
  ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Vera\n\temail = vera@x\n');

const readCommit = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw new Error('not a commit');
  return obj.data;
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (err) {
    return (err as TsgitError).data.code;
  }
};

const gitDir = (ctx: Context): string => ctx.layout.gitDir;
const exists = (ctx: Context, rel: string): Promise<boolean> =>
  ctx.fs.exists(`${gitDir(ctx)}/${rel}`);

/** Linear history on main: c1 base, c2 changes line 2. Returns ctx + ids. */
const seedLinear = async (): Promise<{ ctx: Context; c1: ObjectId; c2: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nb\nc\n');
  await add(ctx, ['f.txt']);
  const c1 = await commit(ctx, { message: 'c1 base', author: MAIN_AUTHOR });
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nB2\nc\n');
  await add(ctx, ['f.txt']);
  const c2 = await commit(ctx, { message: 'c2 mid', author: MAIN_AUTHOR });
  return { ctx, c1: c1.id, c2: c2.id };
};

describe('revert run', () => {
  describe('Given a clean single revert of the tip', () => {
    describe('When revertRun targets HEAD', () => {
      it('Then creates a single-parent Revert commit authored by the current identity', async () => {
        // Arrange
        const { ctx, c1, c2 } = await seedLinear();

        // Act
        const sut = await revertRun(ctx, { commits: ['HEAD'] });

        // Assert
        expect(sut.kind).toBe('reverted');
        if (sut.kind !== 'reverted') throw new Error('expected reverted');
        expect(sut.commits).toHaveLength(1);
        const created = sut.commits[0]?.created as ObjectId;
        expect(sut.commits[0]?.source).toBe(c2);
        const cData = await readCommit(ctx, created);
        expect(cData.parents).toEqual([c2]);
        expect(cData.author.name).toBe('Vera');
        expect(cData.author.email).toBe('vera@x');
        expect(cData.committer.name).toBe('Vera');
        expect(cData.committer.email).toBe('vera@x');
        expect(cData.message).toBe(`Revert "c2 mid"\n\nThis reverts commit ${c2}.\n`);
        // the reverse merge restores c1's tree
        expect(cData.tree).toBe((await readCommit(ctx, c1)).tree);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toBe('a\nb\nc\n');
        expect(await resolveRef(ctx, 'refs/heads/main' as RefName)).toBe(created);
      });
    });

    describe('When the revert commits cleanly', () => {
      it('Then records a `revert: Revert "<subject>"` reflog entry', async () => {
        // Arrange
        const { ctx } = await seedLinear();

        // Act
        await revertRun(ctx, { commits: ['HEAD'] });

        // Assert
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(reflog.at(-1)?.message).toBe('revert: Revert "c2 mid"');
      });

      it('Then leaves no in-progress state', async () => {
        // Arrange
        const { ctx } = await seedLinear();

        // Act
        await revertRun(ctx, { commits: ['HEAD'] });

        // Assert
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'MERGE_MSG')).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(false);
      });
    });
  });

  describe('Given a revert that conflicts with later history', () => {
    describe('When the reverse merge cannot apply cleanly', () => {
      it('Then stops with REVERT_HEAD, the Revert MERGE_MSG, and unmerged index', async () => {
        // Arrange — c3 changes the same line c2 did, so reverting c2 conflicts.
        const { ctx, c2 } = await seedLinear();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nB3\nc\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'c3 top', author: MAIN_AUTHOR });

        // Act
        const sut = await revertRun(ctx, { commits: [c2] });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') throw new Error('expected conflict');
        expect(sut.commit).toBe(c2);
        expect(sut.remaining).toBe(0);
        expect(sut.conflicts.map((c) => c.path)).toContain('f.txt');
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/REVERT_HEAD`)).toBe(`${c2}\n`);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/MERGE_MSG`)).toBe(
          `Revert "c2 mid"\n\nThis reverts commit ${c2}.\n\n# Conflicts:\n#\tf.txt\n`,
        );
        const index = await readIndex(ctx);
        expect(index.entries.some((e) => e.flags.stage !== 0)).toBe(true);
        expect(await ctx.fs.readUtf8(work(ctx, 'f.txt'))).toContain('<<<<<<<');
      });
    });
  });

  describe('Given a revert whose change is already undone', () => {
    describe('When reverting the same commit twice', () => {
      it('Then the second revert stops empty with no in-progress state', async () => {
        // Arrange
        const { ctx, c2 } = await seedLinear();
        await revertRun(ctx, { commits: [c2] });

        // Act — c2 is already reverted, so reverting it again is a no-op.
        const sut = await revertRun(ctx, { commits: [c2] });

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind !== 'empty') throw new Error('expected empty');
        expect(sut.commit).toBe(c2);
        expect(sut.remaining).toBe(0);
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'MERGE_MSG')).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(false);
      });
    });
  });

  describe('Given a root commit', () => {
    describe('When reverting it', () => {
      it('Then deletes every path the root introduced', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f1.txt'), '1\n');
        await ctx.fs.writeUtf8(work(ctx, 'f2.txt'), '2\n');
        await add(ctx, ['f1.txt', 'f2.txt']);
        const root = await commit(ctx, { message: 'c1 root', author: MAIN_AUTHOR });
        await ctx.fs.writeUtf8(work(ctx, 'f3.txt'), '3\n');
        await add(ctx, ['f3.txt']);
        await commit(ctx, { message: 'c2 add f3', author: MAIN_AUTHOR });

        // Act
        const sut = await revertRun(ctx, { commits: [root.id] });

        // Assert
        expect(sut.kind).toBe('reverted');
        expect(await ctx.fs.exists(work(ctx, 'f1.txt'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'f2.txt'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'f3.txt'))).toBe(true);
      });
    });
  });

  describe('Given an untracked working file the revert would re-create', () => {
    describe('When the reverse merge would overwrite it', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange — c2 deletes gone.txt; an untracked gone.txt sits on HEAD.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'gone.txt'), 'v1\n');
        await ctx.fs.writeUtf8(work(ctx, 'anchor.txt'), 'x\n');
        await add(ctx, ['gone.txt', 'anchor.txt']);
        await commit(ctx, { message: 'c1 add gone', author: MAIN_AUTHOR });
        await rm(ctx, ['gone.txt']);
        const c2 = await commit(ctx, { message: 'c2 delete gone', author: MAIN_AUTHOR });
        await ctx.fs.writeUtf8(work(ctx, 'gone.txt'), 'untracked junk\n');

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [c2.id] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });

  describe('Given a merge commit', () => {
    describe('When reverting it without a mainline', () => {
      it('Then refuses with REVERT_MERGE_NO_MAINLINE and persists no state', async () => {
        // Arrange — build a real two-parent merge commit on a side branch, then
        // revert it by oid from a clean `main`.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'a\n');
        await add(ctx, ['base.txt']);
        const base = await commit(ctx, { message: 'c1 base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(work(ctx, 'feat.txt'), 'f\n');
        await add(ctx, ['feat.txt']);
        await commit(ctx, { message: 'feat commit', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'side', startPoint: base.id });
        await checkout(ctx, { target: 'side' });
        await ctx.fs.writeUtf8(work(ctx, 'side.txt'), 's\n');
        await add(ctx, ['side.txt']);
        await commit(ctx, { message: 'side commit', author: MAIN_AUTHOR });
        await checkout(ctx, { target: 'feature' });
        const m = await merge(ctx, { target: 'side' });
        if (m.kind !== 'merge') throw new Error('seed: expected a merge commit');
        await checkout(ctx, { target: 'main' });

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [m.id] }));

        // Assert
        expect(code).toBe('REVERT_MERGE_NO_MAINLINE');
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(false);
      });
    });
  });

  describe('Given an invalid repository state', () => {
    describe('When HEAD is detached', () => {
      it('Then refuses with UNSUPPORTED_OPERATION', async () => {
        // Arrange
        const { ctx, c2 } = await seedLinear();
        await ctx.fs.writeUtf8(`${gitDir(ctx)}/HEAD`, `${c2}\n`);

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [c2] }));

        // Assert
        expect(code).toBe('UNSUPPORTED_OPERATION');
      });
    });

    describe('When the branch is unborn', () => {
      it('Then refuses with NO_INITIAL_COMMIT', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: ['HEAD'] }));

        // Assert
        expect(code).toBe('NO_INITIAL_COMMIT');
      });
    });

    describe('When another operation is already in progress', () => {
      it('Then refuses with OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx, c2 } = await seedLinear();
        await ctx.fs.writeUtf8(`${gitDir(ctx)}/MERGE_HEAD`, `${c2}\n`);

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [c2] }));

        // Assert
        expect(code).toBe('OPERATION_IN_PROGRESS');
      });
    });

    describe('When the working tree is dirty', () => {
      it('Then refuses with WORKING_TREE_DIRTY', async () => {
        // Arrange
        const { ctx, c2 } = await seedLinear();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'dirty\n');

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [c2] }));

        // Assert
        expect(code).toBe('WORKING_TREE_DIRTY');
      });
    });
  });
});

/** main: c1 base, then c2/c3/c4 each add a distinct file. Returns ctx + ids. */
const seedFourFiles = async (): Promise<{
  ctx: Context;
  c1: ObjectId;
  c2: ObjectId;
  c3: ObjectId;
  c4: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await ctx.fs.writeUtf8(work(ctx, 'f1.txt'), '1\n');
  await add(ctx, ['f1.txt']);
  const c1 = await commit(ctx, { message: 'c1 add f1', author: MAIN_AUTHOR });
  const ids: ObjectId[] = [];
  for (const n of [2, 3, 4]) {
    await ctx.fs.writeUtf8(work(ctx, `f${n}.txt`), `${n}\n`);
    await add(ctx, [`f${n}.txt`]);
    ids.push((await commit(ctx, { message: `c${n} add f${n}`, author: MAIN_AUTHOR })).id);
  }
  return { ctx, c1: c1.id, c2: ids[0] as ObjectId, c3: ids[1] as ObjectId, c4: ids[2] as ObjectId };
};

describe('revert range and sequencer', () => {
  describe('Given a clean A..B range', () => {
    describe('When reverting it', () => {
      it('Then reverts every commit newest-first and leaves no sequencer', async () => {
        // Arrange
        const { ctx, c1, c2, c3, c4 } = await seedFourFiles();

        // Act
        const sut = await revertRun(ctx, { commits: [`${c1}..HEAD`] });

        // Assert
        expect(sut.kind).toBe('reverted');
        if (sut.kind !== 'reverted') throw new Error('expected reverted');
        expect(sut.commits.map((c) => c.source)).toEqual([c4, c3, c2]);
        expect(await ctx.fs.exists(work(ctx, 'f1.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'f2.txt'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'f3.txt'))).toBe(false);
        expect(await ctx.fs.exists(work(ctx, 'f4.txt'))).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(false);
      });
    });
  });

  describe('Given a range whose newest revert conflicts', () => {
    describe('When reverting it', () => {
      it('Then stops with REVERT_HEAD and a git-faithful sequencer dir', async () => {
        // Arrange — c4 (not reverted) re-edits the line c3 touched, so reverting
        // c3 conflicts. Revert c1..c3 = {c2, c3} newest-first → c3 stops first.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nb\n');
        await add(ctx, ['f.txt']);
        const c1 = (await commit(ctx, { message: 'c1 base', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nB2\n');
        await add(ctx, ['f.txt']);
        const c2 = (await commit(ctx, { message: 'c2 line2', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'A3\nB2\n');
        await add(ctx, ['f.txt']);
        const c3 = (await commit(ctx, { message: 'c3 line1', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'A4\nB2\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'c4 line1 again', author: MAIN_AUTHOR });
        const head = await resolveRef(ctx, 'refs/heads/main' as RefName);

        // Act
        const sut = await revertRun(ctx, { commits: [`${c1}..${c3}`] });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind !== 'conflict') throw new Error('expected conflict');
        expect(sut.commit).toBe(c3);
        expect(sut.remaining).toBe(1);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/REVERT_HEAD`)).toBe(`${c3}\n`);
        const todo = await ctx.fs.readUtf8(`${gitDir(ctx)}/sequencer/todo`);
        expect(todo).toBe(`revert ${c3} c3 line1\nrevert ${c2} c2 line2\n`);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/sequencer/head`)).toBe(`${head}\n`);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/sequencer/abort-safety`)).toBe(`${head}\n`);
        expect(await exists(ctx, 'sequencer/opts')).toBe(false);
      });
    });
  });

  describe('Given a multi-arg revert where a later commit is already undone', () => {
    describe('When the second revert is empty', () => {
      it('Then stops empty with the sequencer persisted and no REVERT_HEAD', async () => {
        // Arrange — reverting c2 twice: the first commits, the second is empty.
        const { ctx, c2 } = await seedLinear();

        // Act
        const sut = await revertRun(ctx, { commits: [c2, c2] });

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind !== 'empty') throw new Error('expected empty');
        expect(sut.commit).toBe(c2);
        expect(sut.remaining).toBe(0);
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(true);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/sequencer/todo`)).toBe(
          `revert ${c2} c2 mid\n`,
        );
      });
    });
  });

  describe('Given a range containing a merge commit', () => {
    describe('When reverting it', () => {
      it('Then reverts the newer commits, stops at the merge with sequencer state', async () => {
        // Arrange — main: c1 → merge(side) → top. Revert c1..HEAD reverts top,
        // then stops at the merge.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'base.txt'), 'a\n');
        await add(ctx, ['base.txt']);
        const c1 = await commit(ctx, { message: 'c1 base', author: MAIN_AUTHOR });
        await branchCreate(ctx, { name: 'side', startPoint: c1.id });
        await checkout(ctx, { target: 'side' });
        await ctx.fs.writeUtf8(work(ctx, 'side.txt'), 's\n');
        await add(ctx, ['side.txt']);
        await commit(ctx, { message: 'side commit', author: MAIN_AUTHOR });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'main.txt'), 'm\n');
        await add(ctx, ['main.txt']);
        await commit(ctx, { message: 'main commit', author: MAIN_AUTHOR });
        const m = await merge(ctx, { target: 'side' });
        if (m.kind !== 'merge') throw new Error('seed: expected a merge commit');
        await ctx.fs.writeUtf8(work(ctx, 'top.txt'), 't\n');
        await add(ctx, ['top.txt']);
        const top = await commit(ctx, { message: 'top commit', author: MAIN_AUTHOR });

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [`${c1.id}..HEAD`] }));

        // Assert
        expect(code).toBe('REVERT_MERGE_NO_MAINLINE');
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'sequencer')).toBe(true);
        const todo = await ctx.fs.readUtf8(`${gitDir(ctx)}/sequencer/todo`);
        expect(todo.split('\n')[0]?.startsWith(`revert ${m.id} `)).toBe(true);
        // the `top` revert committed before the merge stop advanced HEAD past top
        const newHead = await resolveRef(ctx, 'refs/heads/main' as RefName);
        expect((await readCommit(ctx, newHead)).parents).toEqual([top.id]);
      });
    });
  });

  describe('Given an unsupported revision form', () => {
    describe.each([
      ['symmetric', '...'],
      ['exclusion', '^'],
    ])('When the arg uses %s syntax', (_label, op) => {
      it('Then refuses with INVALID_OPTION rather than mis-expanding', async () => {
        // Arrange
        const { ctx, c1, c2 } = await seedLinear();
        const arg = op === '^' ? `^${c1}` : `${c1}...${c2}`;

        // Act
        const code = await codeOf(() => revertRun(ctx, { commits: [arg] }));

        // Assert
        expect(code).toBe('INVALID_OPTION');
      });
    });
  });
});

/** Seed a stopped single-revert conflict: revert c2 conflicts vs c3 (HEAD). */
const seedConflictStop = async (): Promise<{ ctx: Context; c2: ObjectId }> => {
  const { ctx, c2 } = await seedLinear();
  await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nB3\nc\n');
  await add(ctx, ['f.txt']);
  await commit(ctx, { message: 'c3 top', author: MAIN_AUTHOR });
  const stop = await revertRun(ctx, { commits: [c2] });
  if (stop.kind !== 'conflict') throw new Error('seed: expected a conflict stop');
  return { ctx, c2 };
};

describe('revert continue', () => {
  describe('Given a resolved single-revert conflict', () => {
    describe('When continue runs', () => {
      it('Then commits the resolution with a plain `commit:` reflog and clears the state', async () => {
        // Arrange
        const { ctx, c2 } = await seedConflictStop();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nRESOLVED\nc\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await revertContinue(ctx);

        // Assert
        expect(sut.kind).toBe('reverted');
        if (sut.kind !== 'reverted') throw new Error('expected reverted');
        expect(sut.commits.map((c) => c.source)).toEqual([c2]);
        const reflog = await readReflog(ctx, 'refs/heads/main' as RefName);
        expect(reflog.at(-1)?.message).toBe('commit: Revert "c2 mid"');
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
        expect(await exists(ctx, 'MERGE_MSG')).toBe(false);
        const created = sut.commits[0]?.created as ObjectId;
        expect((await readCommit(ctx, created)).parents).toHaveLength(1);
      });
    });
  });

  describe('Given a resolved range-revert conflict with more to do', () => {
    describe('When continue runs', () => {
      it('Then commits the resolution then reverts the remaining commits', async () => {
        // Arrange — c2 edits g.txt, c3 edits f.txt, c4 re-edits f.txt so
        // reverting c3 conflicts. The remaining c2 revert touches only g.txt and
        // applies cleanly. Range c1..c3 = {c3, c2} newest-first.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'base\n');
        await ctx.fs.writeUtf8(work(ctx, 'g.txt'), 'g1\n');
        await add(ctx, ['f.txt', 'g.txt']);
        const c1 = (await commit(ctx, { message: 'c1 base', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'g.txt'), 'g2\n');
        await add(ctx, ['g.txt']);
        const c2 = (await commit(ctx, { message: 'c2 edit g', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'f3\n');
        await add(ctx, ['f.txt']);
        const c3 = (await commit(ctx, { message: 'c3 edit f', author: MAIN_AUTHOR })).id;
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'f4\n');
        await add(ctx, ['f.txt']);
        await commit(ctx, { message: 'c4 re-edit f', author: MAIN_AUTHOR });
        const stop = await revertRun(ctx, { commits: [`${c1}..${c3}`] });
        if (stop.kind !== 'conflict') throw new Error('seed: expected a conflict');
        // Resolve by accepting the c3 revert (f → base): a real tree change, so
        // the finalised commit is non-empty.
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'base\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await revertContinue(ctx);

        // Assert
        expect(sut.kind).toBe('reverted');
        if (sut.kind !== 'reverted') throw new Error('expected reverted');
        expect(sut.commits.map((c) => c.source)).toEqual([c3, c2]);
        expect(await ctx.fs.readUtf8(work(ctx, 'g.txt'))).toBe('g1\n');
        expect(await exists(ctx, 'sequencer')).toBe(false);
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
      });
    });
  });

  describe('Given a revert conflict resolved to no net change', () => {
    describe('When continue runs', () => {
      it('Then re-stops empty and keeps REVERT_HEAD', async () => {
        // Arrange — resolve the conflict back to the current HEAD content.
        const { ctx, c2 } = await seedConflictStop();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nB3\nc\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await revertContinue(ctx);

        // Assert
        expect(sut.kind).toBe('empty');
        if (sut.kind !== 'empty') throw new Error('expected empty');
        expect(sut.commit).toBe(c2);
        expect(await ctx.fs.readUtf8(`${gitDir(ctx)}/REVERT_HEAD`)).toBe(`${c2}\n`);
      });
    });
  });

  describe('Given a multi-revert stopped at an empty commit', () => {
    describe('When continue runs', () => {
      it('Then drops the empty revert and finishes, clearing the sequencer', async () => {
        // Arrange — `revert c2 c2`: first commits, second stops empty.
        const { ctx, c2 } = await seedLinear();
        const stop = await revertRun(ctx, { commits: [c2, c2] });
        if (stop.kind !== 'empty') throw new Error('seed: expected empty stop');

        // Act
        const sut = await revertContinue(ctx);

        // Assert
        expect(sut.kind).toBe('reverted');
        if (sut.kind !== 'reverted') throw new Error('expected reverted');
        expect(sut.commits).toEqual([]);
        expect(await exists(ctx, 'sequencer')).toBe(false);
        expect(await exists(ctx, 'REVERT_HEAD')).toBe(false);
      });
    });
  });

  describe('Given nothing in progress', () => {
    describe('When continue runs', () => {
      it('Then refuses with NO_OPERATION_IN_PROGRESS', async () => {
        // Arrange
        const { ctx } = await seedLinear();

        // Act
        const code = await codeOf(() => revertContinue(ctx));

        // Assert
        expect(code).toBe('NO_OPERATION_IN_PROGRESS');
      });
    });
  });

  describe('Given an unresolved (still-conflicted) index', () => {
    describe('When continue runs', () => {
      it('Then refuses with MERGE_HAS_CONFLICTS', async () => {
        // Arrange — leave the conflict markers / stage>0 entries in place.
        const { ctx } = await seedConflictStop();

        // Act
        const code = await codeOf(() => revertContinue(ctx));

        // Assert
        expect(code).toBe('MERGE_HAS_CONFLICTS');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When continue runs', () => {
      it('Then refuses with UNSUPPORTED_OPERATION', async () => {
        // Arrange
        const { ctx, c2 } = await seedConflictStop();
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'a\nRESOLVED\nc\n');
        await add(ctx, ['f.txt']);
        const head = await resolveRef(ctx, 'refs/heads/main' as RefName);
        await ctx.fs.writeUtf8(`${gitDir(ctx)}/HEAD`, `${head}\n`);
        void c2;

        // Act
        const code = await codeOf(() => revertContinue(ctx));

        // Assert
        expect(code).toBe('UNSUPPORTED_OPERATION');
      });
    });
  });
});
