import { describe, expect, it } from 'vitest';

import {
  adapterUnavailable,
  authorUnconfigured,
  blockedHost,
  branchExists,
  branchNotFound,
  bundleBadHeader,
  bundleEmpty,
  bundleReadFailed,
  bundleUnsupportedVersion,
  type CommandError,
  cannotDeleteCheckedOutBranch,
  cannotDescribe,
  checkoutOverwriteDirty,
  cherryPickMergeNoMainline,
  configBadNumericValue,
  configBadZlibLevel,
  configKeyInvalid,
  configMissingValue,
  configMultipleValues,
  configScopeNotAvailable,
  configSectionNotFound,
  configSystemPathUnresolved,
  configValueInvalid,
  emptyCommitMessage,
  emptyPathspec,
  gitignoreFileTooLarge,
  hookFailed,
  invalidOption,
  invalidPushDefault,
  invalidUrl,
  MAX_HOOK_STDERR_IN_ERROR,
  maxRefspecsExceeded,
  mergeHasConflicts,
  noAnnotatedNames,
  noExactMatch,
  noInitialCommit,
  noNames,
  nonFastForward,
  noOperationInProgress,
  noReachableNames,
  notesAlreadyExist,
  notesObjectHasNone,
  notesRefOutside,
  nothingToCommit,
  noUpstreamConfigured,
  operationInProgress,
  pathspecNoMatch,
  pathspecOutsideRepo,
  pushDefaultNothing,
  pushDetachedNoRefspec,
  pushRejected,
  pushRemoteNotUpstream,
  pushUpstreamNameMismatch,
  remoteAdvertisesNoRefs,
  remoteExists,
  remoteNameInvalid,
  remoteNotConfigured,
  repositoryDisposed,
  revertMergeNoMainline,
  revparseAmbiguous,
  revparseUnresolved,
  sanitize,
  signedPushUnsupported,
  signingFailed,
  sparsePatternFileTooLarge,
  stashApplyWouldOverwrite,
  stashNotFound,
  tagExists,
  tagNotFound,
  targetDirectoryNotEmpty,
  tooManyRedirects,
  unsupportedScheme,
  workingTreeDirty,
  workingTreeFileTooLarge,
} from '../../../../src/domain/commands/error.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { type FilePath, ObjectId, type RefName } from '../../../../src/domain/objects/object-id.js';

const OID1 = ObjectId.from('a'.repeat(40));
const OID2 = ObjectId.from('b'.repeat(40));

const dummyReportStatus = {
  unpackOk: true,
  refUpdates: [],
} as const;

