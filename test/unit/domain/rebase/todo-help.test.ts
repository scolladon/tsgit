import { describe, expect, it } from 'vitest';
import { rebaseTodoBackup } from '../../../../src/domain/rebase/index.js';

const OID_A = '1482021482021482021482021482021482021abc';
const OID_B = '2509fa42509fa42509fa42509fa42509fa42dead';

// The fixed help block git appends to `git-rebase-todo.backup`, captured verbatim
// from git 2.54 (`od`-verified). Embedded independently of the production
// constant so equality proves both are byte-faithful to git.
const HELP_BODY =
  '#\n' +
  '# Commands:\n' +
  '# p, pick <commit> = use commit\n' +
  '# r, reword <commit> = use commit, but edit the commit message\n' +
  '# e, edit <commit> = use commit, but stop for amending\n' +
  '# s, squash <commit> = use commit, but meld into previous commit\n' +
  '# f, fixup [-C | -c] <commit> = like "squash" but keep only the previous\n' +
  "#                    commit's log message, unless -C is used, in which case\n" +
  "#                    keep only this commit's message; -c is same as -C but\n" +
  '#                    opens the editor\n' +
  '# x, exec <command> = run command (the rest of the line) using shell\n' +
  "# b, break = stop here (continue rebase later with 'git rebase --continue')\n" +
  '# d, drop <commit> = remove commit\n' +
  '# l, label <label> = label current HEAD with a name\n' +
  '# t, reset <label> = reset HEAD to a label\n' +
  '# m, merge [-C <commit> | -c <commit>] <label> [# <oneline>]\n' +
  "#         create a merge commit using the original merge commit's\n" +
  '#         message (or the oneline, if no original merge commit was\n' +
  '#         specified); use -c <commit> to reword the commit message\n' +
  '# u, update-ref <ref> = track a placeholder for the <ref> to be updated\n' +
  '#                       to this position in the new commits. The <ref> is\n' +
  '#                       updated at the end of the rebase\n' +
  '#\n' +
  '# These lines can be re-ordered; they are executed from top to bottom.\n' +
  '#\n' +
  '# If you remove a line here THAT COMMIT WILL BE LOST.\n' +
  '#\n' +
  '# However, if you remove everything, the rebase will be aborted.\n' +
  '#\n';

describe('rebase todo-help', () => {
  describe('Given rebaseTodoBackup', () => {
    describe('When the todo has a single pick', () => {
      it('Then assembles the pick line, a blank line, the singular header, and the help body', () => {
        // Arrange
        const picks = [{ action: 'pick' as const, oid: OID_A, subject: 'tc' }];

        // Act
        const sut = rebaseTodoBackup(picks, {
          shortUpstream: '2509fa4',
          shortOrigHead: '1482021',
          shortOnto: '2509fa4',
        });

        // Assert
        expect(sut).toBe(
          `pick ${OID_A} # tc\n\n# Rebase 2509fa4..1482021 onto 2509fa4 (1 command)\n${HELP_BODY}`,
        );
      });
    });

    describe('When the todo has multiple picks', () => {
      it('Then uses the plural command count', () => {
        // Arrange
        const picks = [
          { action: 'pick' as const, oid: OID_A, subject: 't1' },
          { action: 'pick' as const, oid: OID_B, subject: 't2' },
        ];

        // Act
        const sut = rebaseTodoBackup(picks, {
          shortUpstream: 'aaaaaaa',
          shortOrigHead: 'bbbbbbb',
          shortOnto: 'ccccccc',
        });

        // Assert
        expect(sut).toBe(
          `pick ${OID_A} # t1\npick ${OID_B} # t2\n\n# Rebase aaaaaaa..bbbbbbb onto ccccccc (2 commands)\n${HELP_BODY}`,
        );
      });
    });
  });
});
