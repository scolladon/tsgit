import { describe, expect, it } from 'vitest';

import {
  authorUnconfigured,
  blockedHost,
  branchExists,
  branchNotFound,
  type CommandError,
  cannotDeleteCheckedOutBranch,
  checkoutOverwriteDirty,
  emptyCommitMessage,
  emptyPathspec,
  invalidUrl,
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
  revparseAmbiguous,
  revparseUnresolved,
  sanitize,
  tagExists,
  tagNotFound,
  targetDirectoryNotEmpty,
  tooManyRedirects,
  unsupportedScheme,
  workingTreeDirty,
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

  it('mergeHasConflicts', () => {
    expect(mergeHasConflicts(3).data).toEqual({ code: 'MERGE_HAS_CONFLICTS', count: 3 });
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
      { code: 'MERGE_HAS_CONFLICTS', count: 3 },
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
