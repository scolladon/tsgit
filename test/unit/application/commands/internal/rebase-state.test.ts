import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  clearRebaseState,
  readRebaseHead,
  readRebaseProgress,
  readRebaseState,
  readRewrittenList,
  rebaseInProgress,
  writeRebaseStop,
  writeRescheduledLine,
  writeRescheduledPick,
} from '../../../../../src/application/commands/internal/rebase-state.js';
import type { AuthorIdentity, ObjectId } from '../../../../../src/domain/objects/index.js';
import { rebaseTodoBackup } from '../../../../../src/domain/rebase/index.js';
import type { Context } from '../../../../../src/ports/context.js';

// Object verification is updateRef's concern; these suites pin the state layout with ids no store holds.
vi.mock(
  '../../../../../src/application/primitives/internal/ref-target.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../../../src/application/primitives/internal/ref-target.js')
    >()),
    assertRefTargetValid: async () => undefined,
  }),
);

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

      it('Then MERGE_MSG holds the raw path byte of an escaped conflict line', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, { ...STOP, mergeMsg: 't2\n\n# Conflicts:\n#\t\uDCFF\n' });

        // Assert
        const result = await ctx.fs.read(`${ctx.layout.gitDir}/MERGE_MSG`);
        expect(Array.from(result.subarray(-3))).toEqual([0x09, 0xff, 0x0a]);
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

      it('Then no refs-to-delete file is written when no label was executed', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/refs-to-delete`)).toBe(false);
      });

      it('Then the empty marker files are written', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'interactive')).toBe('');
        expect(await read(ctx, 'no-reschedule-failed-exec')).toBe('');
      });

      it.each([
        ['drop', true],
        ['stop', false],
      ] as const)(
        'Then redundantCommits %s writes drop_redundant_commits: %s',
        async (policy, written) => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await writeRebaseStop(ctx, { ...STOP, redundantCommits: policy });

          // Assert
          expect(
            await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/drop_redundant_commits`),
          ).toBe(written);
        },
      );

      it('Then an unset redundantCommits leaves an existing drop_redundant_commits untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, { ...STOP, redundantCommits: 'drop' });

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await read(ctx, 'drop_redundant_commits')).toBe('');
      });

      it('Then an unset redundantCommits writes no drop_redundant_commits', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(
          await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/drop_redundant_commits`),
        ).toBe(false);
      });

      it('Then an empty rewritten list writes no rewritten-list', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, { ...STOP, rewritten: [] });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/rewritten-list`)).toBe(false);
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
        const result = await readRebaseState(ctx);

        // Assert
        expect(result).toEqual({
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

    describe('When the stop is not an edit (no amend marker)', () => {
      it('Then no `amend` file is written', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/amend`)).toBe(false);
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

  describe('Given a reset step refused before it ran', () => {
    const PICK = { action: 'pick', oid: T1, subject: 't1' } as const;
    const RESET = { action: 'reset', label: 'x' } as const;
    const LAST = { action: 'pick', oid: T3, subject: 't3' } as const;
    const RESCHEDULED = {
      headName: 'refs/heads/topic',
      onto: ONTO,
      origHead: ORIG,
      done: [PICK, RESET],
      remaining: [RESET, LAST],
      backupHeader: STOP.backupHeader,
    } as const;

    describe('When writeRescheduledLine persists it over a stale REBASE_HEAD', () => {
      it('Then the reset heads the todo and ends done, with no REBASE_HEAD', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRescheduledPick(ctx, { ...RESCHEDULED, pickSha: T1 });

        // Act
        await writeRescheduledLine(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'git-rebase-todo')).toBe(`reset x\npick ${T3} # t3\n`);
        expect(await read(ctx, 'done')).toBe(`pick ${T1} # t1\n\nreset x\n`);
        expect(await readRebaseHead(ctx)).toBeUndefined();
      });

      it('Then end counts the whole todo and msgnum the done lines', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledLine(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'end')).toBe('3\n');
        expect(await read(ctx, 'msgnum')).toBe('2\n');
      });
    });
  });

  describe('Given a pick refused before it ran', () => {
    const FIRST = { action: 'pick', oid: T1, subject: 't1' } as const;
    const PICK = { action: 'pick', oid: T2, subject: 't2' } as const;
    const LAST = { action: 'pick', oid: T3, subject: 't3' } as const;
    const RESCHEDULED = {
      headName: 'refs/heads/topic',
      onto: ONTO,
      origHead: ORIG,
      done: [FIRST, PICK],
      remaining: [PICK, LAST],
      pickSha: T2,
      backupHeader: STOP.backupHeader,
    } as const;
    const entriesOf = async (ctx: Context): Promise<string[]> =>
      (await ctx.fs.readdir(`${ctx.layout.gitDir}/rebase-merge`)).map((entry) => entry.name).sort();

    describe('When writeRescheduledPick persists it', () => {
      it('Then exactly the files git leaves exist, with no conflict-stop file', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await entriesOf(ctx)).toEqual([
          'done',
          'end',
          'git-rebase-todo',
          'git-rebase-todo.backup',
          'head-name',
          'interactive',
          'msgnum',
          'no-reschedule-failed-exec',
          'onto',
          'orig-head',
        ]);
      });

      it('Then the pick sits in both done and the live todo', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'done')).toBe(`pick ${T1} # t1\npick ${T2} # t2\n`);
        expect(await read(ctx, 'git-rebase-todo')).toBe(`pick ${T2} # t2\npick ${T3} # t3\n`);
      });

      it('Then end counts the whole todo and msgnum the current item', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'end')).toBe('3\n');
        expect(await read(ctx, 'msgnum')).toBe('2\n');
      });

      it('Then head-name, onto, orig-head and the empty markers hold git bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'head-name')).toBe('refs/heads/topic\n');
        expect(await read(ctx, 'onto')).toBe(`${ONTO}\n`);
        expect(await read(ctx, 'orig-head')).toBe(`${ORIG}\n`);
        expect(await read(ctx, 'interactive')).toBe('');
        expect(await read(ctx, 'no-reschedule-failed-exec')).toBe('');
      });

      it.each([
        ['drop', true],
        ['stop', false],
      ] as const)(
        'Then redundantCommits %s writes drop_redundant_commits: %s',
        async (policy, written) => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          await writeRescheduledPick(ctx, { ...RESCHEDULED, redundantCommits: policy });

          // Assert
          expect(
            await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/drop_redundant_commits`),
          ).toBe(written);
        },
      );

      it('Then an unset redundantCommits leaves an existing drop_redundant_commits untouched', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRescheduledPick(ctx, { ...RESCHEDULED, redundantCommits: 'drop' });

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'drop_redundant_commits')).toBe('');
      });

      it('Then the backup lists the whole todo once and REBASE_HEAD names the pick', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const fullTodo = [FIRST, PICK, LAST];

        // Act
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Assert
        expect(await read(ctx, 'git-rebase-todo.backup')).toBe(
          rebaseTodoBackup(fullTodo, STOP.backupHeader),
        );
        expect(await readRebaseHead(ctx)).toBe(T2);
      });

      it('Then no backup is written when none is given', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const withoutBackup = { ...RESCHEDULED, backupHeader: undefined };

        // Act
        await writeRescheduledPick(ctx, withoutBackup);

        // Assert
        expect(
          await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/git-rebase-todo.backup`),
        ).toBe(false);
      });
    });

    describe('When readRebaseProgress reads it back', () => {
      it('Then it reads the stop without a message or an author script and flags it rescheduled', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRescheduledPick(ctx, RESCHEDULED);

        // Act
        const result = await readRebaseProgress(ctx);

        // Assert
        expect(result).toEqual({
          headName: 'refs/heads/topic',
          onto: ONTO,
          origHead: ORIG,
          done: [
            { action: 'pick', oid: T1, subject: 't1' },
            { action: 'pick', oid: T2, subject: 't2' },
          ],
          remaining: [
            { action: 'pick', oid: T2, subject: 't2' },
            { action: 'pick', oid: T3, subject: 't3' },
          ],
          stoppedSha: T2,
          rescheduled: true,
        });
      });
    });

    describe('When readRebaseProgress reads a conflict stop', () => {
      it('Then it is not flagged rescheduled', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, STOP);

        // Act
        const result = await readRebaseProgress(ctx);

        // Assert
        expect(result?.rescheduled).toBe(false);
      });
    });

    describe('When no rebase is in progress', () => {
      it('Then readRebaseProgress returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await readRebaseProgress(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When the refused line carries its author and the rewrites so far', () => {
      const REFUSED = {
        ...RESCHEDULED,
        stoppedAuthor: ADA,
        rewritten: [[T1, NEW1]] as ReadonlyArray<readonly [ObjectId, ObjectId]>,
      } as const;

      it('Then author-script holds that author', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, REFUSED);

        // Assert
        expect(await read(ctx, 'author-script')).toBe(
          "GIT_AUTHOR_NAME='Ada'\nGIT_AUTHOR_EMAIL='ada@example.com'\nGIT_AUTHOR_DATE='@1700000000 +0000'\n",
        );
      });

      it('Then rewritten-list holds the pairs', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, REFUSED);

        // Assert
        expect(await read(ctx, 'rewritten-list')).toBe(`${T1} ${NEW1}\n`);
      });

      it('Then the file list is the conflict stop minus the stop-only files', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, REFUSED);

        // Assert
        expect(await entriesOf(ctx)).toEqual([
          'author-script',
          'done',
          'end',
          'git-rebase-todo',
          'git-rebase-todo.backup',
          'head-name',
          'interactive',
          'msgnum',
          'no-reschedule-failed-exec',
          'onto',
          'orig-head',
          'rewritten-list',
        ]);
      });
    });

    describe('When the refused line has no rewrites', () => {
      it('Then no rewritten-list is written', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRescheduledPick(ctx, { ...RESCHEDULED, stoppedAuthor: ADA, rewritten: [] });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/rewritten-list`)).toBe(false);
      });
    });

    describe('When the refused line sits in an open meld group', () => {
      it('Then the group files are written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const meld = {
          currentFixups: [{ action: 'squash', oid: T2 }] as const,
          rewrittenPending: [T1],
          messageSquash: 'one\n\ntwo\n',
          messageFixup: 'one\n',
        };

        // Act
        await writeRescheduledPick(ctx, { ...RESCHEDULED, meld });

        // Assert
        expect(await read(ctx, 'current-fixups')).toBe(`squash ${T2}`);
        expect(await read(ctx, 'rewritten-pending')).toBe(`${T1}\n`);
        expect(await read(ctx, 'message-squash')).toBe('one\n\ntwo\n');
        expect(await read(ctx, 'message-fixup')).toBe('one\n');
      });
    });

    describe('When a previous stop left its files behind', () => {
      it.each([
        'amend',
        'message',
        'patch',
        'stopped-sha',
        'current-fixups',
        'rewritten-pending',
        'message-fixup',
      ])('Then %s is removed', async (name) => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, {
          ...STOP,
          amend: T2,
          currentFixups: [{ action: 'fixup', oid: T2 }],
          rewrittenPending: [T1],
          messageFixup: 'x\n',
        });

        // Act
        await writeRescheduledPick(ctx, { ...RESCHEDULED, stoppedAuthor: ADA });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/${name}`)).toBe(false);
      });
    });

    describe('When readRebaseProgress reads an occupant reschedule that carries an author', () => {
      it('Then it is flagged rescheduled', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRescheduledPick(ctx, { ...RESCHEDULED, stoppedAuthor: ADA });

        // Act
        const result = await readRebaseProgress(ctx);

        // Assert
        expect(result?.rescheduled).toBe(true);
      });
    });
  });

  describe('Given an interactive edit stop', () => {
    const EDIT_STOP = { ...STOP, amend: T2 } as const;

    describe('When writeRebaseStop persists it', () => {
      it('Then the `amend` file records the commit being amended', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, EDIT_STOP);

        // Assert
        expect(await read(ctx, 'amend')).toBe(`${T2}\n`);
      });
    });

    describe('When readRebaseState reads it back', () => {
      it('Then it surfaces the amend oid (the edit-stop marker)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, EDIT_STOP);

        // Act
        const result = await readRebaseState(ctx);

        // Assert
        expect(result?.amend).toBe(T2);
      });
    });
  });

  describe('Given a squash/fixup group conflict stop', () => {
    const SQUASH_STOP = {
      ...STOP,
      amend: T1,
      currentFixups: [
        { action: 'squash', oid: T2 },
        { action: 'fixup', oid: T3 },
      ],
      rewrittenPending: [T1, T2],
      messageSquash: '# This is a combination of 3 commits.\n',
    } as const;

    describe('When writeRebaseStop persists it', () => {
      it('Then current-fixups lists each group member verb + oid', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, SQUASH_STOP);

        // Assert
        expect(await read(ctx, 'current-fixups')).toBe(`squash ${T2}\nfixup ${T3}`);
      });

      it('Then rewritten-pending lists each already-folded oid', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, SQUASH_STOP);

        // Assert
        expect(await read(ctx, 'rewritten-pending')).toBe(`${T1}\n${T2}\n`);
      });

      it('Then message-squash backs up the running combined message', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, SQUASH_STOP);

        // Assert
        expect(await read(ctx, 'message-squash')).toBe('# This is a combination of 3 commits.\n');
      });
    });

    describe('When readRebaseState reads it back', () => {
      it('Then it surfaces the group members and the pending oids', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, SQUASH_STOP);

        // Act
        const result = await readRebaseState(ctx);

        // Assert
        expect(result?.currentFixups).toEqual([
          { action: 'squash', oid: T2 },
          { action: 'fixup', oid: T3 },
        ]);
        expect(result?.rewrittenPending).toEqual([T1, T2]);
      });
    });

    describe('When a later plain conflict stop is written over it', () => {
      it('Then amend, current-fixups and rewritten-pending are removed while message-squash stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, SQUASH_STOP);
        const sut = writeRebaseStop;

        // Act
        await sut(ctx, STOP);

        // Assert
        const exists = (name: string): Promise<boolean> =>
          ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/${name}`);
        expect(await exists('amend')).toBe(false);
        expect(await exists('current-fixups')).toBe(false);
        expect(await exists('rewritten-pending')).toBe(false);
        expect(await read(ctx, 'message-squash')).toBe('# This is a combination of 3 commits.\n');
      });
    });

    describe('When current-fixups contains a verb with no oid', () => {
      it('Then the malformed entry is dropped, keeping only the well-formed one', async () => {
        // Arrange — a valid member plus a truncated `squash` line (no oid)
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, SQUASH_STOP);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/rebase-merge/current-fixups`,
          `squash ${T2}\nsquash\n`,
        );

        // Act
        const result = await readRebaseState(ctx);

        // Assert — only `squash <oid>` survives; the oid-less verb is skipped
        expect(result?.currentFixups).toEqual([{ action: 'squash', oid: T2 }]);
      });
    });

    describe('When the stop has no group (plain conflict)', () => {
      it('Then neither current-fixups nor rewritten-pending is written', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        await writeRebaseStop(ctx, STOP);

        // Assert
        const base = `${ctx.layout.gitDir}/rebase-merge`;
        expect(await ctx.fs.exists(`${base}/current-fixups`)).toBe(false);
        expect(await ctx.fs.exists(`${base}/rewritten-pending`)).toBe(false);
      });
    });
  });

  describe('Given a git-rebase-todo whose oid cannot be resolved', () => {
    describe('When readRebaseState resolves the remaining picks', () => {
      it('Then it throws INVALID_SEQUENCER_TODO naming the unresolvable commit', async () => {
        // Arrange — a valid stop, then a todo pick pointing at a non-existent oid
        const ctx = createMemoryContext();
        await writeRebaseStop(ctx, STOP);
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/rebase-merge/git-rebase-todo`,
          'pick 1a2b3c4 # gone\n',
        );
        const sut = readRebaseState;

        // Act
        let error: unknown;
        try {
          await sut(ctx);
        } catch (caught) {
          error = caught;
        }

        // Assert
        const data = (error as { data: { code: string; reason: string } }).data;
        expect(data.code).toBe('INVALID_SEQUENCER_TODO');
        expect(data.reason).toBe('cannot resolve commit 1a2b3c4');
      });
    });
  });

  describe('Given a rewritten-list carried across a continue/skip', () => {
    const rewrittenPath = (ctx: Context): string =>
      `${ctx.layout.gitDir}/rebase-merge/rewritten-list`;

    describe('When readRewrittenList reads well-formed old→new lines', () => {
      it('Then it returns each `<old> <new>` pair in order', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(rewrittenPath(ctx), `${T1} ${NEW1}\n${T2} ${T3}\n`);
        const sut = readRewrittenList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([
          [T1, NEW1],
          [T2, T3],
        ]);
      });
    });

    describe('When a rewritten-list line has no new-oid column', () => {
      it('Then the truncated line is dropped, keeping only the complete pair', async () => {
        // Arrange — a valid pair plus a lone oid (single token, no space)
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(rewrittenPath(ctx), `${T1} ${NEW1}\n${T2}\n`);
        const sut = readRewrittenList;

        // Act
        const result = await sut(ctx);

        // Assert — only the two-column line survives
        expect(result).toEqual([[T1, NEW1]]);
      });
    });

    describe('When no rewritten-list file exists', () => {
      it('Then it returns an empty list', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = readRewrittenList;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given no rebase in progress', () => {
    describe('When readRebaseState is called', () => {
      it('Then it returns undefined', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await readRebaseState(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });

    describe('When clearRebaseState is called', () => {
      it('Then it is idempotent (does not throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act + Assert
        await expect(clearRebaseState(ctx)).resolves.toBeUndefined();
      });

      it('Then it does not touch the absent rebase-merge directory', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const rmSpy = vi.spyOn(ctx.fs, 'rmRecursive');

        // Act
        await clearRebaseState(ctx);

        // Assert — the exists() guard must skip the removal when nothing is there.
        expect(rmSpy).not.toHaveBeenCalled();
      });
    });
  });
});
