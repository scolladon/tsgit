import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
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
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
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
  await checkout(ctx, { rev: 'topic' });
  await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
  await writeAddCommit(ctx, 't2.txt', 't2\n', 't2');
  await checkout(ctx, { rev: 'main' });
  const mainTip = await writeAddCommit(ctx, 'm1.txt', 'm1\n', 'm1');
  await checkout(ctx, { rev: 'topic' });
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
        await checkout(ctx, { rev: 'topic' });
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
        await checkout(ctx, { rev: 'topic' });

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
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
        await checkout(ctx, { rev: 'main' });
        await branchCreate(ctx, { name: 'newbase' });
        await checkout(ctx, { rev: 'newbase' });
        const newbaseTip = await writeAddCommit(ctx, 'n1.txt', 'n1\n', 'n1');
        await checkout(ctx, { rev: 'topic' });

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
        await checkout(ctx, { rev: 'topic' });
        const t1 = await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        const t2 = await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
        const t3 = await writeAddCommit(ctx, 'c.txt', 'c\n', 't3');
        await checkout(ctx, { rev: 'main' });
        const mainTip = await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        await checkout(ctx, { rev: 'topic' });
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

  describe('Given a conflicting pick whose commit also touches a sub-directory', () => {
    describe('When rebased', () => {
      it('Then the rebase-merge/patch file recurses into the sub-directory', async () => {
        // Arrange — base has `f.txt`; topic's only commit edits `f.txt`
        // (conflicting with main) AND adds `sub/g.txt`. Rendering the failed
        // pick's patch must recurse, not throw on the nested add.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'f.txt', 'l1\nBASE\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'l1\nTOPIC\n');
        await ctx.fs.writeUtf8(work(ctx, 'sub/g.txt'), 'nested\n');
        await add(ctx, ['f.txt', 'sub/g.txt']);
        await commit(ctx, { message: 't1', author: FEAT_AUTHOR });
        await checkout(ctx, { rev: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        await checkout(ctx, { rev: 'topic' });

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert — stops on the f.txt conflict; the patch file carries the
        // nested add as a per-file hunk (full path).
        expect(sut.kind).toBe('conflict');
        const patch = await readMerge(ctx, 'patch');
        expect(patch).toContain('diff --git a/sub/g.txt b/sub/g.txt');
        expect(patch).toContain('+nested');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When rebased onto main cleanly', () => {
      it('Then it replays onto main and leaves HEAD detached at the new tip (no finish reflog)', async () => {
        // Arrange — detach at topic's tip, then rebase onto the advanced main.
        const { ctx, mainTip } = await seedDivergent();
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        await checkout(ctx, { rev: topicTip, detach: true });

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
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
        await checkout(ctx, { rev: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        await checkout(ctx, { rev: topicTip, detach: true });
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
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 'f.txt', 'b\n', 'dup');
        const t2 = await writeAddCommit(ctx, 't2.txt', 't2\n', 't2');
        await checkout(ctx, { rev: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'b\n', 'dup on main');
        await writeAddCommit(ctx, 'f.txt', 'c\n', 'm2 diverges');
        await checkout(ctx, { rev: 'topic' });

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

/** main: base, m1 (HEAD on main); an ORPHAN feature: f0 root (built via the
 *  primitives, no parent), f1 on top — sharing no history with main. HEAD on feature. */
const seedUnrelated = async (): Promise<{ ctx: Context; mainTip: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
  const mainTip = await writeAddCommit(ctx, 'm1.txt', 'm1\n', 'm1');
  const blobId = await writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode('f0\n'),
    id: '' as ObjectId,
  });
  const treeId = await writeTree(ctx, [
    { name: 'f0.txt' as never, id: blobId, mode: FILE_MODE.REGULAR },
  ]);
  const featureRoot = await createCommit(ctx, {
    tree: treeId,
    parents: [],
    author: FEAT_AUTHOR,
    committer: FEAT_AUTHOR,
    message: 'feature root\n',
    extraHeaders: [],
  });
  await updateRef(ctx, 'refs/heads/feature' as RefName, featureRoot, {
    reflogMessage: 'branch: Created from seed',
  });
  await checkout(ctx, { rev: 'feature' });
  await writeAddCommit(ctx, 'f1.txt', 'f1\n', 'feature one');
  return { ctx, mainTip };
};

describe('rebaseRun — unrelated histories', () => {
  describe('Given a feature branch with no common ancestor', () => {
    describe('When rebased onto the unrelated upstream', () => {
      it('Then it replays the whole branch onto upstream, the root gaining a parent', async () => {
        // Arrange
        const { ctx, mainTip } = await seedUnrelated();

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await resolveRef(ctx, 'refs/heads/feature' as RefName));
        expect(tip.message).toBe('feature one\n');
        const replayedRoot = await readCommit(ctx, tip.parents[0] as ObjectId);
        expect(replayedRoot.message).toBe('feature root\n');
        // The empty-base replay reparents the orphan root onto the upstream tip.
        expect(replayedRoot.parents).toEqual([mainTip]);
        // The whole branch replayed: the tip tree carries files from both histories.
        expect(await ctx.fs.exists(work(ctx, 'base.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'm1.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'f0.txt'))).toBe(true);
        expect(await ctx.fs.exists(work(ctx, 'f1.txt'))).toBe(true);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/feature');
        expect(head[1]).toBe('rebase (pick): feature one');
        expect(head[2]).toBe('rebase (pick): feature root');
        expect(head[3]).toBe('rebase (start): checkout main');
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
  await checkout(ctx, { rev: 'topic' });
  await writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
  await writeAddCommit(ctx, 'f.txt', 'l1\nTOPIC\n', 't2');
  await checkout(ctx, { rev: 'main' });
  await writeAddCommit(ctx, 'f.txt', 'l1\nMAIN\n', 'm1');
  await checkout(ctx, { rev: 'topic' });
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
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 'x.txt', 'v\n', 'add x');
        // A real follow-up commit: the empty `add x` must release its index lock
        // before this one acquires it, else the replay deadlocks.
        await writeAddCommit(ctx, 'z.txt', 'z\n', 'add z');
        await checkout(ctx, { rev: 'main' });
        await ctx.fs.writeUtf8(work(ctx, 'x.txt'), 'v\n');
        await ctx.fs.writeUtf8(work(ctx, 'y.txt'), 'w\n');
        await add(ctx, ['x.txt', 'y.txt']);
        await commit(ctx, { message: 'add x and y', author: FEAT_AUTHOR });
        await checkout(ctx, { rev: 'topic' });

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
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
        await checkout(ctx, { rev: 'main' });
        await writeAddCommit(ctx, 'b.txt', 'b\n', 'B');
        await branchCreate(ctx, { name: 'newbase', startPoint: root });
        await checkout(ctx, { rev: 'newbase' });
        await writeAddCommit(ctx, 'n1.txt', 'n1\n', 'n1');
        await checkout(ctx, { rev: 'topic' });

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
          await checkout(ctx, { rev: 'topic' });
          return writeAddCommit(ctx, 'a.txt', 'a\n', 't1');
        })();
        await writeAddCommit(ctx, 'f.txt', 'l1\nT2\nl3\n', 't2');
        await writeAddCommit(ctx, 'f.txt', 'l1\nT2\nT3\n', 't3');
        await checkout(ctx, { rev: 'main' });
        await writeAddCommit(ctx, 'f.txt', 'l1\nM2\nM3\n', 'm1');
        await checkout(ctx, { rev: 'topic' });
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

const dataReason = async (
  run: () => Promise<unknown>,
): Promise<{ code: string; reason?: string; option?: string }> => {
  try {
    await run();
    throw new Error('expected an error');
  } catch (err) {
    return (err as TsgitError).data as { code: string; reason?: string; option?: string };
  }
};

/** Linear main: base; c1, c2, c3 each adding an independent file. HEAD on main. */
const seedLinear = async (): Promise<{
  ctx: Context;
  base: ObjectId;
  c1: ObjectId;
  c2: ObjectId;
  c3: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  const base = await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
  const c1 = await writeAddCommit(ctx, '1.txt', '1\n', 'c1 subject');
  const c2 = await writeAddCommit(ctx, '2.txt', '2\n', 'c2 subject');
  const c3 = await writeAddCommit(ctx, '3.txt', '3\n', 'c3 subject');
  return { ctx, base, c1, c2, c3 };
};

/** base f=L; c1 sets f=A; c2 sets f=B — reordering the two conflicts. */
const seedSameFile = async (): Promise<{
  ctx: Context;
  base: ObjectId;
  c1: ObjectId;
  c2: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  const base = await writeAddCommit(ctx, 'f.txt', 'L\n', 'base');
  const c1 = await writeAddCommit(ctx, 'f.txt', 'A\n', 'c1 subject');
  const c2 = await writeAddCommit(ctx, 'f.txt', 'B\n', 'c2 subject');
  return { ctx, base, c1, c2 };
};

const mainTipOid = (ctx: Context): Promise<ObjectId> =>
  resolveRef(ctx, 'refs/heads/main' as RefName);

describe('rebaseRun (interactive)', () => {
  describe('Given an all-pick todo onto the fork', () => {
    describe('When run interactively with no edits', () => {
      it('Then it is a complete no-op — history oids unchanged, branch reflog untouched', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();
        const branchBefore = await reflogMessages(ctx, 'refs/heads/main');

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'pick', oid: c2 },
            { action: 'pick', oid: c3 },
          ],
        });

        // Assert
        expect(sut).toEqual({
          kind: 'rebased',
          commits: [
            { source: c1, created: c1 },
            { source: c2, created: c2 },
            { source: c3, created: c3 },
          ],
        });
        expect(await mainTipOid(ctx)).toBe(c3);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/main');
        expect(head[1]).toBe(`rebase (start): checkout ${base}`);
        // The branch never moved, so the no-op ref update writes no reflog entry.
        expect(await reflogMessages(ctx, 'refs/heads/main')).toEqual(branchBefore);
      });
    });
  });

  describe('Given a drop instruction', () => {
    describe('When the tip commit is dropped', () => {
      it('Then the branch ends at the folded predecessor with a finish reflog', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'pick', oid: c2 },
            { action: 'drop', oid: c3 },
          ],
        });

        // Assert
        expect(sut).toEqual({
          kind: 'rebased',
          commits: [
            { source: c1, created: c1 },
            { source: c2, created: c2 },
          ],
        });
        expect(await mainTipOid(ctx)).toBe(c2);
        const branch = await reflogMessages(ctx, 'refs/heads/main');
        expect(branch[0]).toBe(`rebase (finish): refs/heads/main onto ${base}`);
      });
    });

    describe('When a middle commit is dropped', () => {
      it('Then the survivor after it is cherry-picked onto the kept predecessor', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'drop', oid: c2 },
            { action: 'pick', oid: c3 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await mainTipOid(ctx);
        const tipData = await readCommit(ctx, tip);
        expect(tipData.parents).toEqual([c1]); // reparented off c1, skipping c2
        expect(tipData.message).toBe('c3 subject\n');
        expect(tip).not.toBe(c3); // new oid (new committer + parent)
        expect((await reflogMessages(ctx, 'HEAD'))[1]).toBe('rebase (pick): c3 subject');
      });
    });
  });

  describe('Given a reorder of independent commits', () => {
    describe('When the two picks are swapped', () => {
      it('Then both replay cleanly with the new order on a fresh chain', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c2 },
            { action: 'pick', oid: c1 },
          ],
        });

        // Assert — tip is c1 replayed atop a replayed c2
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n');
        const parent = await readCommit(ctx, tip.parents[0] as ObjectId);
        expect(parent.message).toBe('c2 subject\n');
      });
    });
  });

  describe('Given a reorder that conflicts', () => {
    describe('When the conflicting pick is applied first', () => {
      it('Then it stops with a conflict and persists the rebase-merge state', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedSameFile();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c2 },
            { action: 'pick', oid: c1 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('conflict');
        if (sut.kind === 'conflict') {
          expect(sut.commit).toBe(c2);
          expect(sut.remaining).toBe(1);
        }
        expect(await readMerge(ctx, 'done')).toBe(`pick ${c2} # c2 subject\n`);
        expect(await readMerge(ctx, 'git-rebase-todo')).toBe(`pick ${c1} # c1 subject\n`);
      });
    });
  });

  describe('Given an invalid interactive todo', () => {
    describe('When every instruction is a drop', () => {
      it('Then it refuses with INVALID_OPTION (nothing to do)', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, {
            upstream: base,
            interactive: [
              { action: 'drop', oid: c1 },
              { action: 'drop', oid: c2 },
              { action: 'drop', oid: c3 },
            ],
          }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain('nothing to do');
      });
    });

    describe('When an instruction names a commit outside the range', () => {
      it('Then it refuses with INVALID_OPTION (not in the list)', async () => {
        // Arrange
        const { ctx, base } = await seedLinear();

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, { upstream: base, interactive: [{ action: 'pick', oid: base }] }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain('is not in the list');
      });
    });
  });
});

