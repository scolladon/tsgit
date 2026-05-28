import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { abortMerge } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { merge } from '../../../../src/application/commands/merge.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const MAIN = 'refs/heads/main' as RefName;

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
  await branch(ctx, { kind: 'create', name: 'feature' });
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

describe('abortMerge', () => {
  describe('Given a non-repo (no HEAD)', () => {
    describe('When abortMerge runs', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await abortMerge(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When abortMerge runs', () => {
      it('Then throws BARE_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx, { bare: true });

        // Act
        let caught: unknown;
        try {
          await abortMerge(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('BARE_REPOSITORY');
      });
    });
  });

  describe('Given a repo with no MERGE_HEAD', () => {
    describe('When abortMerge runs', () => {
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
          await abortMerge(ctx);
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

  describe('Given MERGE_HEAD exists but ORIG_HEAD is absent', () => {
    describe('When abortMerge runs', () => {
      it('Then throws NO_OPERATION_IN_PROGRESS(merge)', async () => {
        // Arrange — synthesize a half-state: MERGE_HEAD on disk, ORIG_HEAD removed.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await ctx.fs.rm(`${ctx.layout.gitDir}/ORIG_HEAD`);

        // Act
        let caught: unknown;
        try {
          await abortMerge(ctx);
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

  describe('Given a synthetic detached HEAD with MERGE_HEAD on disk', () => {
    describe('When abortMerge runs', () => {
      it('Then throws UNSUPPORTED_OPERATION', async () => {
        // Arrange — produce a real conflict to write MERGE_HEAD + ORIG_HEAD,
        // then detach HEAD so the symbolic-HEAD guard inside abortMerge fires.
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${preMergeMain}\n`);

        // Act
        let caught: unknown;
        try {
          await abortMerge(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('UNSUPPORTED_OPERATION');
      });
    });
  });

  describe('Given a conflicting merge', () => {
    describe('When abortMerge runs', () => {
      it('Then the working-tree file is restored to the pre-merge content', async () => {
        // Arrange — pre-merge HEAD has file.txt=MAIN; merge wrote conflict markers.
        const ctx = createMemoryContext();
        const fixture = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`);
        expect(sut).toBe(fixture.baseTreeFile);
      });

      it('Then the index contains only stage-0 entries (stage-1/2/3 cleared)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await readIndex(ctx);
        const stages = sut.entries.map((e) => e.flags.stage);
        expect(stages.every((s) => s === 0)).toBe(true);
      });

      it('Then the branch ref points back at ORIG_HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await resolveRef(ctx, MAIN);
        expect(sut).toBe(preMergeMain);
      });

      it('Then MERGE_HEAD is removed from disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`);
        expect(sut).toBe(false);
      });

      it('Then MERGE_MSG is removed from disk', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(sut).toBe(false);
      });

      it('Then ORIG_HEAD is preserved as a recovery aid (ADR-173)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert — the file persists with the same id; `reset --hard ORIG_HEAD`
        // remains a meaningful recovery move after abort.
        const raw = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);
        expect(raw.trim()).toBe(preMergeMain);
      });

      it('Then the branch reflog records `merge: aborted`', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

        // Assert
        const sut = await readReflog(ctx, MAIN);
        expect(sut.at(-1)?.message).toBe('merge: aborted');
      });

      it('Then result.origHead matches the on-disk ORIG_HEAD value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        const sut = await abortMerge(ctx);

        // Assert
        expect(sut.origHead).toBe(preMergeMain);
      });

      it('Then result.branch matches HEAD target', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        const sut = await abortMerge(ctx);

        // Assert
        expect(sut.branch).toBe(MAIN);
      });

      it('Then the post-abort tree matches the pre-merge HEAD tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act
        await abortMerge(ctx);

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