describe('domain commands error — factory data', () => {
  describe('Given the workingTreeDirty error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(workingTreeDirty({ localChanges: ['a' as FilePath], untracked: [] }).data).toEqual({
          code: 'WORKING_TREE_DIRTY',
          localChanges: ['a'],
          untracked: [],
        });
      });
    });
  });

  describe('Given the pathspecNoMatch error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(pathspecNoMatch('*.zzz').data).toEqual({
          code: 'PATHSPEC_NO_MATCH',
          pattern: '*.zzz',
        });
      });
    });
  });

  describe('Given the noInitialCommit error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(noInitialCommit().data).toEqual({ code: 'NO_INITIAL_COMMIT' });
      });
    });
  });

  describe('Given the stashNotFound error helper', () => {
    describe('When called', () => {
      it('Then data carries the requested index and stack size', () => {
        // Arrange + Assert
        expect(stashNotFound(2, 1).data).toEqual({
          code: 'STASH_NOT_FOUND',
          index: 2,
          stackSize: 1,
        });
      });
    });
  });

  describe('Given the stashApplyWouldOverwrite error helper', () => {
    describe('When called', () => {
      it('Then data carries the overwrite-blocked paths', () => {
        // Arrange + Assert
        expect(stashApplyWouldOverwrite(['a' as FilePath, 'b' as FilePath]).data).toEqual({
          code: 'STASH_APPLY_WOULD_OVERWRITE',
          paths: ['a', 'b'],
        });
      });
    });
  });

  describe('Given the cherryPickMergeNoMainline error helper', () => {
    describe('When called with a merge commit oid', () => {
      it('Then data carries the code and the offending commit', () => {
        // Arrange + Act
        const sut = cherryPickMergeNoMainline(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'CHERRY_PICK_MERGE_NO_MAINLINE', commit: OID1 });
        expect(sut.message).toBe(
          `CHERRY_PICK_MERGE_NO_MAINLINE: commit ${OID1} is a merge but no -m option was given`,
        );
      });
    });
  });

  describe('Given the revertMergeNoMainline error helper', () => {
    describe('When called with a merge commit oid', () => {
      it('Then data carries the code and the offending commit', () => {
        // Arrange + Act
        const sut = revertMergeNoMainline(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'REVERT_MERGE_NO_MAINLINE', commit: OID1 });
        expect(sut.message).toBe(
          `REVERT_MERGE_NO_MAINLINE: commit ${OID1} is a merge but no -m option was given`,
        );
      });
    });
  });

  describe('Given the noNames error helper', () => {
    describe('When called with the target oid', () => {
      it('Then data and message carry the code and oid', () => {
        // Arrange + Act
        const sut = noNames(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'NO_NAMES', oid: OID1 });
        expect(sut.message).toBe(`NO_NAMES: no names found, cannot describe ${OID1}`);
      });
    });
  });

  describe('Given the noAnnotatedNames error helper', () => {
    describe('When called with the target oid', () => {
      it('Then data and message carry the code and oid', () => {
        // Arrange + Act
        const sut = noAnnotatedNames(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'NO_ANNOTATED_NAMES', oid: OID1 });
        expect(sut.message).toBe(
          `NO_ANNOTATED_NAMES: no annotated tags can describe ${OID1}; try tags: true`,
        );
      });
    });
  });

  describe('Given the noReachableNames error helper', () => {
    describe('When called with the target oid', () => {
      it('Then data and message carry the code and oid', () => {
        // Arrange + Act
        const sut = noReachableNames(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'NO_REACHABLE_NAMES', oid: OID1 });
        expect(sut.message).toBe(`NO_REACHABLE_NAMES: no tags can describe ${OID1}`);
      });
    });
  });

  describe('Given the noExactMatch error helper', () => {
    describe('When called with the target oid', () => {
      it('Then data and message carry the code and oid', () => {
        // Arrange + Act
        const sut = noExactMatch(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'NO_EXACT_MATCH', oid: OID1 });
        expect(sut.message).toBe(`NO_EXACT_MATCH: no tag exactly matches ${OID1}`);
      });
    });
  });

  describe('Given the cannotDescribe error helper', () => {
    describe('When called with the target oid', () => {
      it('Then data and message carry the code and oid', () => {
        // Arrange + Act
        const sut = cannotDescribe(OID1);

        // Assert
        expect(sut.data).toEqual({ code: 'CANNOT_DESCRIBE', oid: OID1 });
        expect(sut.message).toBe(`CANNOT_DESCRIBE: cannot describe ${OID1}`);
      });
    });
  });

  describe('Given the pathspecOutsideRepo error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(pathspecOutsideRepo('/etc/passwd' as FilePath).data).toEqual({
          code: 'PATHSPEC_OUTSIDE_REPO',
          path: '/etc/passwd',
        });
      });
    });
  });

  describe('Given the nothingToCommit error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = nothingToCommit().data;

        // Assert
        expect(sut).toEqual({ code: 'NOTHING_TO_COMMIT' });
      });
    });
  });

  describe('Given the emptyCommitMessage error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = emptyCommitMessage().data;

        // Assert
        expect(sut).toEqual({ code: 'EMPTY_COMMIT_MESSAGE' });
      });
    });
  });

  describe('Given the authorUnconfigured error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = authorUnconfigured().data;

        // Assert
        expect(sut).toEqual({ code: 'AUTHOR_UNCONFIGURED' });
      });
    });
  });

  describe('Given the branchExists error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(branchExists('refs/heads/x' as RefName).data).toEqual({
          code: 'BRANCH_EXISTS',
          name: 'refs/heads/x',
        });
      });
    });
  });

  describe('Given the branchNotFound error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(branchNotFound('refs/heads/x' as RefName).data).toEqual({
          code: 'BRANCH_NOT_FOUND',
          name: 'refs/heads/x',
        });
      });
    });
  });

  describe('Given the noUpstreamConfigured error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(noUpstreamConfigured('refs/heads/main' as RefName).data).toEqual({
          code: 'NO_UPSTREAM_CONFIGURED',
          branch: 'refs/heads/main',
        });
      });
    });
  });

  describe('Given the tagExists error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(tagExists('refs/tags/v1' as RefName).data).toEqual({
          code: 'TAG_EXISTS',
          name: 'refs/tags/v1',
        });
      });
    });
  });

  describe('Given the tagNotFound error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(tagNotFound('refs/tags/v1' as RefName).data).toEqual({
          code: 'TAG_NOT_FOUND',
          name: 'refs/tags/v1',
        });
      });
    });
  });

  describe('Given the cannotDeleteCheckedOutBranch error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(cannotDeleteCheckedOutBranch('refs/heads/main' as RefName).data).toEqual({
          code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH',
          name: 'refs/heads/main',
        });
      });
    });
  });

  describe('Given the invalidUrl error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = invalidUrl('bad').data;

        // Assert
        expect(sut).toEqual({ code: 'INVALID_URL', reason: 'bad' });
      });
    });
  });

  describe('Given the blockedHost error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(blockedHost('1.2.3.4', 'private').data).toEqual({
          code: 'BLOCKED_HOST',
          host: '1.2.3.4',
          reason: 'private',
        });
      });
    });
  });

  describe('Given the tooManyRedirects error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = tooManyRedirects(6).data;

        // Assert
        expect(sut).toEqual({ code: 'TOO_MANY_REDIRECTS', count: 6 });
      });
    });
  });

  describe('Given the unsupportedScheme error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(unsupportedScheme('ftp').data).toEqual({
          code: 'UNSUPPORTED_SCHEME',
          scheme: 'ftp',
        });
      });
    });
  });

  describe('Given the targetDirectoryNotEmpty error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(targetDirectoryNotEmpty('/repo' as FilePath).data).toEqual({
          code: 'TARGET_DIRECTORY_NOT_EMPTY',
          path: '/repo',
        });
      });
    });
  });

  describe('Given the remoteAdvertisesNoRefs error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = remoteAdvertisesNoRefs().data;

        // Assert
        expect(sut).toEqual({ code: 'REMOTE_ADVERTISES_NO_REFS' });
      });
    });
  });

  describe('Given the nonFastForward error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(nonFastForward('refs/heads/main' as RefName, OID1, OID2).data).toEqual({
          code: 'NON_FAST_FORWARD',
          ref: 'refs/heads/main',
          local: OID1,
          remote: OID2,
        });
      });
    });
  });

  describe('Given the pushRejected error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(
          pushRejected('refs/heads/main' as RefName, 'declined', dummyReportStatus).data,
        ).toEqual({
          code: 'PUSH_REJECTED',
          ref: 'refs/heads/main',
          reason: 'declined',
          reportStatus: dummyReportStatus,
        });
      });
    });
  });

  describe('Given the mergeHasConflicts helper variant (default paths)', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(mergeHasConflicts(3).data).toEqual({
          code: 'MERGE_HAS_CONFLICTS',
          count: 3,
          paths: [],
        });
      });
    });
  });

  describe('Given the mergeHasConflicts helper variant (explicit paths)', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(mergeHasConflicts(2, ['a.txt' as FilePath, 'b.txt' as FilePath]).data).toEqual({
          code: 'MERGE_HAS_CONFLICTS',
          count: 2,
          paths: ['a.txt', 'b.txt'],
        });
      });
    });
  });

  describe('Given more conflict paths than the cap', () => {
    describe('When mergeHasConflicts is called', () => {
      it('Then the paths array is truncated', () => {
        // Arrange — 150 fake paths exceeds MAX_CONFLICT_PATHS_IN_ERROR (100).
        const paths = Array.from({ length: 150 }, (_, i) => `f${i}.txt` as FilePath);

        // Act
        const err = mergeHasConflicts(150, paths);
        const data = err.data as {
          readonly code: string;
          readonly count: number;
          readonly paths: ReadonlyArray<string>;
          readonly truncated?: boolean;
        };

        // Assert — count reflects the full conflict total; paths is capped; the
        // truncated flag fires so observers know the elision happened.
        expect(data.count).toBe(150);
        expect(data.paths).toHaveLength(100);
        expect(data.paths[0]).toBe('f0.txt');
        expect(data.paths[99]).toBe('f99.txt');
        expect(data.truncated).toBe(true);
      });
    });
  });

  describe('Given paths fitting under the cap', () => {
    describe('When mergeHasConflicts is called', () => {
      it('Then truncated is not set', () => {
        // Arrange
        const paths = Array.from({ length: 5 }, (_, i) => `f${i}.txt` as FilePath);

        // Act
        const err = mergeHasConflicts(5, paths);
        const data = err.data as { readonly truncated?: boolean };

        // Assert — truncated field absent (not just false) when no elision happened.
        expect(data.truncated).toBeUndefined();
      });
    });
  });

  describe('Given paths exactly at the cap', () => {
    describe('When mergeHasConflicts is called', () => {
      it('Then all paths are kept and truncated is omitted', () => {
        // Arrange — exactly MAX_CONFLICT_PATHS_IN_ERROR (100) paths: the boundary
        // where `paths.length > cap` is false and `>= cap` would be true.
        const paths = Array.from({ length: 100 }, (_, i) => `f${i}.txt` as FilePath);

        // Act
        const err = mergeHasConflicts(100, paths);
        const data = err.data as {
          readonly paths: ReadonlyArray<string>;
          readonly truncated?: boolean;
        };

        // Assert — no elision: every path retained, truncated field absent.
        expect(data.paths).toHaveLength(100);
        expect(data.truncated).toBeUndefined();
      });
    });
  });

  describe('Given the checkoutOverwriteDirty error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(
          checkoutOverwriteDirty({ localChanges: ['a' as FilePath], untracked: [] }).data,
        ).toEqual({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['a'],
          untracked: [],
        });
      });
    });
  });

  describe('Given the revparseAmbiguous error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(revparseAmbiguous('abc1', [OID1, OID2]).data).toEqual({
          code: 'REVPARSE_AMBIGUOUS',
          expression: 'abc1',
          candidates: [OID1, OID2],
        });
      });
    });
  });

  describe('Given the revparseUnresolved error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(revparseUnresolved('foo').data).toEqual({
          code: 'REVPARSE_UNRESOLVED',
          expression: 'foo',
        });
      });
    });
  });

  describe('Given the emptyPathspec error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange
        const sut = emptyPathspec().data;

        // Assert
        expect(sut).toEqual({ code: 'EMPTY_PATHSPEC' });
      });
    });
  });

  describe('Given the operationInProgress error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(operationInProgress('merge').data).toEqual({
          code: 'OPERATION_IN_PROGRESS',
          operation: 'merge',
        });
      });
    });
  });

  describe('Given the noOperationInProgress error helper', () => {
    describe('When called', () => {
      it.each([['merge'], ['rebase']] as const)('Then data carries operation=%s', (operation) => {
        // Arrange + Act
        const sut = noOperationInProgress(operation);

        // Assert
        expect(sut.data).toEqual({
          code: 'NO_OPERATION_IN_PROGRESS',
          operation,
        });
      });
    });
  });

  describe('Given the maxRefspecsExceeded error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(maxRefspecsExceeded(2000, 1024).data).toEqual({
          code: 'MAX_REFSPECS_EXCEEDED',
          count: 2000,
          limit: 1024,
        });
      });
    });
  });

  describe('Given the remoteNotConfigured error helper', () => {
    describe('When called', () => {
      it('Then data matches expected shape', () => {
        // Arrange + Assert
        expect(remoteNotConfigured('upstream').data).toEqual({
          code: 'REMOTE_NOT_CONFIGURED',
          remote: 'upstream',
        });
      });
    });
  });

  describe('Given the remoteExists error helper', () => {
    describe('When called', () => {
      it('Then data carries the remote name and the REMOTE_EXISTS code', () => {
        // Arrange + Assert
        expect(remoteExists('origin').data).toEqual({
          code: 'REMOTE_EXISTS',
          remote: 'origin',
        });
      });
    });
  });

  describe('Given the remoteNameInvalid error helper', () => {
    describe('When called with a printable reason', () => {
      it('Then data carries the verbatim name and reason', () => {
        // Arrange + Assert
        expect(remoteNameInvalid('a\rb', 'control char').data).toEqual({
          code: 'REMOTE_NAME_INVALID',
          name: 'a\\x0Db',
          reason: 'control char',
        });
      });
    });
  });

  describe('Given a reason for invalidOption', () => {
    describe('When invalidOption is called with option="cwd"', () => {
      it.each([
        {
          reason: 'must be absolute',
          expected: 'must be absolute',
          label: 'a printable reason carries verbatim, alongside the verbatim option name',
        },
        {
          reason: 'bad\rvalue',
          expected: 'bad\\x0Dvalue',
          label: 'a reason with a CR byte is sanitized via \\xNN',
        },
      ])('Then $label', ({ reason, expected }) => {
        // Arrange + Act
        const sut = invalidOption('cwd', reason);

        // Assert
        expect(sut.data).toEqual({
          code: 'INVALID_OPTION',
          option: 'cwd',
          reason: expected,
        });
      });
    });
  });

  describe('Given no arguments', () => {
    describe('When repositoryDisposed', () => {
      it('Then data has only the code', () => {
        // Arrange
        const sut = repositoryDisposed().data;

        // Assert
        expect(sut).toEqual({ code: 'REPOSITORY_DISPOSED' });
      });
    });
  });

  describe('Given a path, size, and limit', () => {
    describe('When workingTreeFileTooLarge', () => {
      it('Then data carries every field verbatim', () => {
        // Arrange + Assert
        expect(workingTreeFileTooLarge('big.bin' as FilePath, 300, 256).data).toEqual({
          code: 'WORKING_TREE_FILE_TOO_LARGE',
          path: 'big.bin',
          size: 300,
          limit: 256,
        });
      });
    });
    describe('When gitignoreFileTooLarge', () => {
      it('Then data carries every field verbatim', () => {
        // Arrange + Assert
        expect(gitignoreFileTooLarge('.gitignore' as FilePath, 2_000_000, 1_048_576).data).toEqual({
          code: 'GITIGNORE_FILE_TOO_LARGE',
          path: '.gitignore',
          size: 2_000_000,
          limit: 1_048_576,
        });
      });
    });
    describe('When sparsePatternFileTooLarge', () => {
      it('Then data carries every field verbatim', () => {
        // Arrange + Assert
        expect(
          sparsePatternFileTooLarge('info/sparse-checkout' as FilePath, 2_000_000, 1_048_576).data,
        ).toEqual({
          code: 'SPARSE_PATTERN_FILE_TOO_LARGE',
          path: 'info/sparse-checkout',
          size: 2_000_000,
          limit: 1_048_576,
        });
      });
    });
  });

  describe('Given runtime and reason', () => {
    describe('When adapterUnavailable', () => {
      it('Then data carries verbatim runtime and sanitized reason', () => {
        // Arrange + Assert
        expect(adapterUnavailable('node', 'process.versions missing').data).toEqual({
          code: 'ADAPTER_UNAVAILABLE',
          runtime: 'node',
          reason: 'process.versions missing',
        });
      });
    });
  });

  describe('Given a reason with a control byte', () => {
    describe('When adapterUnavailable', () => {
      it('Then reason is sanitized', () => {
        // Arrange + Assert
        expect(adapterUnavailable('browser', 'no\x07OPFS').data).toEqual({
          code: 'ADAPTER_UNAVAILABLE',
          runtime: 'browser',
          reason: 'no\\x07OPFS',
        });
      });
    });
  });

  describe('Given a hook, exit code, and stderr', () => {
    describe('When hookFailed', () => {
      it('Then data carries every field verbatim', () => {
        // Arrange + Assert
        expect(hookFailed('pre-commit', 1, 'lint failed').data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'pre-commit',
          exitCode: 1,
          stderr: 'lint failed',
        });
      });
    });
  });

  describe('Given stderr with a CR byte', () => {
    describe('When hookFailed', () => {
      it('Then stderr is sanitized via \\xNN', () => {
        // Arrange + Assert
        expect(hookFailed('commit-msg', 2, 'bad\rmsg').data).toEqual({
          code: 'HOOK_FAILED',
          hook: 'commit-msg',
          exitCode: 2,
          stderr: 'bad\\x0Dmsg',
        });
      });
    });
  });

  describe('Given stderr one byte over the cap', () => {
    describe('When hookFailed', () => {
      it('Then stderr is truncated to the cap', () => {
        // Arrange — printable bytes so sanitization is length-stable; one past the cap.
        const oversized = 'x'.repeat(MAX_HOOK_STDERR_IN_ERROR + 1);

        // Act
        const data = hookFailed('pre-push', 1, oversized).data as { readonly stderr: string };

        // Assert
        expect(data.stderr).toHaveLength(MAX_HOOK_STDERR_IN_ERROR);
      });
    });
  });
});