describe('rebaseRun (interactive reword)', () => {
  describe('Given a reword whose base fast-forwards', () => {
    describe('When the tip is reworded after a folded prefix', () => {
      it('Then it fast-forwards then amends the message (two reflog entries)', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'pick', oid: c2 },
            { action: 'reword', oid: c3, message: 'c3 reworded' },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c3 reworded\n');
        expect(tip.parents).toEqual([c2]); // base preserved by the fast-forward
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/main');
        expect(head[1]).toBe('rebase (reword): c3 reworded');
        expect(head[2]).toBe('rebase: fast-forward');
      });
    });
  });

  describe('Given a reword whose base does not fast-forward', () => {
    describe('When a commit is dropped before the reworded commit', () => {
      it('Then it cherry-picks (reword:orig) then amends (reword:new)', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'drop', oid: c1 },
            { action: 'pick', oid: c2 },
            { action: 'reword', oid: c3, message: 'c3 reworded' },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c3 reworded\n');
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[1]).toBe('rebase (reword): c3 reworded'); // the amend
        expect(head[2]).toBe('rebase (reword): c3 subject'); // the cherry-pick (original subject)
      });
    });
  });

  describe('Given a reword without a message', () => {
    describe('When the instruction omits the message', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const { ctx, base, c1 } = await seedLinear();

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, { upstream: base, interactive: [{ action: 'reword', oid: c1 }] }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain('reword requires a message');
      });
    });
  });
});

