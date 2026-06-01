import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  clearRebaseState,
  readRebaseHead,
  readRebaseState,
  rebaseInProgress,
  writeRebaseStop,
} from '../../../../../src/application/commands/internal/rebase-state.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';
import { rebaseTodoBackup } from '../../../../../src/domain/rebase/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const ONTO = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as ObjectId;
const ORIG = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as ObjectId;
const T1 = '1111111111111111111111111111111111111111' as ObjectId;
const T2 = '2222222222222222222222222222222222222222' as ObjectId;
const T3 = '3333333333333333333333333333333333333333' as ObjectId;
const NEW1 = '4444444444444444444444444444444444444444' as ObjectId;

const ADA: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const STOP = {
  headName: 'refs/heads/topic',
  onto: ONTO,
  origHead: ORIG,
  done: [
    { action: 'pick', oid: T1, subject: 't1' },
    { action: 'pick', oid: T2, subject: 't2' },
  ],
  remaining: [{ action: 'pick', oid: T3, subject: 't3' }],
  stoppedSha: T2,
  stoppedAuthor: ADA,
  message: 't2\n\n# Conflicts:\n#\tf\n',
  rewritten: [[T1, NEW1]] as ReadonlyArray<readonly [ObjectId, ObjectId]>,
  patch: 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
  backupHeader: { shortUpstream: 'aaaaaaa', shortOrigHead: 'bbbbbbb', shortOnto: 'aaaaaaa' },
} as const;

const read = (ctx: Context, name: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/rebase-merge/${name}`);

describe('rebase-state', () => {
  describe('Given a non-interactive rebase conflict stop', () => {
    describe('When writeRebaseStop persists it', () => {
      it('Then head-name / onto / orig-head hold their `<value>\\n` lines', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'head-name')).toBe('refs/heads/topic\n');
        expect(await read(ctx, 'onto')).toBe(`${ONTO}\n`);
        expect(await read(ctx, 'orig-head')).toBe(`${ORIG}\n`);
      });

      it('Then git-rebase-todo holds the remaining picks and done holds the completed ones', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'git-rebase-todo')).toBe(`pick ${T3} # t3\n`);
        expect(await read(ctx, 'done')).toBe(`pick ${T1} # t1\npick ${T2} # t2\n`);
      });

      it('Then the backup holds the full todo + help block', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'git-rebase-todo.backup')).toBe(
          rebaseTodoBackup([...STOP.done, ...STOP.remaining], STOP.backupHeader),
        );
      });

      it('Then message / author-script / patch are byte-faithful', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'message')).toBe(STOP.message);
        expect(await read(ctx, 'author-script')).toBe(
          "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
        );
        expect(await read(ctx, 'patch')).toBe(STOP.patch);
      });

      it('Then end / msgnum count the instructions and the stopped position', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'end')).toBe('3\n');
        expect(await read(ctx, 'msgnum')).toBe('2\n');
      });

      it('Then rewritten-list maps each completed old oid to its new oid', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'rewritten-list')).toBe(`${T1} ${NEW1}\n`);
      });

      it('Then the empty marker files are written', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'interactive')).toBe('');
        expect(await read(ctx, 'drop_redundant_commits')).toBe('');
        expect(await read(ctx, 'no-reschedule-failed-exec')).toBe('');
      });

      it('Then stopped-sha and .git/REBASE_HEAD record the stopped commit', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'stopped-sha')).toBe(`${T2}\n`);
        expect(await readRebaseHead(ctx)).toBe(T2);
      });
    });

    describe('When readRebaseState reads it back', () => {
      it('Then it aggregates head-name, onto, orig-head, todo, done, author and message', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, STOP);

        // Act
        const sut = await readRebaseState(ctx);

        // Assert
        expect(sut).toEqual({
          headName: 'refs/heads/topic',
          onto: ONTO,
          origHead: ORIG,
          done: [
            { action: 'pick', oid: T1, subject: 't1' },
            { action: 'pick', oid: T2, subject: 't2' },
          ],
          remaining: [{ action: 'pick', oid: T3, subject: 't3' }],
          stoppedSha: T2,
          author: ADA,
          message: STOP.message,
        });
      });
    });

    describe('When rebaseInProgress is queried then the state is cleared', () => {
      it('Then it reports true, and false after the clear', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, STOP);

        // Act + Assert
        expect(await rebaseInProgress(ctx)).toBe(true);
        await clearRebaseState(ctx);
        expect(await rebaseInProgress(ctx)).toBe(false);
      });
    });

    describe('When clearRebaseState removes it', () => {
      it('Then the state dir and REBASE_HEAD are gone', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, STOP);

        // Act
        await clearRebaseState(ctx);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge`)).toBe(false);
        expect(await readRebaseHead(ctx)).toBeUndefined();
      });
    });
  });

  describe('Given no rebase in progress', () => {
    describe('When readRebaseState is called', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await readRebaseState(ctx);

        // Assert
        expect(sut).toBeUndefined();
      });
    });

    describe('When clearRebaseState is called', () => {
      it('Then it is idempotent (does not throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act + Assert
        await expect(clearRebaseState(ctx)).resolves.toBeUndefined();
      });
    });
  });
});
