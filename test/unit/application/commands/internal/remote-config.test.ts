import { describe, expect, it } from 'vitest';
import {
  assertRemoteNameUnnested,
  assertRemoteRefspecsValid,
  fetchesInto,
  listBranchReferrers,
  mapsTrackingNamespace,
  rewriteTrackingFetchRefspecs,
  validateRemoteName,
} from '../../../../../src/application/commands/internal/remote-config.js';
import type { ParsedConfig } from '../../../../../src/application/primitives/config-read.js';
import { sanitizeForDisplay, type TsgitError } from '../../../../../src/domain/error.js';
import type { RefName } from '../../../../../src/domain/objects/object-id.js';

const buildBranch = (
  entries: ReadonlyArray<readonly [string, { remote?: string; merge?: string }]>,
): NonNullable<ParsedConfig['branch']> => new Map(entries);

const buildRemote = (
  entries: ReadonlyArray<
    readonly [string, { fetch?: ReadonlyArray<string>; push?: ReadonlyArray<string> }]
  >,
): NonNullable<ParsedConfig['remote']> => new Map(entries);

const catchError = (act: () => void): TsgitError | undefined => {
  try {
    act();
    return undefined;
  } catch (err) {
    return err as TsgitError;
  }
};

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

    describe('Given a name that cannot form a tracking ref name', () => {
      describe('When validateRemoteName runs', () => {
        it.each([
          { input: '', label: 'an empty name' },
          { input: 'two parts', label: 'a space' },
          { input: 'a\tb', label: 'a tab' },
          { input: 'a\nb', label: 'a newline' },
          { input: 'a\rb', label: 'a carriage return' },
          { input: 'a\0b', label: 'a NUL byte' },
          { input: 'a\\b', label: 'a backslash' },
          { input: 'x.lock', label: 'a .lock suffix' },
          { input: '..', label: 'a double dot alone' },
          { input: 'a..b', label: 'an inner double dot' },
          { input: '.a', label: 'a leading dot' },
          { input: 'a/.b', label: 'a component with a leading dot' },
          { input: 'a//b', label: 'an empty component' },
          { input: 'a/', label: 'a trailing slash' },
          { input: 'a@{b', label: 'an @{ sequence' },
          { input: 'a:b', label: 'a colon' },
          { input: 'a*b', label: 'an asterisk' },
          { input: 'a?b', label: 'a question mark' },
          { input: 'a~b', label: 'a tilde' },
          { input: 'a^b', label: 'a caret' },
          { input: 'a[b', label: 'an opening bracket' },
        ])('Then it throws REMOTE_NAME_INVALID for $label', ({ input }) => {
          // Arrange
          let caught: unknown;

          // Act
          try {
            validateRemoteName(input);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: sanitizeForDisplay(input),
            reason: 'name does not form a valid refs/remotes/<name>/ ref name',
          });
        });
      });
    });

    describe('Given a name git accepts although it looks unusual', () => {
      describe('When validateRemoteName runs', () => {
        it.each([
          { input: 'a.', label: 'a trailing dot' },
          { input: 'a.b', label: 'an inner dot' },
          { input: '@', label: 'a lone at sign' },
          { input: 'team/origin', label: 'a slash' },
          { input: 'a"b', label: 'a double quote' },
          { input: 'a]b', label: 'a closing bracket' },
        ])('Then it returns $label verbatim', ({ input }) => {
          // Arrange + Act
          const result = validateRemoteName(input);

          // Assert
          expect(result).toBe(input);
        });
      });
    });
  });

  describe('assertRemoteNameUnnested', () => {
    describe('Given a config carrying no remote section at all', () => {
      describe('When assertRemoteNameUnnested runs', () => {
        it('Then any name passes, there being no namespace to share', () => {
          // Arrange
          const sut = assertRemoteNameUnnested;

          // Act
          const caught = catchError(() => sut({}, 'origin'));

          // Assert
          expect(caught).toBeUndefined();
        });
      });
    });

    describe('Given a configured remote and a candidate name', () => {
      describe('When assertRemoteNameUnnested runs', () => {
        it.each([
          {
            name: 'a/b',
            reason: "subset of existing remote 'a'",
            label: 'a name nested under the existing remote refuses as a subset',
          },
          {
            name: 'a',
            reason: undefined,
            label: 'a name equal to the existing remote is left to the duplicate check',
          },
          {
            name: 'other',
            reason: undefined,
            label: 'an unrelated name passes',
          },
        ])('Then $label', ({ name, reason }) => {
          // Arrange
          const sut = assertRemoteNameUnnested;
          const config: ParsedConfig = { remote: buildRemote([['a', {}]]) };

          // Act
          const caught = catchError(() => sut(config, name));

          // Assert
          expect(caught?.data).toEqual(
            reason === undefined ? undefined : { code: 'REMOTE_NAME_INVALID', name, reason },
          );
        });
      });
    });

    describe('Given a configured remote nested under the candidate name', () => {
      describe('When assertRemoteNameUnnested runs', () => {
        it('Then it refuses as a superset of that remote', () => {
          // Arrange
          const sut = assertRemoteNameUnnested;
          const config: ParsedConfig = { remote: buildRemote([['a/b', {}]]) };

          // Act
          const caught = catchError(() => sut(config, 'a'));

          // Assert
          expect(caught?.data).toEqual({
            code: 'REMOTE_NAME_INVALID',
            name: 'a',
            reason: "superset of existing remote 'a/b'",
          });
        });
      });
    });
  });

  describe('assertRemoteRefspecsValid', () => {
    describe('Given a remote configuring a refspec git would refuse', () => {
      describe('When assertRemoteRefspecsValid runs', () => {
        it.each([
          {
            entry: { fetch: ['refs/heads/*'] },
            raw: 'refs/heads/*',
            label: 'a fetch spec is named verbatim with the reason it was refused for',
          },
          {
            entry: { push: ['refs/heads/a:'] },
            raw: 'refs/heads/a:',
            label: 'a push spec is named verbatim with the reason it was refused for',
          },
        ])('Then $label', ({ entry, raw }) => {
          // Arrange
          const sut = assertRemoteRefspecsValid;
          const config: ParsedConfig = { remote: buildRemote([['origin', entry]]) };

          // Act
          const caught = catchError(() => sut(config));

          // Assert
          expect(caught?.data).toEqual({
            code: 'REFSPEC_INVALID',
            raw,
            reason: 'not a valid refspec',
          });
        });
      });
    });

    describe('Given every configured remote carries usable refspecs', () => {
      describe('When assertRemoteRefspecsValid runs', () => {
        it('Then it returns without refusing', () => {
          // Arrange
          const sut = assertRemoteRefspecsValid;
          const config: ParsedConfig = {
            remote: buildRemote([
              ['origin', { fetch: ['+refs/heads/*:refs/remotes/origin/*'], push: ['HEAD:refs/x'] }],
            ]),
          };

          // Act
          const caught = catchError(() => sut(config));

          // Assert
          expect(caught).toBeUndefined();
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

  describe('rewriteTrackingFetchRefspecs', () => {
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
            expected: ['+refs/heads/release:refs/remotes/new/release'],
            label: 'a star-free destination under the remote is rewritten too',
          },
          {
            refspecs: [
              '+refs/heads/*:refs/remotes/old/*',
              '+refs/heads/release:refs/remotes/old/release',
            ],
            expected: [
              '+refs/heads/*:refs/remotes/new/*',
              '+refs/heads/release:refs/remotes/new/release',
            ],
            label: 'every mapping entry changes and the order is preserved',
          },
          { refspecs: [], expected: [], label: 'an empty list returns an empty list' },
          {
            refspecs: ['refs/heads/*:refs/remotes/old/*'],
            expected: ['refs/heads/*:refs/remotes/new/*'],
            label: 'the leading `+` plays no part in the match',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/oldish/*'],
            expected: ['+refs/heads/*:refs/remotes/oldish/*'],
            label: 'a destination under a remote merely prefixed by the name is preserved',
          },
          {
            refspecs: ['+refs/*:refs/*'],
            expected: ['+refs/*:refs/*'],
            label: "a mirror's whole-namespace refspec is preserved",
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/deep/*'],
            expected: ['+refs/heads/*:refs/remotes/new/deep/*'],
            label: 'a destination nested deeper under the remote is rewritten',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/pre*post'],
            expected: ['+refs/heads/*:refs/remotes/new/pre*post'],
            label: 'a star in an odd position does not stop the splice',
          },
          {
            refspecs: ['+refs/remotes/old/x:refs/remotes/old/y'],
            expected: ['+refs/remotes/old/x:refs/remotes/new/y'],
            label: 'only the destination occurrence is spliced, never the source',
          },
          {
            refspecs: [':refs/remotes/old/main'],
            expected: [':refs/remotes/new/main'],
            label: 'a source-free refspec, whose marker opens the whole spec, is spliced too',
          },
        ])('Then $label', ({ refspecs, expected }) => {
          // Arrange + Act
          const result = rewriteTrackingFetchRefspecs(refspecs, 'old', 'new');

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });
  });

  describe('fetchesInto', () => {
    describe('Given a list of fetch refspecs', () => {
      describe('When asked whether any fetches into a given ref', () => {
        it.each([
          {
            refspecs: [],
            name: 'refs/remotes/old/x',
            expected: false,
            label: 'an empty list fetches nowhere',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/*'],
            name: 'refs/remotes/old/x',
            expected: true,
            label: 'a trailing star matches a name under it',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/*'],
            name: 'refs/remotes/old/deep/x',
            expected: true,
            label: 'a trailing star matches across slashes',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/sub/*'],
            name: 'refs/remotes/old/x',
            expected: false,
            label: 'a nested destination does not match a name above it',
          },
          {
            refspecs: ['+refs/heads/main:refs/remotes/old/main'],
            name: 'refs/remotes/old/main',
            expected: true,
            label: 'a star-free destination matches only itself',
          },
          {
            refspecs: ['+refs/heads/main:refs/remotes/old/main'],
            name: 'refs/remotes/old/mainx',
            expected: false,
            label: 'a star-free destination does not match a longer name',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/pre*post'],
            name: 'refs/remotes/old/preXpost',
            expected: true,
            label: 'a star in an odd position frames the name',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/pre*post'],
            name: 'refs/remotes/old/prepost',
            expected: true,
            label: 'the two halves may meet with nothing between them',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/prepre*post'],
            name: 'refs/remotes/old/prepost',
            expected: false,
            label: 'the halves may not overlap to reach the name',
          },
          {
            refspecs: ['+refs/*:refs/*'],
            name: 'refs/remotes/old/x',
            expected: true,
            label: 'a mirror refspec fetches into every ref',
          },
          {
            refspecs: ['refs/heads/main'],
            name: 'refs/heads/main',
            expected: false,
            label: 'a colon-free refspec has no destination to match',
          },
          {
            refspecs: [':refs/remotes/old/main'],
            name: 'refs/remotes/old/main',
            expected: true,
            label: 'a source-free refspec still carries the destination after its opening colon',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/aa*aa'],
            name: 'refs/remotes/old/aaa',
            expected: false,
            label: 'a name too short to hold both halves side by side does not match',
          },
          {
            refspecs: ['+refs/tags/*:refs/other/x/*', '+refs/heads/*:refs/remotes/old/*'],
            name: 'refs/remotes/old/x',
            expected: true,
            label: 'one matching entry among others is enough',
          },
        ])('Then $label', ({ refspecs, name, expected }) => {
          // Arrange + Act
          const result = fetchesInto(refspecs, name);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('mapsTrackingNamespace', () => {
    describe('Given a list of fetch refspecs', () => {
      describe("When asked whether any maps into `old`'s tracking namespace", () => {
        it.each([
          { refspecs: [], expected: false, label: 'an empty list maps nothing' },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old/*'],
            expected: true,
            label: 'the canonical default refspec maps',
          },
          {
            refspecs: ['+refs/heads/*:refs/other/old/*'],
            expected: false,
            label: 'a destination outside refs/remotes does not map',
          },
          {
            refspecs: ['+refs/*:refs/*'],
            expected: false,
            label: "a mirror's whole-namespace refspec does not map",
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/oldish/*'],
            expected: false,
            label: 'a remote merely prefixed by the name does not map',
          },
          {
            refspecs: ['+refs/heads/*:refs/remotes/old'],
            expected: false,
            label: 'a destination equal to the namespace without its slash does not map',
          },
          {
            refspecs: ['+refs/tags/*:refs/other/x/*', '+refs/heads/*:refs/remotes/old/deep/*'],
            expected: true,
            label: 'one mapping entry among non-mapping ones is enough',
          },
        ])('Then $label', ({ refspecs, expected }) => {
          // Arrange + Act
          const result = mapsTrackingNamespace(refspecs, 'old');

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });
});