describe('rebaseRun (interactive) — empty reword/squash message', () => {
  describe('Given a reword whose message cleans to empty', () => {
    describe('When run', () => {
      it('Then it refuses with INVALID_OPTION before any state change', async () => {
        // Arrange
        const { ctx, base, c1 } = await seedLinear();
        const before = await mainTipOid(ctx);

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, {
            upstream: base,
            interactive: [{ action: 'reword', oid: c1, message: '   \n  \n' }],
          }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain('reword message must not be empty');
        expect(await mainTipOid(ctx)).toBe(before); // HEAD never moved
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge`)).toBe(false);
      });
    });
  });

  describe('Given a squash whose inline message cleans to empty', () => {
    describe('When run after a leading pick', () => {
      it('Then it refuses with INVALID_OPTION before any state change', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();
        const before = await mainTipOid(ctx);

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, {
            upstream: base,
            interactive: [
              { action: 'pick', oid: c1 },
              { action: 'squash', oid: c2, message: '\n\n' },
            ],
          }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain('squash message must not be empty');
        expect(await mainTipOid(ctx)).toBe(before);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge`)).toBe(false);
      });
    });
  });

  describe('Given a fixup carrying an empty message', () => {
    describe('When run after a leading pick', () => {
      it('Then the empty message is ignored (fixup discards it) and the rebase succeeds', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act — fixup never consumes its message, so an empty one is not a refusal
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'fixup', oid: c2, message: '\n\n' },
          ],
        });

        // Assert — c2 folds into c1, keeping c1's message; no INVALID_OPTION
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n');
      });
    });
  });
});

