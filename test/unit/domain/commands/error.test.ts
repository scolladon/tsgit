import { describe, expect, it } from 'vitest';

import {
  adapterUnavailable,
  authorUnconfigured,
  blockedHost,
  branchExists,
  branchNotFound,
  type CommandError,
  cannotDeleteCheckedOutBranch,
  checkoutOverwriteDirty,
  emptyCommitMessage,
  emptyPathspec,
  gitignoreFileTooLarge,
  hookFailed,
  invalidOption,
  invalidUrl,
  MAX_HOOK_STDERR_IN_ERROR,
  maxRefspecsExceeded,
  mergeHasConflicts,
  nonFastForward,
  nothingToCommit,
  operationInProgress,
  pathspecNoMatch,
  pathspecOutsideRepo,
  pushRejected,
  remoteAdvertisesNoRefs,
  remoteNotConfigured,
  repositoryDisposed,
  revparseAmbiguous,
  revparseUnresolved,
  sanitize,
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
  it('workingTreeDirty', () => {
    expect(workingTreeDirty(['a' as FilePath]).data).toEqual({
      code: 'WORKING_TREE_DIRTY',
      paths: ['a'],
    });
  });

  it('pathspecNoMatch', () => {
    expect(pathspecNoMatch('*.zzz').data).toEqual({
      code: 'PATHSPEC_NO_MATCH',
      pattern: '*.zzz',
    });
  });

  it('pathspecOutsideRepo', () => {
    expect(pathspecOutsideRepo('/etc/passwd' as FilePath).data).toEqual({
      code: 'PATHSPEC_OUTSIDE_REPO',
      path: '/etc/passwd',
    });
  });

  it('nothingToCommit', () => {
    expect(nothingToCommit().data).toEqual({ code: 'NOTHING_TO_COMMIT' });
  });

  it('emptyCommitMessage', () => {
    expect(emptyCommitMessage().data).toEqual({ code: 'EMPTY_COMMIT_MESSAGE' });
  });

  it('authorUnconfigured', () => {
    expect(authorUnconfigured().data).toEqual({ code: 'AUTHOR_UNCONFIGURED' });
  });

  it('branchExists', () => {
    expect(branchExists('refs/heads/x' as RefName).data).toEqual({
      code: 'BRANCH_EXISTS',
      name: 'refs/heads/x',
    });
  });

  it('branchNotFound', () => {
    expect(branchNotFound('refs/heads/x' as RefName).data).toEqual({
      code: 'BRANCH_NOT_FOUND',
      name: 'refs/heads/x',
    });
  });

  it('tagExists', () => {
    expect(tagExists('refs/tags/v1' as RefName).data).toEqual({
      code: 'TAG_EXISTS',
      name: 'refs/tags/v1',
    });
  });

  it('tagNotFound', () => {
    expect(tagNotFound('refs/tags/v1' as RefName).data).toEqual({
      code: 'TAG_NOT_FOUND',
      name: 'refs/tags/v1',
    });
  });

  it('cannotDeleteCheckedOutBranch', () => {
    expect(cannotDeleteCheckedOutBranch('refs/heads/main' as RefName).data).toEqual({
      code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH',
      name: 'refs/heads/main',
    });
  });

  it('invalidUrl', () => {
    expect(invalidUrl('bad').data).toEqual({ code: 'INVALID_URL', reason: 'bad' });
  });

  it('blockedHost', () => {
    expect(blockedHost('1.2.3.4', 'private').data).toEqual({
      code: 'BLOCKED_HOST',
      host: '1.2.3.4',
      reason: 'private',
    });
  });

  it('tooManyRedirects', () => {
    expect(tooManyRedirects(6).data).toEqual({ code: 'TOO_MANY_REDIRECTS', count: 6 });
  });

  it('unsupportedScheme', () => {
    expect(unsupportedScheme('ftp').data).toEqual({
      code: 'UNSUPPORTED_SCHEME',
      scheme: 'ftp',
    });
  });

  it('targetDirectoryNotEmpty', () => {
    expect(targetDirectoryNotEmpty('/repo' as FilePath).data).toEqual({
      code: 'TARGET_DIRECTORY_NOT_EMPTY',
      path: '/repo',
    });
  });

  it('remoteAdvertisesNoRefs', () => {
    expect(remoteAdvertisesNoRefs().data).toEqual({ code: 'REMOTE_ADVERTISES_NO_REFS' });
  });

  it('nonFastForward', () => {
    expect(nonFastForward('refs/heads/main' as RefName, OID1, OID2).data).toEqual({
      code: 'NON_FAST_FORWARD',
      ref: 'refs/heads/main',
      local: OID1,
      remote: OID2,
    });
  });

  it('pushRejected', () => {
    expect(pushRejected('refs/heads/main' as RefName, 'declined', dummyReportStatus).data).toEqual({
      code: 'PUSH_REJECTED',
      ref: 'refs/heads/main',
      reason: 'declined',
      reportStatus: dummyReportStatus,
    });
  });

  it('mergeHasConflicts (default paths)', () => {
    expect(mergeHasConflicts(3).data).toEqual({
      code: 'MERGE_HAS_CONFLICTS',
      count: 3,
      paths: [],
    });
  });

  it('mergeHasConflicts (explicit paths)', () => {
    expect(mergeHasConflicts(2, ['a.txt' as FilePath, 'b.txt' as FilePath]).data).toEqual({
      code: 'MERGE_HAS_CONFLICTS',
      count: 2,
      paths: ['a.txt', 'b.txt'],
    });
  });

  it('mergeHasConflicts truncates the paths array when over the cap', () => {
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

  it('mergeHasConflicts does NOT set truncated when paths fit under the cap', () => {
    // Arrange
    const paths = Array.from({ length: 5 }, (_, i) => `f${i}.txt` as FilePath);

    // Act
    const err = mergeHasConflicts(5, paths);
    const data = err.data as { readonly truncated?: boolean };

    // Assert — truncated field absent (not just false) when no elision happened.
    expect(data.truncated).toBeUndefined();
  });

  it('mergeHasConflicts keeps all paths and omits truncated at exactly the cap', () => {
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

  it('checkoutOverwriteDirty', () => {
    expect(checkoutOverwriteDirty(['a' as FilePath]).data).toEqual({
      code: 'CHECKOUT_OVERWRITE_DIRTY',
      paths: ['a'],
    });
  });

  it('revparseAmbiguous', () => {
    expect(revparseAmbiguous('abc1', [OID1, OID2]).data).toEqual({
      code: 'REVPARSE_AMBIGUOUS',
      expression: 'abc1',
      candidates: [OID1, OID2],
    });
  });

  it('revparseUnresolved', () => {
    expect(revparseUnresolved('foo').data).toEqual({
      code: 'REVPARSE_UNRESOLVED',
      expression: 'foo',
    });
  });

  it('emptyPathspec', () => {
    expect(emptyPathspec().data).toEqual({ code: 'EMPTY_PATHSPEC' });
  });

  it('operationInProgress', () => {
    expect(operationInProgress('merge').data).toEqual({
      code: 'OPERATION_IN_PROGRESS',
      operation: 'merge',
    });
  });

  it('maxRefspecsExceeded', () => {
    expect(maxRefspecsExceeded(2000, 1024).data).toEqual({
      code: 'MAX_REFSPECS_EXCEEDED',
      count: 2000,
      limit: 1024,
    });
  });

  it('remoteNotConfigured', () => {
    expect(remoteNotConfigured('upstream').data).toEqual({
      code: 'REMOTE_NOT_CONFIGURED',
      remote: 'upstream',
    });
  });

  it('Given a printable reason, When invalidOption, Then data carries the verbatim option name and sanitized reason', () => {
    expect(invalidOption('cwd', 'must be absolute').data).toEqual({
      code: 'INVALID_OPTION',
      option: 'cwd',
      reason: 'must be absolute',
    });
  });

  it('Given a reason with a CR byte, When invalidOption, Then reason is sanitized via \\xNN', () => {
    expect(invalidOption('cwd', 'bad\rvalue').data).toEqual({
      code: 'INVALID_OPTION',
      option: 'cwd',
      reason: 'bad\\x0Dvalue',
    });
  });

  it('Given no arguments, When repositoryDisposed, Then data has only the code', () => {
    expect(repositoryDisposed().data).toEqual({ code: 'REPOSITORY_DISPOSED' });
  });

  it('Given a path, size, and limit, When workingTreeFileTooLarge, Then data carries every field verbatim', () => {
    expect(workingTreeFileTooLarge('big.bin' as FilePath, 300, 256).data).toEqual({
      code: 'WORKING_TREE_FILE_TOO_LARGE',
      path: 'big.bin',
      size: 300,
      limit: 256,
    });
  });

  it('Given a path, size, and limit, When gitignoreFileTooLarge, Then data carries every field verbatim', () => {
    expect(gitignoreFileTooLarge('.gitignore' as FilePath, 2_000_000, 1_048_576).data).toEqual({
      code: 'GITIGNORE_FILE_TOO_LARGE',
      path: '.gitignore',
      size: 2_000_000,
      limit: 1_048_576,
    });
  });

  it('Given runtime and reason, When adapterUnavailable, Then data carries verbatim runtime and sanitized reason', () => {
    expect(adapterUnavailable('node', 'process.versions missing').data).toEqual({
      code: 'ADAPTER_UNAVAILABLE',
      runtime: 'node',
      reason: 'process.versions missing',
    });
  });

  it('Given a reason with a control byte, When adapterUnavailable, Then reason is sanitized', () => {
    expect(adapterUnavailable('browser', 'no\x07OPFS').data).toEqual({
      code: 'ADAPTER_UNAVAILABLE',
      runtime: 'browser',
      reason: 'no\\x07OPFS',
    });
  });

  it('Given a hook, exit code, and stderr, When hookFailed, Then data carries every field verbatim', () => {
    expect(hookFailed('pre-commit', 1, 'lint failed').data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'pre-commit',
      exitCode: 1,
      stderr: 'lint failed',
    });
  });

  it('Given stderr with a CR byte, When hookFailed, Then stderr is sanitized via \\xNN', () => {
    expect(hookFailed('commit-msg', 2, 'bad\rmsg').data).toEqual({
      code: 'HOOK_FAILED',
      hook: 'commit-msg',
      exitCode: 2,
      stderr: 'bad\\x0Dmsg',
    });
  });

  it('Given stderr one byte over the cap, When hookFailed, Then stderr is truncated to the cap', () => {
    // Arrange — printable bytes so sanitization is length-stable; one past the cap.
    const oversized = 'x'.repeat(MAX_HOOK_STDERR_IN_ERROR + 1);

    // Act
    const data = hookFailed('pre-push', 1, oversized).data as { readonly stderr: string };

    // Assert
    expect(data.stderr).toHaveLength(MAX_HOOK_STDERR_IN_ERROR);
  });
});

describe('sanitize helper', () => {
  it('Given printable ASCII, When sanitize, Then returns input unchanged', () => {
    expect(sanitize('hello world 123')).toBe('hello world 123');
  });

  it('Given a tab and newline, When sanitize, Then preserves them verbatim', () => {
    expect(sanitize('a\tb\nc')).toBe('a\tb\nc');
  });

  it('Given CR and other control bytes, When sanitize, Then escapes them as \\xNN', () => {
    expect(sanitize('a\rb')).toBe('a\\x0Db');
  });

  it('Given a NUL byte, When sanitize, Then escapes as \\x00', () => {
    expect(sanitize('a\0b')).toBe('a\\x00b');
  });

  it('Given a high-byte non-ASCII character, When sanitize, Then escapes', () => {
    expect(sanitize('ab')).toBe('a\\x80b');
  });

  it('Given a tilde (0x7e, the printable-range upper bound), When sanitize, Then keeps it verbatim', () => {
    // 0x7e is the inclusive upper bound of the printable ASCII range; it must
    // be preserved, not escaped.
    expect(sanitize('a~b')).toBe('a~b');
  });

  it('Given DEL (0x7f, just past the printable upper bound), When sanitize, Then escapes it', () => {
    expect(sanitize('ab')).toBe('a\\x7Fb');
  });
});

describe('domain commands error — extractDetail message formatting', () => {
  type Case = readonly [CommandError, string];
  const cases: ReadonlyArray<Case> = [
    [
      { code: 'WORKING_TREE_DIRTY', paths: ['a' as FilePath, 'b' as FilePath] },
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
      { code: 'CHECKOUT_OVERWRITE_DIRTY', paths: ['a' as FilePath] },
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
      { code: 'MAX_REFSPECS_EXCEEDED', count: 2000, limit: 1024 },
      'MAX_REFSPECS_EXCEEDED: 2000 refspecs exceeds limit 1024',
    ],
    [
      { code: 'REMOTE_NOT_CONFIGURED', remote: 'upstream' },
      'REMOTE_NOT_CONFIGURED: remote not configured: upstream',
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
      { code: 'HOOK_FAILED', hook: 'pre-commit', exitCode: 1, stderr: 'lint failed' },
      'HOOK_FAILED: hook pre-commit failed with exit code 1',
    ],
  ];

  it.each(
    cases,
  )('Given command error %j, When TsgitError(...).message is read, Then it equals the documented format', (data, expected) => {
    // Arrange & Act
    const sut = new TsgitError(data);

    // Assert
    expect(sut.message).toBe(expected);
  });
});
