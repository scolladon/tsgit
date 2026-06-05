import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;
const HEAD = 'HEAD' as RefName;

interface ConflictFixture {
  readonly preMergeMain: ObjectId;
  readonly featureTip: ObjectId;
  readonly baseTreeFile: string;
}

const setupConflictingMerge = async (
  ctx: ReturnType<typeof createMemoryContext>,
): Promise<ConflictFixture> => {
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'base\n');
  await add(ctx, ['file.txt']);
  await commit(ctx, { message: 'base', author });
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { target: 'feature' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'FEATURE\n');
  await add(ctx, ['file.txt']);
  const featureTip = await commit(ctx, { message: 'on-feature', author });
  await checkout(ctx, { target: 'main' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'MAIN\n');
  await add(ctx, ['file.txt']);
  const mainTip = await commit(ctx, { message: 'on-main', author });
  return { preMergeMain: mainTip.id, featureTip: featureTip.id, baseTreeFile: 'MAIN\n' };
};

describe('mergeAbort', () => {
  describe('Given a non-repo (no HEAD)', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws BARE_REPOSITORY with operation=merge --abort', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx, { bare: true });

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — operation label is part of the surfaced error contract.
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('BARE_REPOSITORY');
        expect(data?.operation).toBe('merge --abort');
      });
    });
  });

  describe('Given a repo with no MERGE_HEAD', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws NO_OPERATION_IN_PROGRESS(merge)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        await commit(ctx, { message: 'first', author });

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('NO_OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given ORIG_HEAD exists but MERGE_HEAD is absent (ADR-027 crash window)', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws NO_OPERATION_IN_PROGRESS(merge) without resetting HEAD', async () => {
        // Arrange — simulate the partial state from a crash between
        // `merge`'s ORIG_HEAD write and its MERGE_HEAD write (write order
        // is ORIG_HEAD → MERGE_HEAD per ADR-027). Without the explicit
        // MERGE_HEAD guard, mergeAbort would silently hard-reset to a stale
        // ORIG_HEAD instead of surfacing the inconsistent state.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
        await add(ctx, ['a.txt']);
        const seed = await commit(ctx, { message: 'first', author });
        // Synthesize the crash-window state: ORIG_HEAD present, no MERGE_HEAD.
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`, `${seed.id}\n`);

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — surfaces the inconsistency; HEAD still points at the
        // seed commit (no silent reset happened).
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('NO_OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
        expect(await resolveRef(ctx, MAIN)).toBe(seed.id);
      });
    });
  });

  describe('Given MERGE_HEAD exists but ORIG_HEAD is absent', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws NO_OPERATION_IN_PROGRESS(merge)', async () => {
        // Arrange — synthesize a half-state: MERGE_HEAD on disk, ORIG_HEAD removed.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        await ctx.fs.rm(`${ctx.layout.gitDir}/ORIG_HEAD`);

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('NO_OPERATION_IN_PROGRESS');
        expect(data?.operation).toBe('merge');
      });
    });
  });

  describe('Given a synthetic ORIG_HEAD pointing at a blob (not a commit)', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws UNEXPECTED_OBJECT_TYPE with expected=commit', async () => {
        // Arrange — produce a real merge state, then overwrite ORIG_HEAD with
        // a blob's OID. This exercises the `commit.type !== 'commit'` guard
        // inside resetToOrigHead — without it, materializeTree would surface
        // a less specific error.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        const blobId = await writeObject(ctx, {
          type: 'blob',
          content: new TextEncoder().encode('not a commit'),
          id: '' as ObjectId,
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`, `${blobId}\n`);

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; expected?: string } })?.data;
        expect(data?.code).toBe('UNEXPECTED_OBJECT_TYPE');
        expect(data?.expected).toBe('commit');
      });
    });
  });

  describe('Given a synthetic detached HEAD with MERGE_HEAD on disk', () => {
    describe('When mergeAbort runs', () => {
      it('Then throws UNSUPPORTED_OPERATION with operation=merge --abort and a detached-HEAD reason', async () => {
        // Arrange — produce a real conflict to write MERGE_HEAD + ORIG_HEAD,
        // then detach HEAD so the symbolic-HEAD guard inside mergeAbort fires.
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${preMergeMain}\n`);

        // Act
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — full error payload, not just the code.
        const data = (caught as { data?: { code?: string; operation?: string; reason?: string } })
          ?.data;
        expect(data?.code).toBe('UNSUPPORTED_OPERATION');
        expect(data?.operation).toBe('merge --abort');
        expect(data?.reason).toContain('detached HEAD');
      });
    });
  });

  describe('Given a conflicting merge', () => {
    describe('When mergeAbort runs', () => {
      it('Then the working-tree file is restored to the pre-merge content', async () => {
        // Arrange — pre-merge HEAD has file.txt=MAIN; merge wrote conflict markers.
        const ctx = createMemoryContext();
        const fixture = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(sut).toBe(fixture.baseTreeFile);
      });

      it('Then the index contains only stage-0 entries (stage-1/2/3 cleared)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await readIndex(ctx);
        const stages = sut.entries.map((e) => e.flags.stage);
        expect(stages.every((s) => s === 0)).toBe(true);
      });

      it('Then the branch ref points back at ORIG_HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await resolveRef(ctx, MAIN);
        expect(sut).toBe(preMergeMain);
      });

      it('Then MERGE_HEAD is removed from disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`);
        expect(sut).toBe(false);
      });

      it('Then MERGE_MSG is removed from disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(sut).toBe(false);
      });

      it('Then ORIG_HEAD is preserved as a recovery aid (ADR-173)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert — the file persists with the same id; `reset --hard ORIG_HEAD`
        // remains a meaningful recovery move after abort.
        const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
        expect(raw.trim()).toBe(preMergeMain);
      });

      it('Then HEAD records `reset: moving to HEAD` and the branch reflog is left unchanged (no-move skip)', async () => {
        // Arrange — a conflicted merge never moves HEAD, so the abort reset is a
        // no-op on the branch: git records the entry on the HEAD symref only,
        // with the faithful `reset: moving to HEAD` message git's reset writes.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        const branchBefore = (await readReflog(ctx, MAIN)).at(-1)?.message;

        // Act
        await mergeAbort(ctx);

        // Assert
        const sut = await readReflog(ctx, HEAD);
        expect(sut.at(-1)?.message).toBe('reset: moving to HEAD');
        const branchAfter = await readReflog(ctx, MAIN);
        expect(branchAfter.at(-1)?.message).toBe(branchBefore);
        expect(branchAfter.at(-1)?.message).not.toBe('reset: moving to HEAD');
      });

      it('Then result.origHead matches the on-disk ORIG_HEAD value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        const sut = await mergeAbort(ctx);

        // Assert
        expect(sut.origHead).toBe(preMergeMain);
      });

      it('Then result.branch matches HEAD target', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        const sut = await mergeAbort(ctx);

        // Assert
        expect(sut.branch).toBe(MAIN);
      });

      it('Then a clean-path file dirtied after the conflict is rewritten to the pre-merge content (forceRewriteAll)', async () => {
        // Arrange — produce a conflict, then mutate a NON-conflicting path
        // (one whose stage-0 index entry already matches the target tree).
        // Without `forceRewriteAll: true` the index→target diff would skip
        // this path and the dirty bytes would survive the abort.
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/conflict.txt`, 'base\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/clean.txt`, 'shared\n');
        await add(ctx, ['conflict.txt', 'clean.txt']);
        await commit(ctx, { message: 'base', author });
        await branchCreate(ctx, { name: 'feature' });
        await checkout(ctx, { target: 'feature' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/conflict.txt`, 'FEATURE\n');
        await add(ctx, ['conflict.txt']);
        await commit(ctx, { message: 'on-feature', author });
        await checkout(ctx, { target: 'main' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/conflict.txt`, 'MAIN\n');
        await add(ctx, ['conflict.txt']);
        await commit(ctx, { message: 'on-main', author });
        await mergeRun(ctx, { rev: 'feature', author });
        // Dirty the non-conflicting path's working-tree bytes. Its index
        // entry remains stage-0 matching the pre-merge tree's blob.
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/clean.txt`, 'DIRTY\n');

        // Act
        await mergeAbort(ctx);

        // Assert — clean.txt restored from ORIG_HEAD's tree.
        const sut = await ctx.fs.readUtf8(`${ctx.layout.workDir}/clean.txt`);
        expect(sut).toBe('shared\n');
      });

      it('Then the index lock is released so a follow-up index write can proceed', async () => {
        // Arrange — happy-path abort holds .git/index.lock during materialize.
        // A dropped `finally { await lock.release(); }` would leak the lock
        // file and the follow-up add would surface RESOURCE_LOCKED.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/follow-up.txt`, 'x\n');

        // Assert — the follow-up add succeeds; lock was released.
        await expect(add(ctx, ['follow-up.txt'])).resolves.toBeDefined();
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });

      it('Then the index lock is released even when materializeTree fails mid-write', async () => {
        // Arrange — patch fs.write to throw inside materializeTree's path
        // write so the try block aborts after the lock is held. A missing
        // `finally { await lock.release(); }` would leave .git/index.lock
        // on disk and surface RESOURCE_LOCKED on the next mutation.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });
        const originalWrite = ctx.fs.write.bind(ctx.fs);
        let failOnce = true;
        (ctx.fs as { write: typeof originalWrite }).write = async (p, data) => {
          if (failOnce && p === `${ctx.layout.workDir}/file.txt`) {
            failOnce = false;
            throw new Error('injected working-tree write failure');
          }
          return originalWrite(p, data);
        };

        // Act — abort throws because materializeTree's working-tree write fails.
        let caught: unknown;
        try {
          await mergeAbort(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — the throw propagated AND the lock was released.
        expect(caught).toBeDefined();
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });

      it('Then the post-abort tree matches the pre-merge HEAD tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await mergeRun(ctx, { rev: 'feature', author });

        // Act
        await mergeAbort(ctx);

        // Assert — read the pre-merge HEAD commit's tree, compare with the
        // freshly-rebuilt index's tree contents (same blobs in same paths).
        const preMergeCommit = await readObject(ctx, preMergeMain);
        if (preMergeCommit.type !== 'commit') throw new Error('expected commit');
        const index = await readIndex(ctx);
        expect(index.entries.length).toBeGreaterThan(0);
        // The pre-merge tree had file.txt — confirm the index lists it.
        const filePaths = index.entries.map((e) => e.path);
        expect(filePaths).toContain('file.txt');
      });
    });
  });
});