/** topic off base: t1 (a.txt clean), t2 (f.txt=TOPIC), t3 (c.txt clean); main
 *  advances with m1 (f.txt=MAIN) — replaying t2 onto main conflicts. */
const seedTopicConflict = async (): Promise<{
  ctx: Context;
  t1: ObjectId;
  t2: ObjectId;
  t3: ObjectId;
}> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await setUser(ctx);
  await writeAddCommit(ctx, 'f.txt', 'L\n', 'base');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { rev: 'topic' });
  const t1 = await writeAddCommit(ctx, 'a.txt', 'a\n', 't1 subject');
  const t2 = await writeAddCommit(ctx, 'f.txt', 'TOPIC\n', 't2 subject');
  const t3 = await writeAddCommit(ctx, 'c.txt', 'c\n', 't3 subject');
  await checkout(ctx, { rev: 'main' });
  await writeAddCommit(ctx, 'f.txt', 'MAIN\n', 'm1');
  await checkout(ctx, { rev: 'topic' });
  return { ctx, t1, t2, t3 };
};

describe('rebaseRun (interactive edit / continue / skip)', () => {
  describe('Given an edit instruction that fast-forwards', () => {
    describe('When run interactively', () => {
      it('Then it stops for amending with the amend marker at the edit commit', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 },
            { action: 'pick', oid: c2 },
          ],
        });

        // Assert
        expect(sut).toEqual({ kind: 'stopped', commit: c1, remaining: 1 });
        expect(await readMerge(ctx, 'amend')).toBe(`${c1}\n`);
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(c1); // HEAD detached at the edit commit
      });
    });
  });

  describe('Given an edit that does not fast-forward', () => {
    describe('When a commit is dropped before it', () => {
      it('Then the produced (cherry-picked) commit is the amend target', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'drop', oid: c1 },
            { action: 'edit', oid: c2 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('stopped');
        const amend = (await readMerge(ctx, 'amend')).trim() as ObjectId;
        expect(amend).not.toBe(c2); // reparented onto base, fresh oid
        expect((await readCommit(ctx, amend)).parents).toEqual([base]);
        // The non-fast-forward edit produces its commit via a labelled cherry-pick.
        expect((await reflogMessages(ctx, 'HEAD'))[0]).toBe('rebase (edit): c2 subject');
      });
    });
  });

  describe('Given an edit stop continued with no tree change', () => {
    describe('When continue is called without staging anything', () => {
      it('Then no new commit is made and the trailing pick fast-forwards', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();
        await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 },
            { action: 'pick', oid: c2 },
          ],
        });

        // Act
        const sut = await rebaseContinue(ctx);

        // Assert — both commits keep their original oids (a pure no-op edit)
        expect(sut.kind).toBe('rebased');
        expect(await mainTipOid(ctx)).toBe(c2);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).toContain('rebase: fast-forward'); // c2 fast-forwarded after the edit
      });
    });
  });

  describe('Given an edit stop continued after staging a change', () => {
    describe('When the working tree is amended then continued', () => {
      it('Then a new commit replaces the edit commit (rebase (continue) reflog)', async () => {
        // Arrange
        const { ctx, base, c1 } = await seedLinear();
        await rebaseRun(ctx, { upstream: base, interactive: [{ action: 'edit', oid: c1 }] });
        await ctx.fs.writeUtf8(work(ctx, 'extra.txt'), 'extra\n');
        await add(ctx, ['extra.txt']);

        // Act
        const sut = await rebaseContinue(ctx);

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await mainTipOid(ctx);
        expect(tip).not.toBe(c1); // amended → new oid
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head).toContain('rebase (continue): c1 subject');
      });
    });
  });

  describe('Given an edit stop that is skipped', () => {
    describe('When skip is called', () => {
      it('Then the edit commit is dropped and the rest replays onto its parent', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();
        await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 },
            { action: 'pick', oid: c2 },
          ],
        });

        // Act
        const sut = await rebaseSkip(ctx);

        // Assert — c1 dropped; c2 reparented onto base
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c2 subject\n');
        expect(tip.parents).toEqual([base]);
      });
    });
  });

  describe('Given an interactive rebase with a non-pick verb that conflicts', () => {
    describe('When the conflict is resolved and continued', () => {
      it('Then it commits the resolution and replays the remaining drop', async () => {
        // Arrange
        const { ctx, t1, t2, t3 } = await seedTopicConflict();
        const stop = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: t1 },
            { action: 'pick', oid: t2 },
            { action: 'drop', oid: t3 },
          ],
        });
        expect(stop.kind).toBe('conflict');

        // Resolve the conflict
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'RESOLVED\n');
        await add(ctx, ['f.txt']);

        // Act
        const sut = await rebaseContinue(ctx);

        // Assert — t1 + resolved-t2 on main; t3 dropped
        expect(sut.kind).toBe('rebased');
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/topic');
        expect(head[1]).toBe('rebase (continue): t2 subject');
      });
    });

    describe('When the conflict is skipped', () => {
      it('Then the conflicting commit is discarded and the rest replays', async () => {
        // Arrange
        const { ctx, t1, t2, t3 } = await seedTopicConflict();
        const stop = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: t1 },
            { action: 'pick', oid: t2 },
            { action: 'drop', oid: t3 },
          ],
        });
        expect(stop.kind).toBe('conflict');

        // Act
        const sut = await rebaseSkip(ctx);

        // Assert — t2 skipped, t3 dropped, only t1 replayed atop main
        expect(sut.kind).toBe('rebased');
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        expect((await readCommit(ctx, topicTip)).message).toBe('t1 subject\n'); // t2/t3 gone
      });
    });
  });

  describe('Given a reword scheduled after a stop', () => {
    describe('When the inline message cannot survive the stop', () => {
      it('Then the reword keeps the original message (documented limitation)', async () => {
        // Arrange — edit c1 stops; the reword of c2 is in the remaining todo
        const { ctx, base, c1, c2 } = await seedLinear();
        await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'edit', oid: c1 },
            { action: 'reword', oid: c2, message: 'lost across the stop' },
          ],
        });

        // Act — continue with no change; the reword replays without its message
        const sut = await rebaseContinue(ctx);

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c2 subject\n'); // original kept, not "lost across the stop"
      });
    });
  });
});