describe('sanitize helper', () => {
  describe('Given a value sanitize keeps verbatim', () => {
    describe('When sanitize', () => {
      it.each([
        {
          input: 'hello world 123',
          expected: 'hello world 123',
          label: 'printable ASCII is returned unchanged',
        },
        {
          input: 'a\tb\nc',
          expected: 'a\tb\nc',
          label: 'a tab and newline are preserved verbatim',
        },
        {
          input: 'a~b',
          expected: 'a~b',
          label: 'a tilde (0x7e, the printable-range upper bound) is kept verbatim',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = sanitize(input);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });

  describe('Given a value sanitize escapes as \\xNN', () => {
    describe('When sanitize', () => {
      it.each([
        { input: 'a\rb', expected: 'a\\x0Db', label: 'CR and other control bytes are escaped' },
        { input: 'a\0b', expected: 'a\\x00b', label: 'a NUL byte is escaped as \\x00' },
        {
          input: 'a\x80b',
          expected: 'a\\x80b',
          label: 'a high-byte non-ASCII character is escaped',
        },
        {
          input: 'a\x7Fb',
          expected: 'a\\x7Fb',
          label: 'DEL (0x7f, just past the printable upper bound) is escaped',
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = sanitize(input);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('domain commands error — config factory data', () => {
  describe('Given the configKeyInvalid helper', () => {
    describe('When called with reason="empty-section" and no position', () => {
      it('Then data omits the position field', () => {
        // Arrange + Act
        const sut = configKeyInvalid('.name', 'empty-section');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: '.name',
          reason: 'empty-section',
        });
        expect(sut.data).not.toHaveProperty('position');
      });
    });

    describe('When called with reason="missing-name" and no position', () => {
      it('Then data omits the position field', () => {
        // Arrange + Act
        const sut = configKeyInvalid('user.', 'missing-name');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user.',
          reason: 'missing-name',
        });
        expect(sut.data).not.toHaveProperty('position');
      });
    });

    describe('When called with reason="bad-character" and a position', () => {
      it('Then data carries the exact position number', () => {
        // Arrange + Act
        const sut = configKeyInvalid('1user.name', 'bad-character', 0);

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: '1user.name',
          reason: 'bad-character',
          position: 0,
        });
      });
    });

    describe('When called with a key containing a control character', () => {
      it('Then the key is sanitized for display', () => {
        // Arrange + Act
        const sut = configKeyInvalid('user.\x07name', 'bad-character', 5);

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_KEY_INVALID',
          key: 'user.\\x07name',
          reason: 'bad-character',
          position: 5,
        });
      });
    });
  });

  describe('Given the configValueInvalid helper', () => {
    describe('When called', () => {
      it('Then data carries the sanitized key, reason, and exact position', () => {
        // Arrange + Act
        const sut = configValueInvalid('user.name', 3);

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_VALUE_INVALID',
          key: 'user.name',
          reason: 'control-character',
          position: 3,
        });
      });
    });
  });

  describe('Given the configMultipleValues helper', () => {
    describe('When called without a scope and requested="read"', () => {
      it('Then data omits the scope field', () => {
        // Arrange + Act
        const sut = configMultipleValues('remote.origin.fetch', 2, 'read');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_MULTIPLE_VALUES',
          key: 'remote.origin.fetch',
          count: 2,
          requested: 'read',
        });
        expect(sut.data).not.toHaveProperty('scope');
      });
    });

    describe('When called with a scope and requested="overwrite"', () => {
      it('Then data carries every field', () => {
        // Arrange + Act
        const sut = configMultipleValues('remote.origin.fetch', 3, 'overwrite', 'local');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_MULTIPLE_VALUES',
          key: 'remote.origin.fetch',
          count: 3,
          requested: 'overwrite',
          scope: 'local',
        });
      });
    });

    describe('When called with requested="remove"', () => {
      it('Then the requested literal round-trips', () => {
        // Arrange + Act
        const sut = configMultipleValues('user.email', 4, 'remove');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_MULTIPLE_VALUES',
          key: 'user.email',
          count: 4,
          requested: 'remove',
        });
      });
    });
  });

  describe('Given the configSectionNotFound helper', () => {
    describe('When called', () => {
      it('Then data carries the sanitized name and scope', () => {
        // Arrange + Act
        const sut = configSectionNotFound('remote.\x07origin', 'global');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_SECTION_NOT_FOUND',
          name: 'remote.\\x07origin',
          scope: 'global',
        });
      });
    });
  });

  describe('Given the configScopeNotAvailable helper', () => {
    describe('When called with reason="browser-adapter"', () => {
      it('Then data round-trips with the browser-adapter reason', () => {
        // Arrange + Act
        const sut = configScopeNotAvailable('global', 'browser-adapter');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'global',
          reason: 'browser-adapter',
        });
      });
    });

    describe('When called with reason="worktree-extension-unset"', () => {
      it('Then data round-trips with the worktree-extension-unset reason', () => {
        // Arrange + Act
        const sut = configScopeNotAvailable('worktree', 'worktree-extension-unset');

        // Assert
        expect(sut.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'worktree',
          reason: 'worktree-extension-unset',
        });
      });
    });
  });

  describe('Given the configSystemPathUnresolved helper', () => {
    describe('When called', () => {
      it('Then data carries only the code', () => {
        // Arrange + Act
        const sut = configSystemPathUnresolved();

        // Assert
        expect(sut.data).toEqual({ code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' });
      });
    });
  });

  describe('Given the configMissingValue helper', () => {
    describe("When called with key='user.name', source='/abs/.git/config', line=2", () => {
      it('Then data carries code, key, source, and line individually', () => {
        // Arrange + Act
        const sut = configMissingValue('user.name', '/abs/.git/config', 2);

        // Assert
        const data = sut.data;
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        if (data.code !== 'CONFIG_MISSING_VALUE') return;
        expect(data.key).toBe('user.name');
        expect(data.source).toBe('/abs/.git/config');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given the configBadNumericValue helper', () => {
    describe("When called with key='core.loosecompression', source='/abs/.git/config', value='', reason='invalid unit'", () => {
      it('Then data carries code, key, source, value, and reason individually', () => {
        // Arrange + Act
        const sut = configBadNumericValue(
          'core.loosecompression',
          '/abs/.git/config',
          '',
          'invalid unit',
        );

        // Assert
        const data = sut.data;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        if (data.code !== 'CONFIG_BAD_NUMERIC_VALUE') return;
        expect(data.key).toBe('core.loosecompression');
        expect(data.source).toBe('/abs/.git/config');
        expect(data.value).toBe('');
        expect(data.reason).toBe('invalid unit');
      });
    });

    describe("When called with key='core.loosecompression', source='/abs/.git/config', value='2147483648', reason='out of range'", () => {
      it('Then data carries code, key, source, value, and reason individually', () => {
        // Arrange + Act
        const sut = configBadNumericValue(
          'core.loosecompression',
          '/abs/.git/config',
          '2147483648',
          'out of range',
        );

        // Assert
        const data = sut.data;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        if (data.code !== 'CONFIG_BAD_NUMERIC_VALUE') return;
        expect(data.key).toBe('core.loosecompression');
        expect(data.source).toBe('/abs/.git/config');
        expect(data.value).toBe('2147483648');
        expect(data.reason).toBe('out of range');
      });
    });

    describe('When called with a value containing a control byte', () => {
      it('Then data.value is sanitized for display', () => {
        // Arrange + Act
        const sut = configBadNumericValue(
          'core.loosecompression',
          '/abs/.git/config',
          '\x01bad',
          'invalid unit',
        );

        // Assert — control bytes are escaped so the rendered error cannot be injected
        const data = sut.data;
        expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
        if (data.code !== 'CONFIG_BAD_NUMERIC_VALUE') return;
        expect(data.value).toBe('\\x01bad');
      });
    });
  });

  describe('Given the configBadZlibLevel helper', () => {
    describe('When called', () => {
      it.each([[99], [-2]] as const)('Then data carries code and level=%i', (level) => {
        // Arrange + Act
        const sut = configBadZlibLevel(level);

        // Assert
        const data = sut.data;
        expect(data.code).toBe('CONFIG_BAD_ZLIB_LEVEL');
        if (data.code !== 'CONFIG_BAD_ZLIB_LEVEL') return;
        expect(data.level).toBe(level);
      });
    });
  });
});

describe('domain commands error — extractDetail message formatting', () => {
  type Case = readonly [CommandError, string];
  const cases: ReadonlyArray<Case> = [
    [
      {
        code: 'WORKING_TREE_DIRTY',
        localChanges: ['a' as FilePath],
        untracked: ['b' as FilePath],
      },
      'WORKING_TREE_DIRTY: working tree has uncommitted changes: 2 files',
    ],
    [
      { code: 'PATHSPEC_NO_MATCH', pattern: '*.zzz' },
      'PATHSPEC_NO_MATCH: pathspec did not match any files: *.zzz',
    ],
    [
      { code: 'PATHSPEC_OUTSIDE_REPO', path: '/etc/passwd' as FilePath },
      'PATHSPEC_OUTSIDE_REPO: pathspec resolves outside repository: passwd',
    ],
    [
      { code: 'NOTHING_TO_COMMIT' },
      'NOTHING_TO_COMMIT: nothing to commit (use allowEmpty: true to commit anyway)',
    ],
    [
      { code: 'EMPTY_COMMIT_MESSAGE' },
      'EMPTY_COMMIT_MESSAGE: commit message is empty (use allowEmptyMessage: true to commit anyway)',
    ],
    [
      { code: 'AUTHOR_UNCONFIGURED' },
      'AUTHOR_UNCONFIGURED: author identity not configured (set ctx.config.user or pass author/committer)',
    ],
    [
      { code: 'BRANCH_EXISTS', name: 'refs/heads/x' as RefName },
      'BRANCH_EXISTS: branch already exists: refs/heads/x',
    ],
    [
      { code: 'BRANCH_NOT_FOUND', name: 'refs/heads/x' as RefName },
      'BRANCH_NOT_FOUND: branch not found: refs/heads/x',
    ],
    [
      { code: 'TAG_EXISTS', name: 'refs/tags/v1' as RefName },
      'TAG_EXISTS: tag already exists: refs/tags/v1',
    ],
    [
      { code: 'TAG_NOT_FOUND', name: 'refs/tags/v1' as RefName },
      'TAG_NOT_FOUND: tag not found: refs/tags/v1',
    ],
    [
      { code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH', name: 'refs/heads/main' as RefName },
      'CANNOT_DELETE_CHECKED_OUT_BRANCH: cannot delete branch currently checked out: refs/heads/main',
    ],
    [{ code: 'INVALID_URL', reason: 'bad' }, 'INVALID_URL: invalid URL: bad'],
    [
      { code: 'BLOCKED_HOST', host: '1.2.3.4', reason: 'private' },
      'BLOCKED_HOST: host blocked: 1.2.3.4 (private)',
    ],
    [{ code: 'TOO_MANY_REDIRECTS', count: 6 }, 'TOO_MANY_REDIRECTS: too many redirects: 6'],
    [
      { code: 'UNSUPPORTED_SCHEME', scheme: 'ftp' },
      'UNSUPPORTED_SCHEME: unsupported URL scheme: ftp',
    ],
    [
      { code: 'TARGET_DIRECTORY_NOT_EMPTY', path: '/foo/repo' as FilePath },
      'TARGET_DIRECTORY_NOT_EMPTY: target directory is not empty: repo',
    ],
    [{ code: 'REMOTE_ADVERTISES_NO_REFS' }, 'REMOTE_ADVERTISES_NO_REFS: remote advertised no refs'],
    [
      { code: 'NON_FAST_FORWARD', ref: 'refs/heads/main' as RefName, local: OID1, remote: OID2 },
      `NON_FAST_FORWARD: non-fast-forward update for refs/heads/main: local=${OID1} remote=${OID2}`,
    ],
    [
      {
        code: 'PUSH_REJECTED',
        ref: 'refs/heads/main' as RefName,
        reason: 'declined',
        reportStatus: dummyReportStatus,
      },
      'PUSH_REJECTED: push rejected for refs/heads/main: declined',
    ],
    [
      { code: 'MERGE_HAS_CONFLICTS', count: 3, paths: [] },
      'MERGE_HAS_CONFLICTS: merge has unresolved conflicts: 3 files',
    ],
    [
      { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['a' as FilePath], untracked: [] },
      'CHECKOUT_OVERWRITE_DIRTY: checkout would overwrite uncommitted changes: 1 files',
    ],
    [
      { code: 'REVPARSE_AMBIGUOUS', expression: 'abc1', candidates: [OID1, OID2] },
      'REVPARSE_AMBIGUOUS: revision expression "abc1" is ambiguous (2 candidates)',
    ],
    [
      { code: 'REVPARSE_UNRESOLVED', expression: 'bogus' },
      'REVPARSE_UNRESOLVED: cannot resolve revision: bogus',
    ],
    [{ code: 'EMPTY_PATHSPEC' }, 'EMPTY_PATHSPEC: pathspec is empty (use "." to mean "all paths")'],
    [
      { code: 'OPERATION_IN_PROGRESS', operation: 'merge' },
      'OPERATION_IN_PROGRESS: merge in progress; complete or abort it before running this command',
    ],
    [
      { code: 'NO_OPERATION_IN_PROGRESS', operation: 'merge' },
      'NO_OPERATION_IN_PROGRESS: no merge in progress',
    ],
    [
      { code: 'NO_OPERATION_IN_PROGRESS', operation: 'rebase' },
      'NO_OPERATION_IN_PROGRESS: no rebase in progress',
    ],
    [
      { code: 'MAX_REFSPECS_EXCEEDED', count: 2000, limit: 1024 },
      'MAX_REFSPECS_EXCEEDED: 2000 refspecs exceeds limit 1024',
    ],
    [
      { code: 'REMOTE_NOT_CONFIGURED', remote: 'upstream' },
      'REMOTE_NOT_CONFIGURED: remote not configured: upstream',
    ],
    [{ code: 'REMOTE_EXISTS', remote: 'origin' }, 'REMOTE_EXISTS: remote already exists: origin'],
    [
      { code: 'REMOTE_NAME_INVALID', name: 'bad\\x0Aname', reason: 'has newline' },
      'REMOTE_NAME_INVALID: invalid remote name "bad\\x0Aname": has newline',
    ],
    [
      { code: 'INVALID_OPTION', option: 'cwd', reason: 'must be absolute' },
      'INVALID_OPTION: invalid option: cwd — must be absolute',
    ],
    [
      { code: 'INVALID_OPTION', option: 'cwd', reason: 'bad\\x0Dvalue' },
      'INVALID_OPTION: invalid option: cwd — bad\\x0Dvalue',
    ],
    [
      { code: 'REPOSITORY_DISPOSED' },
      'REPOSITORY_DISPOSED: repository has been disposed; create a new one with openRepository()',
    ],
    [
      { code: 'ADAPTER_UNAVAILABLE', runtime: 'node', reason: 'process.versions missing' },
      'ADAPTER_UNAVAILABLE: adapter unavailable for runtime node: process.versions missing',
    ],
    [
      { code: 'ADAPTER_UNAVAILABLE', runtime: 'browser', reason: 'no\\x07OPFS' },
      'ADAPTER_UNAVAILABLE: adapter unavailable for runtime browser: no\\x07OPFS',
    ],
    [
      { code: 'ADAPTER_UNAVAILABLE', runtime: 'memory', reason: 'k' },
      'ADAPTER_UNAVAILABLE: adapter unavailable for runtime memory: k',
    ],
    [
      {
        code: 'WORKING_TREE_FILE_TOO_LARGE',
        path: '/repo/big.bin' as FilePath,
        size: 300,
        limit: 256,
      },
      'WORKING_TREE_FILE_TOO_LARGE: working-tree file too large: big.bin size=300 limit=256',
    ],
    [
      {
        code: 'GITIGNORE_FILE_TOO_LARGE',
        path: '/repo/.gitignore' as FilePath,
        size: 2_000_000,
        limit: 1_048_576,
      },
      'GITIGNORE_FILE_TOO_LARGE: .gitignore too large: .gitignore size=2000000 limit=1048576',
    ],
    [
      {
        code: 'SPARSE_PATTERN_FILE_TOO_LARGE',
        path: '/repo/.git/info/sparse-checkout' as FilePath,
        size: 2_000_000,
        limit: 1_048_576,
      },
      'SPARSE_PATTERN_FILE_TOO_LARGE: sparse-checkout file too large: sparse-checkout size=2000000 limit=1048576',
    ],
    [
      { code: 'HOOK_FAILED', hook: 'pre-commit', exitCode: 1, stderr: 'lint failed' },
      'HOOK_FAILED: hook pre-commit failed with exit code 1',
    ],
    [
      { code: 'CONFIG_KEY_INVALID', key: '.name', reason: 'empty-section' },
      'CONFIG_KEY_INVALID: invalid config key ".name": empty-section',
    ],
    [
      { code: 'CONFIG_KEY_INVALID', key: '1user.name', reason: 'bad-character', position: 0 },
      'CONFIG_KEY_INVALID: invalid config key "1user.name": bad-character at position 0',
    ],
    [
      { code: 'CONFIG_VALUE_INVALID', key: 'user.name', reason: 'control-character', position: 3 },
      'CONFIG_VALUE_INVALID: invalid config value for "user.name": control-character at position 3',
    ],
    [
      { code: 'CONFIG_MULTIPLE_VALUES', key: 'remote.origin.fetch', count: 2, requested: 'read' },
      'CONFIG_MULTIPLE_VALUES: config key "remote.origin.fetch" has 2 values (read requires single)',
    ],
    [
      {
        code: 'CONFIG_MULTIPLE_VALUES',
        key: 'remote.origin.fetch',
        count: 3,
        requested: 'overwrite',
        scope: 'local',
      },
      'CONFIG_MULTIPLE_VALUES: config key "remote.origin.fetch" has 3 values in scope local (overwrite requires single)',
    ],
    [
      { code: 'CONFIG_SECTION_NOT_FOUND', name: 'remote', scope: 'global' },
      'CONFIG_SECTION_NOT_FOUND: config section not found in scope global: remote',
    ],
    [
      { code: 'CONFIG_SCOPE_NOT_AVAILABLE', scope: 'global', reason: 'browser-adapter' },
      'CONFIG_SCOPE_NOT_AVAILABLE: config scope not available: global (browser-adapter)',
    ],
    [
      {
        code: 'CONFIG_SCOPE_NOT_AVAILABLE',
        scope: 'worktree',
        reason: 'worktree-extension-unset',
      },
      'CONFIG_SCOPE_NOT_AVAILABLE: config scope not available: worktree (worktree-extension-unset)',
    ],
    [
      { code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' },
      'CONFIG_SYSTEM_PATH_UNRESOLVED: config system path could not be resolved on this platform',
    ],
    [{ code: 'NO_INITIAL_COMMIT' }, 'NO_INITIAL_COMMIT: you do not have the initial commit yet'],
    [
      { code: 'STASH_NOT_FOUND', index: 2, stackSize: 1 },
      'STASH_NOT_FOUND: stash@{2} is not a valid stash reference (stack size 1)',
    ],
    [
      { code: 'STASH_APPLY_WOULD_OVERWRITE', paths: ['a' as FilePath, 'b' as FilePath] },
      'STASH_APPLY_WOULD_OVERWRITE: cannot apply stash: 2 local change(s) would be overwritten',
    ],
    [
      { code: 'CONFIG_MISSING_VALUE', key: 'user.name', source: '/repo/.git/config', line: 2 },
      "CONFIG_MISSING_VALUE: missing value for 'user.name' in file '/repo/.git/config' at line 2",
    ],
    [
      { code: 'MERGE_DRIVER_MISSING_COMMAND', name: 'x' },
      'MERGE_DRIVER_MISSING_COMMAND: custom merge driver x lacks command line.',
    ],
    [
      {
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.loosecompression',
        source: '/repo/.git/config',
        value: '',
        reason: 'invalid unit',
      },
      "CONFIG_BAD_NUMERIC_VALUE: bad numeric config value '' for 'core.loosecompression' in file /repo/.git/config: invalid unit",
    ],
    [
      {
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.loosecompression',
        source: '/repo/.git/config',
        value: '2147483648',
        reason: 'out of range',
      },
      "CONFIG_BAD_NUMERIC_VALUE: bad numeric config value '2147483648' for 'core.loosecompression' in file /repo/.git/config: out of range",
    ],
    [
      { code: 'CONFIG_BAD_ZLIB_LEVEL', level: 99 },
      'CONFIG_BAD_ZLIB_LEVEL: bad zlib compression level 99',
    ],
    [
      { code: 'CONFIG_BAD_ZLIB_LEVEL', level: -2 },
      'CONFIG_BAD_ZLIB_LEVEL: bad zlib compression level -2',
    ],
    [
      { code: 'BUNDLE_EMPTY', reason: 'no-refs' },
      'BUNDLE_EMPTY: refusing to create empty bundle: no-refs',
    ],
    [
      { code: 'BUNDLE_READ_FAILED', path: '/some/path.bundle' },
      "BUNDLE_READ_FAILED: could not open '/some/path.bundle'",
    ],
    [
      { code: 'BUNDLE_BAD_HEADER', path: '/bad.bundle', reason: 'not-a-bundle' },
      "BUNDLE_BAD_HEADER: '/bad.bundle' does not look like a v2 or v3 bundle file",
    ],
    [
      { code: 'BUNDLE_UNSUPPORTED_VERSION', version: 3, path: '/v3.bundle' },
      "BUNDLE_UNSUPPORTED_VERSION: unsupported bundle version 3 in '/v3.bundle'",
    ],
    [
      { code: 'BUNDLE_UNSUPPORTED_VERSION', version: 3 },
      'BUNDLE_UNSUPPORTED_VERSION: unsupported bundle version 3 for serialization',
    ],
    [
      {
        code: 'BUNDLE_PREREQUISITE_NOT_COMMIT',
        oid: 'a'.repeat(40),
        objectType: 'tree',
      } as unknown as CommandError,
      `BUNDLE_PREREQUISITE_NOT_COMMIT: boundary object ${'a'.repeat(40)} is not a commit (got tree)`,
    ],
  ];

  describe('Given command error %j', () => {
    describe('When TsgitError(...).message is read', () => {
      it.each(cases)('Then it equals the documented format', (data, expected) => {
        // Arrange & Act
        const sut = new TsgitError(data);

        // Assert
        expect(sut.message).toBe(expected);
      });
    });
  });

  describe('Given the bundleEmpty error helper', () => {
    describe('When called', () => {
      it.each([['no-refs'], ['no-objects']] as const)('Then data carries reason=%s', (reason) => {
        // Arrange + Act
        const sut = bundleEmpty(reason);

        // Assert
        expect(sut.data).toEqual({
          code: 'BUNDLE_EMPTY',
          reason,
        });
      });
    });
  });

  describe('Given the bundleReadFailed error helper', () => {
    describe('When called with a path', () => {
      it('Then data contains the sanitised path', () => {
        // Arrange + Assert
        expect(bundleReadFailed('/some/path.bundle').data).toEqual({
          code: 'BUNDLE_READ_FAILED',
          path: '/some/path.bundle',
        });
      });
    });
  });

  describe('Given the bundleBadHeader error helper', () => {
    describe('When called with path /bad.bundle', () => {
      it.each([['not-a-bundle'], ['malformed-header']] as const)(
        'Then data carries reason=%s',
        (reason) => {
          // Arrange + Act
          const sut = bundleBadHeader('/bad.bundle', reason);

          // Assert
          expect(sut.data).toEqual({
            code: 'BUNDLE_BAD_HEADER',
            path: '/bad.bundle',
            reason,
          });
        },
      );
    });
  });

  describe('Given the bundleUnsupportedVersion error helper', () => {
    describe('When called with path and version 3', () => {
      it('Then data contains the path and version', () => {
        // Arrange + Assert
        expect(bundleUnsupportedVersion('/v3.bundle', 3).data).toEqual({
          code: 'BUNDLE_UNSUPPORTED_VERSION',
          path: '/v3.bundle',
          version: 3,
        });
      });
    });
  });

  describe('Given the notesAlreadyExist error helper', () => {
    describe('When called with an object oid', () => {
      it('Then data contains the object oid and message contains oid', () => {
        // Arrange
        const sut = notesAlreadyExist;
        // Act
        const result = sut(OID1);
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'NOTES_ALREADY_EXIST', object: OID1 });
        expect(result.message).toBe(
          `NOTES_ALREADY_EXIST: Cannot add notes. Found existing notes for object ${OID1}. Use '-f' to overwrite existing notes`,
        );
      });
    });
  });

  describe('Given the notesObjectHasNone error helper', () => {
    describe('When called with an object oid', () => {
      it('Then data contains the object oid and message contains oid', () => {
        // Arrange
        const sut = notesObjectHasNone;
        // Act
        const result = sut(OID1);
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'NOTES_OBJECT_HAS_NONE', object: OID1 });
        expect(result.message).toContain(OID1);
      });
    });
  });

  describe('Given the notesRefOutside error helper', () => {
    describe('When called with a ref outside refs/notes/', () => {
      it('Then data carries the raw ref and the message names it', () => {
        // Arrange
        const sut = notesRefOutside;
        // Act
        const result = sut('refs/heads/main');
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'NOTES_REF_OUTSIDE', ref: 'refs/heads/main' });
        expect(result.message).toContain('refs/heads/main');
      });
    });
  });

  describe('Given the signingFailed error helper', () => {
    describe('When called with reason "signer-failed" and a format', () => {
      it('Then data carries code, reason and format; message names both', () => {
        // Arrange
        const sut = signingFailed;
        // Act
        const result = sut('signer-failed', 'openpgp');
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'signer-failed',
          format: 'openpgp',
        });
        expect(result.message).toContain('signer-failed');
        expect(result.message).toContain('openpgp');
      });
    });

    describe('When called with reason "off-node" and no format', () => {
      it('Then data carries only code and reason — no format key', () => {
        // Arrange
        const sut = signingFailed;
        // Act
        const result = sut('off-node');
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'SIGNING_FAILED', reason: 'off-node' });
        expect(result.message).toContain('off-node');
      });
    });

    describe('When called with reason "unsupported-format" and format "x509"', () => {
      it('Then data carries reason "unsupported-format" and format "x509"', () => {
        // Arrange
        const sut = signingFailed;
        // Act
        const result = sut('unsupported-format', 'x509');
        // Assert
        expect(result.data).toEqual({
          code: 'SIGNING_FAILED',
          reason: 'unsupported-format',
          format: 'x509',
        });
      });
    });
  });

  describe('Given the signedPushUnsupported error helper', () => {
    describe('When called with a remote name', () => {
      it('Then data carries code and remote', () => {
        // Arrange
        const sut = signedPushUnsupported;
        // Act
        const result = sut('origin');
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'SIGNED_PUSH_UNSUPPORTED', remote: 'origin' });
      });
    });
  });

  describe('Given the pushDetachedNoRefspec error helper', () => {
    describe('When called', () => {
      it('Then data carries the code', () => {
        // Arrange
        const sut = pushDetachedNoRefspec;
        // Act
        const result = sut();
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'PUSH_DETACHED_NO_REFSPEC' });
      });
    });
  });

  describe('Given the pushDefaultNothing error helper', () => {
    describe('When called', () => {
      it('Then data carries the code', () => {
        // Arrange
        const sut = pushDefaultNothing;
        // Act
        const result = sut();
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'PUSH_DEFAULT_NOTHING' });
      });
    });
  });

  describe('Given the pushRemoteNotUpstream error helper', () => {
    describe('When called with a remote name and the current branch ref', () => {
      it('Then data carries code, remote, and branch', () => {
        // Arrange
        const sut = pushRemoteNotUpstream;
        // Act
        const result = sut('pushdef', 'refs/heads/main' as RefName);
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({
          code: 'PUSH_REMOTE_NOT_UPSTREAM',
          remote: 'pushdef',
          branch: 'refs/heads/main',
        });
      });
    });
  });

  describe('Given the pushUpstreamNameMismatch error helper', () => {
    describe('When called with the current branch ref and its differently-named upstream', () => {
      it('Then data carries code, branch, and upstream', () => {
        // Arrange
        const sut = pushUpstreamNameMismatch;
        // Act
        const result = sut('refs/heads/main' as RefName, 'refs/heads/other' as RefName);
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({
          code: 'PUSH_UPSTREAM_NAME_MISMATCH',
          branch: 'refs/heads/main',
          upstream: 'refs/heads/other',
        });
      });
    });
  });

  describe('Given the invalidPushDefault error helper', () => {
    describe('When called with a bad value, its source, and its line', () => {
      it('Then data carries code, value, source, and line', () => {
        // Arrange
        const sut = invalidPushDefault;
        // Act
        const result = sut('bogus', '/abs/.git/config', 9);
        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({
          code: 'INVALID_PUSH_DEFAULT',
          value: 'bogus',
          source: '/abs/.git/config',
          line: 9,
        });
      });
    });
  });
});
