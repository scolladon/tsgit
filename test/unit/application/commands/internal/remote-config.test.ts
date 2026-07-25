import { describe, expect, it } from 'vitest';
import {
  listBranchReferrers,
  rewriteDefaultFetchRefspecs,
  validateRemoteName,
} from '../../../../../src/application/commands/internal/remote-config.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { RefName } from '../../../../../src/domain/objects/object-id.js';

const buildBranch = (
  entries: ReadonlyArray<readonly [string, { remote?: string; merge?: string }]>,
): NonNullable<ParsedConfig['branch']> => new Map(entries);

describe('application/commands/internal/remote-config', () => {
  describe('validateRemoteName', () => {
    describe('Given a plain ASCII name', () => {
      describe('When validateRemoteName runs', () => {
        it('Then it returns the same name verbatim', () => {
          // Arrange + Act
          const result = validateRemoteName('origin');

          // Assert
          expect(result).toBe('origin');
        });
      });
    });

    describe('Given a name with a forbidden character', () => {
      describe('When validateRemoteName runs', () => {
        it.each([
          // A sibling-prefix collision (e.g. `a` vs `a/b`) would silently
          // delete cross-remote refs in remove/rename; reject slashes
          // outright. Mirrors canonical git's check_refname_format.
          { input: 'team/origin', label: 'a slash (canonical git rejects too)' },
          { input: 'a\tb', label: 'a tab (would corrupt reflog format)' },
          { input: 'a\rb', label: 'a carriage return' },
          { input: 'a\0b', label: 'a NUL byte' },
          { input: 'a"b', label: 'a double-quote' },
          { input: 'a\\b', label: 'a backslash' },
          { input: 'a]b', label: 'a closing bracket' },
        ])('Then it throws REMOTE_NAME_INVALID for $label', ({ input }) => {
          // Arrange + Act
          let caught: unknown;
          try {
            validateRemoteName(input);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('REMOTE_NAME_INVALID');
        });
      });
    });

    describe('Given a name with a space', () => {
      describe('When validateRemoteName runs', () => {
        it('Then it accepts the name (unusual but legal)', () => {
          // Arrange + Act
          const result = validateRemoteName('two parts');

          // Assert
          expect(result).toBe('two parts');
        });
      });
    });

    describe('Given an empty name', () => {
      describe('When validateRemoteName runs', () => {
        it('Then it throws REMOTE_NAME_INVALID with reason "empty"', () => {
          // Arrange + Act
          let caught: unknown;
          try {
            validateRemoteName('');
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_NAME_INVALID');
          if (data.code !== 'REMOTE_NAME_INVALID') throw new Error('unreachable');
          expect(data.reason).toContain('empty');
        });
      });
    });

    describe('Given a name with a newline', () => {
      describe('When validateRemoteName runs', () => {
        it('Then it throws REMOTE_NAME_INVALID with the forbidden-char reason', () => {
          // Arrange + Act
          let caught: unknown;
          try {
            validateRemoteName('a\nb');
          } catch (err) {
            caught = err;
          }

          // Assert — reason pin distinguishes the regex branch from the
          // empty-string branch, killing a mutant that swaps the two throws.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('REMOTE_NAME_INVALID');
          if (data.code !== 'REMOTE_NAME_INVALID') throw new Error('unreachable');
          expect(data.reason).toContain('newline');
        });
      });
    });
  });

  describe('listBranchReferrers', () => {
    describe('Given a parsed config and a target remote name', () => {
      describe('When listBranchReferrers runs', () => {
        it.each([
          {
            config: {} as ParsedConfig,
            expected: [],
            label: 'no branch section returns an empty array',
          },
          {
            config: {
              branch: buildBranch([['main', { remote: 'origin', merge: 'refs/heads/main' }]]),
            } as ParsedConfig,
            expected: [
              { branch: 'main', ref: 'refs/heads/main' as RefName, merge: 'refs/heads/main' },
            ],
            label:
              'one branch tracking the named remote returns that branch with the paired merge value',
          },
          {
            config: {
              branch: buildBranch([['main', { remote: 'origin' }]]),
            } as ParsedConfig,
            expected: [{ branch: 'main', ref: 'refs/heads/main' as RefName, merge: undefined }],
            label: 'a branch with `remote = <name>` but no merge leaves merge undefined',
          },
          {
            config: {
              branch: buildBranch([['main', { remote: 'other' }]]),
            } as ParsedConfig,
            expected: [],
            label: 'a branch tracking a different remote is not returned',
          },
        ])('Then $label', ({ config, expected }) => {
          // Arrange + Act
          const result = listBranchReferrers(config, 'origin');

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });

    describe('Given two branches both tracking the named remote', () => {
      describe('When listBranchReferrers runs', () => {
        it('Then both are returned in iteration order', () => {
          // Arrange
          const config: ParsedConfig = {
            branch: buildBranch([
              ['main', { remote: 'origin', merge: 'refs/heads/main' }],
              ['dev', { remote: 'origin', merge: 'refs/heads/dev' }],
            ]),
          };

          // Act
          const result = listBranchReferrers(config, 'origin');

          // Assert
          expect(result.map((r) => r.branch)).toEqual(['main', 'dev']);
        });
      });
    });
  });

  describe('rewriteDefaultFetchRefspecs', () => {
    describe('Given a list of fetch refspecs', () => {
      describe('When rewritten from `old` to `new`', () => {
        it.each([
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/*'],
            expected: ['+refs/heads/*:refs/remotes/new/*'],
            label:
              'the canonical default refspec has its destination rewritten and its source preserved',
          },
          {
            refspecs: ['+refs/heads/release:refs/remotes/old/release'],
            expected: ['+refs/heads/release:refs/remotes/old/release'],
            label: 'a custom refspec is preserved verbatim',
          },
          {
            refspecs: [
              '+refs/heads/*:refs/remotes/old/*',
              '+refs/heads/release:refs/remotes/old/release',
            ],
            expected: [
              '+refs/heads/*:refs/remotes/new/*',
              '+refs/heads/release:refs/remotes/old/release',
            ],
            label: 'only the canonical entry changes in a mixed list',
          },
          { refspecs: [], expected: [], label: 'an empty list returns an empty list' },
          {
            refspecs: ['refs/heads/*:refs/remotes/old/*'],
            expected: ['refs/heads/*:refs/remotes/old/*'],
            label:
              'the canonical default refspec without the leading `+` is preserved verbatim (no implicit force-form match)',
          },
        ])('Then $label', ({ refspecs, expected }) => {
          // Arrange + Act
          const result = rewriteDefaultFetchRefspecs(refspecs, 'old', 'new');

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });
  });
});