describe('rebaseRun (interactive squash / fixup)', () => {
  describe('Given a single squash', () => {
    describe('When the next commit is squashed into the previous', () => {
      it('Then one combined commit carries both messages on the base parent', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'squash', oid: c2 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n\nc2 subject\n');
        expect(tip.parents).toEqual([base]); // the group commit replaces c1, on base
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[1]).toBe('rebase (squash): c1 subject');
      });
    });
  });

  describe('Given a single fixup', () => {
    describe('When the next commit is fixed up into the previous', () => {
      it('Then the combined commit keeps only the base message', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'fixup', oid: c2 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n'); // c2's message dropped
        expect(tip.parents).toEqual([base]);
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[1]).toBe('rebase (fixup): c1 subject');
      });
    });
  });

  describe('Given a squash chain', () => {
    describe('When two commits squash into the first', () => {
      it('Then all three messages combine into one commit on base', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'squash', oid: c2 },
            { action: 'squash', oid: c3 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n\nc2 subject\n\nc3 subject\n');
        expect(tip.parents).toEqual([base]);
        // The intermediate group commit (c2) carries the raw, uncleaned
        // template — only the final member's commit is cleaned.
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[2]).toBe('rebase (squash): # This is a combination of 2 commits.');
      });
    });
  });

  describe('Given a fixup chain', () => {
    describe('When two commits fix up into the first', () => {
      it('Then it produces the intermediate template reflog then the cleaned final', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'fixup', oid: c2 },
            { action: 'fixup', oid: c3 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n'); // both fixups dropped
        const head = await reflogMessages(ctx, 'HEAD');
        expect(head[0]).toBe('rebase (finish): returning to refs/heads/main');
        expect(head[1]).toBe('rebase (fixup): c1 subject'); // final, cleaned
        expect(head[2]).toBe('rebase (fixup): # This is a combination of 2 commits.'); // intermediate
      });
    });
  });

  describe('Given a squash then a fixup', () => {
    describe('When the group mixes a kept and a skipped message', () => {
      it('Then the final message keeps the squash but drops the fixup', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'squash', oid: c2 },
            { action: 'fixup', oid: c3 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n\nc2 subject\n'); // c3 (fixup) dropped
      });
    });
  });

  describe('Given a squash with an explicit combined message', () => {
    describe('When the squash carries an inline message', () => {
      it('Then the combined commit uses it verbatim', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'squash', oid: c2, message: 'merged c1 and c2' },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('merged c1 and c2\n');
      });
    });
  });

  describe('Given a leading squash', () => {
    describe('When the first non-drop instruction is a squash', () => {
      it('Then it refuses with INVALID_OPTION (no previous commit)', async () => {
        // Arrange
        const { ctx, base, c1 } = await seedLinear();

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, { upstream: base, interactive: [{ action: 'squash', oid: c1 }] }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain("cannot 'squash' without a previous commit");
      });
    });
  });

  describe('Given a squash whose meld conflicts', () => {
    describe('When resolved and continued', () => {
      it('Then it commits the combined group and persists the group state at the stop', async () => {
        // Arrange — t1 clean onto main; squash t2 melds a conflicting f.txt
        const { ctx, t1, t2, t3 } = await seedTopicConflict();
        const mainTip = await resolveRef(ctx, 'refs/heads/main' as RefName);
        const stop = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: t1 },
            { action: 'squash', oid: t2 },
            { action: 'drop', oid: t3 },
          ],
        });

        // Assert — stopped on the squash meld with the full group state on disk
        expect(stop.kind).toBe('conflict');
        if (stop.kind === 'conflict') {
          expect(stop.commit).toBe(t2);
          expect(stop.remaining).toBe(1); // the trailing `drop t3`
        }
        expect(await readMerge(ctx, 'current-fixups')).toBe(`squash ${t2}\n`);
        // The picked t1 (group base) is pending its rewrite to the final group oid.
        expect((await readMerge(ctx, 'rewritten-pending')).trim()).toMatch(/^[0-9a-f]{40}$/);
        expect(await readMerge(ctx, 'message-squash')).toContain(
          '# This is a combination of 2 commits.',
        );
        // The backup todo is written once, on the fresh-run stop.
        const backup = `${ctx.layout.gitDir}/rebase-merge/git-rebase-todo.backup`;
        expect(await ctx.fs.exists(backup)).toBe(true);

        // Resolve, continue
        await ctx.fs.writeUtf8(work(ctx, 'f.txt'), 'RESOLVED\n');
        await add(ctx, ['f.txt']);
        const done = await rebaseContinue(ctx);

        // Assert — one combined commit (t1 + t2) replacing the base, on main's tip
        expect(done.kind).toBe('rebased');
        const topicTip = await resolveRef(ctx, 'refs/heads/topic' as RefName);
        const combined = await readCommit(ctx, topicTip);
        expect(combined.message).toBe('t1 subject\n\nt2 subject\n');
        expect(combined.parents).toEqual([mainTip]); // group commit replaced t1', not stacked
        expect((await reflogMessages(ctx, 'HEAD'))[1]).toBe('rebase (continue): t1 subject');
      });
    });
  });

  describe('Given a drop before a squash', () => {
    describe('When the squash becomes the first applied instruction', () => {
      it('Then it refuses with INVALID_OPTION (no previous commit)', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act — dropping c1 leaves the squash with nothing to fold into
        const sut = await dataReason(() =>
          rebaseRun(ctx, {
            upstream: base,
            interactive: [
              { action: 'drop', oid: c1 },
              { action: 'squash', oid: c2 },
            ],
          }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain("cannot 'squash' without a previous commit");
      });
    });
  });

  describe('Given a leading fixup', () => {
    describe('When the first non-drop instruction is a fixup', () => {
      it('Then it refuses with INVALID_OPTION (no previous commit)', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await dataReason(() =>
          rebaseRun(ctx, {
            upstream: base,
            interactive: [
              { action: 'fixup', oid: c1 },
              { action: 'pick', oid: c2 },
            ],
          }),
        );

        // Assert
        expect(sut.code).toBe('INVALID_OPTION');
        expect(sut.option).toBe('interactive');
        expect(sut.reason).toContain("cannot 'fixup' without a previous commit");
      });
    });
  });

  describe('Given a fixup whose meld conflicts', () => {
    describe('When the stop state is persisted', () => {
      it('Then message-squash marks the fixup body as skipped', async () => {
        // Arrange — t1 clean onto main; fixup t2 melds a conflicting f.txt
        const { ctx, t1, t2, t3 } = await seedTopicConflict();

        // Act
        const stop = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: t1 },
            { action: 'fixup', oid: t2 },
            { action: 'drop', oid: t3 },
          ],
        });

        // Assert — the fixup member is commented out under the skip header
        expect(stop.kind).toBe('conflict');
        expect(await readMerge(ctx, 'current-fixups')).toBe(`fixup ${t2}\n`);
        expect(await readMerge(ctx, 'message-squash')).toContain(
          '# The commit message #2 will be skipped:',
        );
      });
    });
  });

  describe('Given a squash that melds into a folded base', () => {
    describe('When the meld conflicts before any in-loop pick runs', () => {
      it('Then rewritten-pending carries the folded base oid', async () => {
        // Arrange — main: g0→gO; topic off gO adds a (f=A, folds onto gO),
        // m (f=M), z (f=Z). Squashing z melds it onto the folded a and
        // conflicts on f.txt (base m vs ours a vs theirs z), so the group's
        // only pending oid is the folded base itself.
        const ctx = createMemoryContext();
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'g.txt', '0\n', 'g0');
        await writeAddCommit(ctx, 'g.txt', 'O\n', 'gO');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        const a = await writeAddCommit(ctx, 'f.txt', 'A\n', 'A subject');
        const m = await writeAddCommit(ctx, 'f.txt', 'M\n', 'M subject');
        const z = await writeAddCommit(ctx, 'f.txt', 'Z\n', 'Z subject');

        // Act
        const stop = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: a },
            { action: 'drop', oid: m },
            { action: 'squash', oid: z },
          ],
        });

        // Assert — the folded a (verbatim oid) is the lone pending rewrite
        expect(stop.kind).toBe('conflict');
        if (stop.kind === 'conflict') expect(stop.commit).toBe(z);
        expect(await readMerge(ctx, 'current-fixups')).toBe(`squash ${z}\n`);
        expect((await readMerge(ctx, 'rewritten-pending')).trim()).toBe(a);
      });
    });
  });

  describe('Given a fixup group ended by a trailing pick', () => {
    describe('When a pick follows the melded fixup', () => {
      it('Then the group commit takes the cleaned message, not the raw template', async () => {
        // Arrange
        const { ctx, base, c1, c2, c3 } = await seedLinear();

        // Act — c1 folds, c2 fixes up into it (the group ends here, before c3)
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'fixup', oid: c2 },
            { action: 'pick', oid: c3 },
          ],
        });

        // Assert — c3's parent is the cleaned group commit (c2's body dropped)
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c3 subject\n');
        const group = await readCommit(ctx, tip.parents[0] as ObjectId);
        expect(group.message).toBe('c1 subject\n');
      });
    });
  });

  describe('Given a fixup carrying an inline message', () => {
    describe('When the fixup melds into the base', () => {
      it('Then the inline message is ignored (only the base message survives)', async () => {
        // Arrange
        const { ctx, base, c1, c2 } = await seedLinear();

        // Act
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'pick', oid: c1 },
            { action: 'fixup', oid: c2, message: 'ignored by fixup' },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const tip = await readCommit(ctx, await mainTipOid(ctx));
        expect(tip.message).toBe('c1 subject\n');
      });
    });
  });
});

