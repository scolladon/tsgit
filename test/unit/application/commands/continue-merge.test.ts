import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { continueMerge } from '../../../../src/application/commands/continue-merge.js';
import { init } from '../../../../src/application/commands/init.js';
import { merge } from '../../../../src/application/commands/merge.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { HookResult, HookRunner } from '../../../../src/ports/hook-runner.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface ConflictFixture {
  readonly preMergeMain: ObjectId;
  readonly featureTip: ObjectId;
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
  return { preMergeMain: mainTip.id, featureTip: featureTip.id };
};

const resolveAndStage = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content = 'RESOLVED\n',
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, content);
  await add(ctx, ['file.txt']);
};

describe('continueMerge', () => {
  describe('Given a non-repo (no HEAD)', () => {
    describe('When continueMerge runs', () => {
      it('Then throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: unknown;
        try {
          await continueMerge(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When continueMerge runs', () => {
      it('Then throws BARE_REPOSITORY with operation=merge --continue', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx, { bare: true });

        // Act
        let caught: unknown;
        try {
          await continueMerge(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as { data?: { code?: string; operation?: string } })?.data;
        expect(data?.code).toBe('BARE_REPOSITORY');
        expect(data?.operation).toBe('merge --continue');
      });
    });
  });

  describe('Given a repo with no MERGE_HEAD', () => {
    describe('When continueMerge runs', () => {
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
          await continueMerge(ctx);
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

  describe('Given MERGE_HEAD and unresolved index entries', () => {
    describe('When continueMerge runs', () => {
      it('Then throws MERGE_HAS_CONFLICTS (delegated to commit)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });

        // Act — explicit author/committer so the call reaches the
        // unmerged-index check (rejectUnmergedIndex) before
        // AUTHOR_UNCONFIGURED can fire.
        let caught: unknown;
        try {
          await continueMerge(ctx, { message: 'resolved', author, committer: author });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as { data?: { code?: string } })?.data?.code).toBe('MERGE_HAS_CONFLICTS');
      });
    });
  });

  describe('Given a resolved merge with no message override', () => {
    describe('When continueMerge runs', () => {
      it('Then the resulting commit reuses the MERGE_MSG draft', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author, message: 'Merge feature into main' });
        await resolveAndStage(ctx);

        // Act
        const sut = await continueMerge(ctx, { author, committer: author });

        // Assert
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('commit');
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe('Merge feature into main\n');
        }
      });
    });
  });

  describe('Given a resolved merge with an explicit message', () => {
    describe('When continueMerge runs', () => {
      it('Then the resulting commit carries the explicit message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await resolveAndStage(ctx);

        // Act
        const sut = await continueMerge(ctx, {
          message: 'resolved by user',
          author,
          committer: author,
        });

        // Assert
        const obj = await readObject(ctx, sut.id);
        if (obj.type === 'commit') {
          expect(obj.data.message).toBe('resolved by user\n');
        } else {
          throw new Error('expected commit');
        }
      });
    });
  });

  describe('Given a resolved merge', () => {
    describe('When continueMerge runs', () => {
      it('Then the resulting commit has parents=[origHead, mergeHead]', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { preMergeMain, featureTip } = await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await resolveAndStage(ctx);

        // Act
        const sut = await continueMerge(ctx, { message: 'resolved', author, committer: author });

        // Assert
        expect(sut.parents).toEqual([preMergeMain, featureTip]);
      });

      it('Then MERGE_HEAD and MERGE_MSG are cleared after the commit', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await resolveAndStage(ctx);

        // Act
        await continueMerge(ctx, { message: 'resolved', author, committer: author });

        // Assert — ORIG_HEAD survives (recovery aid), MERGE_HEAD/MERGE_MSG don't.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/ORIG_HEAD`)).toBe(true);
      });
    });
  });

  describe('Given a resolved merge with explicit author and committer', () => {
    describe('When continueMerge runs', () => {
      it('Then the commit object carries the distinct author and committer identities', async () => {
        // Arrange — distinct author and committer so dropping the committer
        // forward would let `commit` derive committer-from-author and the
        // assertion below would fail. Mutation-resistant: the commit field
        // values must come from the *forwarded* options, not from the
        // author fallback.
        const ctx = createMemoryContext();
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await resolveAndStage(ctx);
        const explicitAuthor: AuthorIdentity = {
          name: 'Bob',
          email: 'bob@example.com',
          timestamp: 1_800_000_000,
          timezoneOffset: '+0100',
        };
        const explicitCommitter: AuthorIdentity = {
          name: 'Carol',
          email: 'carol@example.com',
          timestamp: 1_900_000_000,
          timezoneOffset: '+0200',
        };

        // Act
        const sut = await continueMerge(ctx, {
          message: 'resolved',
          author: explicitAuthor,
          committer: explicitCommitter,
        });

        // Assert — both fields distinguishable in the commit object.
        const obj = await readObject(ctx, sut.id);
        if (obj.type !== 'commit') throw new Error('expected commit');
        expect(obj.data.author.name).toBe('Bob');
        expect(obj.data.author.email).toBe('bob@example.com');
        expect(obj.data.committer.name).toBe('Carol');
        expect(obj.data.committer.email).toBe('carol@example.com');
      });
    });
  });

  describe('Given a resolved merge with failing hooks but noVerify true', () => {
    describe('When continueMerge runs', () => {
      it('Then the commit succeeds with hooks skipped', async () => {
        // Arrange — pre-commit returns exit=1 ONLY when MERGE_HEAD is present
        // (so the fixture-setup commits succeed, but a non-noVerify continueMerge
        // would surface HOOK_FAILED). With noVerify, the commit lands normally.
        let ctx!: Context;
        const runner: HookRunner = {
          run: async (request): Promise<HookResult> => {
            if (request.name === 'pre-commit') {
              const inMerge = await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`);
              if (inMerge) return { kind: 'ran', exitCode: 1, stdout: '', stderr: 'block' };
            }
            return { kind: 'ran', exitCode: 0, stdout: '', stderr: '' };
          },
        };
        ctx = createMemoryContext({ hooks: runner });
        await setupConflictingMerge(ctx);
        await merge(ctx, { target: 'feature', author });
        await resolveAndStage(ctx);

        // Act
        const sut = await continueMerge(ctx, {
          message: 'resolved',
          author,
          committer: author,
          noVerify: true,
        });

        // Assert
        expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });
});