describe('rebaseRun (interactive, detached HEAD)', () => {
  describe('Given a detached HEAD whose interactive replay conflicts', () => {
    describe('When the conflicting pick stops', () => {
      it('Then head-name records "detached HEAD"', async () => {
        // Arrange — detach at the topic tip, then replay its commits onto main
        const { ctx, t1, t2 } = await seedTopicConflict();
        await checkout(ctx, { rev: t2 });

        // Act — t2 conflicts with main's f.txt
        const sut = await rebaseRun(ctx, {
          upstream: 'main',
          interactive: [
            { action: 'pick', oid: t1 },
            { action: 'pick', oid: t2 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('conflict');
        expect((await readMerge(ctx, 'head-name')).trimEnd()).toBe('detached HEAD');
      });
    });
  });
});

describe('rebase — hooks', () => {
  /** seedDivergent, but on a hook-wired Context. */
  const seedDivergentHooked = async (runner: MemoryHookRunner): Promise<Context> => {
    const ctx = createMemoryContext({ hooks: runner });
    await init(ctx);
    await setUser(ctx);
    await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
    await branchCreate(ctx, { name: 'topic' });
    await checkout(ctx, { rev: 'topic' });
    await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');
    await writeAddCommit(ctx, 't2.txt', 't2\n', 't2');
    await checkout(ctx, { rev: 'main' });
    await writeAddCommit(ctx, 'm1.txt', 'm1\n', 'm1');
    await checkout(ctx, { rev: 'topic' });
    return ctx;
  };

  /** The post-rewrite stdin tsgit must send: one `<source> <created>` line per replayed commit. */
  const expectedRewriteStdin = (sut: Awaited<ReturnType<typeof rebaseRun>>): string => {
    if (sut.kind !== 'rebased') throw new Error('expected rebased');
    return sut.commits.map((c) => `${c.source} ${c.created}\n`).join('');
  };

  describe('Given a pre-rebase hook that exits non-zero', () => {
    describe('When rebaseRun', () => {
      it('Then it throws HOOK_FAILED and no ref moved', async () => {
        // Arrange
        const runner = new MemoryHookRunner({
          'pre-rebase': { kind: 'ran', exitCode: 1, stdout: '', stderr: 'blocked' },
        });
        const ctx = await seedDivergentHooked(runner);
        const topicBefore = await resolveRef(ctx, 'refs/heads/topic' as RefName);

        // Act
        let caught: unknown;
        try {
          await rebaseRun(ctx, { upstream: 'main' });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'pre-rebase',
          exitCode: 1,
          stderr: 'blocked',
        });
        expect(await resolveRef(ctx, 'refs/heads/topic' as RefName)).toBe(topicBefore);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(false);
      });
    });
  });

  describe('Given a pre-rebase hook that passes', () => {
    describe('When rebaseRun', () => {
      it('Then the rebase proceeds and pre-rebase fired with the upstream argument', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = await seedDivergentHooked(runner);

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('rebased');
        const preRebase = runner.calls.filter((c) => c.name === 'pre-rebase');
        expect(preRebase).toHaveLength(1);
        expect(preRebase[0]?.args).toEqual(['main']);
      });
    });
  });

  describe('Given a finished plain rebase', () => {
    describe('When rebaseRun completes', () => {
      it('Then post-rewrite fires with the rebase label and the rewritten-pair stdin', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = await seedDivergentHooked(runner);

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        const postRewrite = runner.calls.filter((c) => c.name === 'post-rewrite');
        expect(postRewrite).toHaveLength(1);
        expect(postRewrite[0]?.args).toEqual(['rebase']);
        expect(postRewrite[0]?.stdin).toBe(expectedRewriteStdin(sut));
      });
    });
  });

  describe('Given a finished interactive rebase that rewrites a commit', () => {
    describe('When rebaseRun completes interactively', () => {
      it('Then post-rewrite fires with the rebase label and the rewritten-pair stdin', async () => {
        // Arrange
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await init(ctx);
        await setUser(ctx);
        const base = await writeAddCommit(ctx, 'f.txt', 'L\n', 'base');
        const c1 = await writeAddCommit(ctx, 'f.txt', 'A\n', 'c1 subject');
        const c2 = await writeAddCommit(ctx, 'f.txt', 'B\n', 'c2 subject');

        // Act — reword c1 (genuine rewrite), pick c2 atop it.
        const sut = await rebaseRun(ctx, {
          upstream: base,
          interactive: [
            { action: 'reword', oid: c1, message: 'reworded c1' },
            { action: 'pick', oid: c2 },
          ],
        });

        // Assert
        expect(sut.kind).toBe('rebased');
        const postRewrite = runner.calls.filter((call) => call.name === 'post-rewrite');
        expect(postRewrite).toHaveLength(1);
        expect(postRewrite[0]?.args).toEqual(['rebase']);
        expect(postRewrite[0]?.stdin).toBe(expectedRewriteStdin(sut));
        // The first rewritten pair maps the reworded source to a new oid.
        expect(postRewrite[0]?.stdin.startsWith(`${c1} `)).toBe(true);
      });
    });
  });

  describe('Given an up-to-date rebase (no rewrites)', () => {
    describe('When rebaseRun', () => {
      it('Then post-rewrite does not fire', async () => {
        // Arrange — main = base; topic = base + t1, so onto === merge-base.
        const runner = new MemoryHookRunner();
        const ctx = createMemoryContext({ hooks: runner });
        await init(ctx);
        await setUser(ctx);
        await writeAddCommit(ctx, 'base.txt', 'base\n', 'base');
        await branchCreate(ctx, { name: 'topic' });
        await checkout(ctx, { rev: 'topic' });
        await writeAddCommit(ctx, 't1.txt', 't1\n', 't1');

        // Act
        const sut = await rebaseRun(ctx, { upstream: 'main' });

        // Assert
        expect(sut.kind).toBe('up-to-date');
        expect(runner.calls.some((call) => call.name === 'post-rewrite')).toBe(false);
      });
    });
  });
});
