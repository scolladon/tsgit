import { TsgitError } from '../error.js';
import type { HookName } from '../hooks/index.js';
import type { FilePath, ObjectId, RefName } from '../objects/object-id.js';
import type { ReceivePackResponse as ReportStatus } from '../protocol/receive-pack.js';
import type { ConfigScope } from './config-key.js';

export type CommandError =
  | { readonly code: 'WORKING_TREE_DIRTY'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'PATHSPEC_NO_MATCH'; readonly pattern: string }
  | { readonly code: 'PATHSPEC_OUTSIDE_REPO'; readonly path: FilePath }
  | { readonly code: 'NOTHING_TO_COMMIT' }
  | { readonly code: 'EMPTY_COMMIT_MESSAGE' }
  | { readonly code: 'AUTHOR_UNCONFIGURED' }
  | { readonly code: 'BRANCH_EXISTS'; readonly name: RefName }
  | { readonly code: 'BRANCH_NOT_FOUND'; readonly name: RefName }
  | { readonly code: 'TAG_EXISTS'; readonly name: RefName }
  | { readonly code: 'TAG_NOT_FOUND'; readonly name: RefName }
  | { readonly code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH'; readonly name: RefName }
  | { readonly code: 'INVALID_URL'; readonly reason: string }
  | { readonly code: 'BLOCKED_HOST'; readonly host: string; readonly reason: string }
  | { readonly code: 'TOO_MANY_REDIRECTS'; readonly count: number }
  | { readonly code: 'UNSUPPORTED_SCHEME'; readonly scheme: string }
  | { readonly code: 'TARGET_DIRECTORY_NOT_EMPTY'; readonly path: FilePath }
  | { readonly code: 'REMOTE_ADVERTISES_NO_REFS' }
  | { readonly code: 'NO_PROMISOR_REMOTE' }
  | {
      readonly code: 'NON_FAST_FORWARD';
      readonly ref: RefName;
      readonly local: ObjectId;
      readonly remote: ObjectId;
    }
  | {
      readonly code: 'PUSH_REJECTED';
      readonly ref: RefName;
      readonly reason: string;
      readonly reportStatus: ReportStatus;
    }
  | {
      readonly code: 'MERGE_HAS_CONFLICTS';
      readonly count: number;
      readonly paths: ReadonlyArray<FilePath>;
      readonly truncated?: boolean;
    }
  | { readonly code: 'CHECKOUT_OVERWRITE_DIRTY'; readonly paths: ReadonlyArray<FilePath> }
  | {
      readonly code: 'REVPARSE_AMBIGUOUS';
      readonly expression: string;
      readonly candidates: ReadonlyArray<ObjectId>;
    }
  | { readonly code: 'REVPARSE_UNRESOLVED'; readonly expression: string }
  | { readonly code: 'PATH_NOT_IN_TREE'; readonly rev: string; readonly path: string }
  | { readonly code: 'EMPTY_PATHSPEC' }
  | {
      readonly code: 'OPERATION_IN_PROGRESS';
      readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
    }
  | {
      readonly code: 'NO_OPERATION_IN_PROGRESS';
      readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
    }
  | { readonly code: 'MAX_REFSPECS_EXCEEDED'; readonly count: number; readonly limit: number }
  | { readonly code: 'REMOTE_NOT_CONFIGURED'; readonly remote: string }
  | { readonly code: 'NO_UPSTREAM_CONFIGURED'; readonly branch: RefName }
  | { readonly code: 'REMOTE_EXISTS'; readonly remote: string }
  | { readonly code: 'REMOTE_NAME_INVALID'; readonly name: string; readonly reason: string }
  | { readonly code: 'INVALID_OPTION'; readonly option: string; readonly reason: string }
  | { readonly code: 'REPOSITORY_DISPOSED' }
  | {
      readonly code: 'ADAPTER_UNAVAILABLE';
      readonly runtime: 'node' | 'browser' | 'memory';
      readonly reason: string;
    }
  | {
      readonly code: 'WORKING_TREE_FILE_TOO_LARGE';
      readonly path: FilePath;
      readonly size: number;
      readonly limit: number;
    }
  | {
      readonly code: 'GITIGNORE_FILE_TOO_LARGE';
      readonly path: FilePath;
      readonly size: number;
      readonly limit: number;
    }
  | {
      readonly code: 'SPARSE_PATTERN_FILE_TOO_LARGE';
      readonly path: FilePath;
      readonly size: number;
      readonly limit: number;
    }
  | {
      readonly code: 'HOOK_FAILED';
      readonly hook: HookName;
      readonly exitCode: number;
      readonly stderr: string;
    }
  | {
      readonly code: 'CONFIG_KEY_INVALID';
      readonly key: string;
      readonly reason: 'empty-section' | 'missing-name' | 'bad-character';
      readonly position?: number;
    }
  | {
      readonly code: 'CONFIG_VALUE_INVALID';
      readonly key: string;
      readonly reason: 'control-character';
      readonly position: number;
    }
  | {
      readonly code: 'CONFIG_MULTIPLE_VALUES';
      readonly key: string;
      readonly count: number;
      readonly requested: 'read' | 'overwrite' | 'remove';
      readonly scope?: ConfigScope;
    }
  | {
      readonly code: 'CONFIG_SECTION_NOT_FOUND';
      readonly name: string;
      readonly scope: ConfigScope;
    }
  | {
      readonly code: 'CONFIG_SCOPE_NOT_AVAILABLE';
      readonly scope: ConfigScope;
      readonly reason: 'browser-adapter' | 'worktree-extension-unset';
    }
  | { readonly code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' }
  | {
      readonly code: 'MV_SOURCE_NOT_TRACKED';
      readonly source: FilePath;
      readonly destination: FilePath;
    }
  | { readonly code: 'MV_BAD_SOURCE'; readonly source: FilePath; readonly destination: FilePath }
  | {
      readonly code: 'MV_DESTINATION_EXISTS';
      readonly source: FilePath;
      readonly destination: FilePath;
    }
  | { readonly code: 'MV_INTO_SELF'; readonly source: FilePath; readonly destination: FilePath }
  | {
      readonly code: 'MV_DESTINATION_NOT_DIRECTORY';
      readonly source: FilePath;
      readonly destination: FilePath;
    }
  | {
      readonly code: 'MV_DESTINATION_DIRECTORY_MISSING';
      readonly source: FilePath;
      readonly destination: FilePath;
    }
  | {
      readonly code: 'MV_MULTIPLE_SOURCES_SAME_TARGET';
      readonly source: FilePath;
      readonly destination: FilePath;
    }
  | {
      readonly code: 'MV_OVERLAPPING_SOURCES';
      readonly child: FilePath;
      readonly parent: FilePath;
    }
  | { readonly code: 'RM_STAGED_CHANGES'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'RM_LOCAL_MODIFICATIONS'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'RM_STAGED_AND_LOCAL_CHANGES'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'NO_INITIAL_COMMIT' }
  | { readonly code: 'STASH_NOT_FOUND'; readonly index: number; readonly stackSize: number }
  | { readonly code: 'STASH_APPLY_WOULD_OVERWRITE'; readonly paths: ReadonlyArray<FilePath> }
  | {
      readonly code: 'AMBIGUOUS_OID_PREFIX';
      readonly prefix: string;
      readonly candidates: ReadonlyArray<ObjectId>;
    }
  | { readonly code: 'INVALID_SEQUENCER_TODO'; readonly reason: string }
  | { readonly code: 'CHERRY_PICK_MERGE_NO_MAINLINE'; readonly commit: ObjectId }
  | { readonly code: 'REVERT_MERGE_NO_MAINLINE'; readonly commit: ObjectId };

const sanitizeForDisplay = (s: string): string => {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code <= 0x7e)) {
      out += s[i];
    } else {
      out += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
};

export const sanitize = sanitizeForDisplay;

export const workingTreeDirty = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'WORKING_TREE_DIRTY', paths });

export const pathspecNoMatch = (pattern: string): TsgitError =>
  new TsgitError({ code: 'PATHSPEC_NO_MATCH', pattern });

export const pathspecOutsideRepo = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'PATHSPEC_OUTSIDE_REPO', path });

export const nothingToCommit = (): TsgitError => new TsgitError({ code: 'NOTHING_TO_COMMIT' });

export const emptyCommitMessage = (): TsgitError =>
  new TsgitError({ code: 'EMPTY_COMMIT_MESSAGE' });

export const authorUnconfigured = (): TsgitError => new TsgitError({ code: 'AUTHOR_UNCONFIGURED' });

export const branchExists = (name: RefName): TsgitError =>
  new TsgitError({ code: 'BRANCH_EXISTS', name });

export const branchNotFound = (name: RefName): TsgitError =>
  new TsgitError({ code: 'BRANCH_NOT_FOUND', name });

export const tagExists = (name: RefName): TsgitError =>
  new TsgitError({ code: 'TAG_EXISTS', name });

export const tagNotFound = (name: RefName): TsgitError =>
  new TsgitError({ code: 'TAG_NOT_FOUND', name });

export const cannotDeleteCheckedOutBranch = (name: RefName): TsgitError =>
  new TsgitError({ code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH', name });

export const invalidUrl = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_URL', reason });

export const blockedHost = (host: string, reason: string): TsgitError =>
  new TsgitError({
    code: 'BLOCKED_HOST',
    host: sanitizeForDisplay(host),
    reason: sanitizeForDisplay(reason),
  });

export const tooManyRedirects = (count: number): TsgitError =>
  new TsgitError({ code: 'TOO_MANY_REDIRECTS', count });

export const unsupportedScheme = (scheme: string): TsgitError =>
  new TsgitError({ code: 'UNSUPPORTED_SCHEME', scheme });

export const targetDirectoryNotEmpty = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'TARGET_DIRECTORY_NOT_EMPTY', path });

export const remoteAdvertisesNoRefs = (): TsgitError =>
  new TsgitError({ code: 'REMOTE_ADVERTISES_NO_REFS' });

export const noPromisorRemote = (): TsgitError => new TsgitError({ code: 'NO_PROMISOR_REMOTE' });

export const nonFastForward = (ref: RefName, local: ObjectId, remote: ObjectId): TsgitError =>
  new TsgitError({ code: 'NON_FAST_FORWARD', ref, local, remote });

export const pushRejected = (
  ref: RefName,
  reason: string,
  reportStatus: ReportStatus,
): TsgitError => new TsgitError({ code: 'PUSH_REJECTED', ref, reason, reportStatus });

/**
 * Cap the number of paths embedded in `MERGE_HAS_CONFLICTS.data.paths`.
 * `mergeTrees` bounds the union of paths at `MAX_FLAT_TREE_ENTRIES`
 * (1,000,000), so an uncapped error payload could allocate tens of
 * megabytes inside a thrown error — amplified when callers log or
 * serialise the error. We truncate to the first N paths and set
 * `truncated: true` so observers can detect the elision.
 */
export const MAX_CONFLICT_PATHS_IN_ERROR = 100;

export const mergeHasConflicts = (
  count: number,
  paths: ReadonlyArray<FilePath> = [],
): TsgitError => {
  const truncated = paths.length > MAX_CONFLICT_PATHS_IN_ERROR;
  const cappedPaths = truncated ? paths.slice(0, MAX_CONFLICT_PATHS_IN_ERROR) : paths;
  return new TsgitError(
    truncated
      ? { code: 'MERGE_HAS_CONFLICTS', count, paths: cappedPaths, truncated: true }
      : { code: 'MERGE_HAS_CONFLICTS', count, paths: cappedPaths },
  );
};

export const checkoutOverwriteDirty = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'CHECKOUT_OVERWRITE_DIRTY', paths });

export const revparseAmbiguous = (
  expression: string,
  candidates: ReadonlyArray<ObjectId>,
): TsgitError => new TsgitError({ code: 'REVPARSE_AMBIGUOUS', expression, candidates });

export const revparseUnresolved = (expression: string): TsgitError =>
  new TsgitError({ code: 'REVPARSE_UNRESOLVED', expression });

export const pathNotInTree = (rev: string, path: string): TsgitError =>
  new TsgitError({
    code: 'PATH_NOT_IN_TREE',
    rev: sanitizeForDisplay(rev),
    path: sanitizeForDisplay(path),
  });

export const emptyPathspec = (): TsgitError => new TsgitError({ code: 'EMPTY_PATHSPEC' });

export const operationInProgress = (
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert',
): TsgitError => new TsgitError({ code: 'OPERATION_IN_PROGRESS', operation });

export const noOperationInProgress = (
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert',
): TsgitError => new TsgitError({ code: 'NO_OPERATION_IN_PROGRESS', operation });

export const maxRefspecsExceeded = (count: number, limit: number): TsgitError =>
  new TsgitError({ code: 'MAX_REFSPECS_EXCEEDED', count, limit });

export const remoteNotConfigured = (remote: string): TsgitError =>
  new TsgitError({ code: 'REMOTE_NOT_CONFIGURED', remote });

export const noUpstreamConfigured = (branch: RefName): TsgitError =>
  new TsgitError({ code: 'NO_UPSTREAM_CONFIGURED', branch });

export const remoteExists = (remote: string): TsgitError =>
  new TsgitError({ code: 'REMOTE_EXISTS', remote });

export const remoteNameInvalid = (name: string, reason: string): TsgitError =>
  new TsgitError({
    code: 'REMOTE_NAME_INVALID',
    name: sanitizeForDisplay(name),
    reason: sanitizeForDisplay(reason),
  });

export const invalidOption = (option: string, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OPTION', option, reason: sanitizeForDisplay(reason) });

export const repositoryDisposed = (): TsgitError => new TsgitError({ code: 'REPOSITORY_DISPOSED' });

export const adapterUnavailable = (
  runtime: 'node' | 'browser' | 'memory',
  reason: string,
): TsgitError =>
  new TsgitError({
    code: 'ADAPTER_UNAVAILABLE',
    runtime,
    reason: sanitizeForDisplay(reason),
  });

export const workingTreeFileTooLarge = (path: FilePath, size: number, limit: number): TsgitError =>
  new TsgitError({ code: 'WORKING_TREE_FILE_TOO_LARGE', path, size, limit });

export const gitignoreFileTooLarge = (path: FilePath, size: number, limit: number): TsgitError =>
  new TsgitError({ code: 'GITIGNORE_FILE_TOO_LARGE', path, size, limit });

export const sparsePatternFileTooLarge = (
  path: FilePath,
  size: number,
  limit: number,
): TsgitError => new TsgitError({ code: 'SPARSE_PATTERN_FILE_TOO_LARGE', path, size, limit });

/**
 * Cap on the sanitised `stderr` snippet embedded in a `HOOK_FAILED` error,
 * measured in characters of the post-sanitisation string. A hook can emit
 * megabytes; an unbounded string inside a thrown error is an amplification
 * vector when callers log or serialise it.
 */
export const MAX_HOOK_STDERR_IN_ERROR = 4096;

export const hookFailed = (hook: HookName, exitCode: number, stderr: string): TsgitError =>
  new TsgitError({
    code: 'HOOK_FAILED',
    hook,
    exitCode,
    stderr: sanitizeForDisplay(stderr).slice(0, MAX_HOOK_STDERR_IN_ERROR),
  });

export const configKeyInvalid = (
  key: string,
  reason: 'empty-section' | 'missing-name' | 'bad-character',
  position?: number,
): TsgitError =>
  new TsgitError(
    position === undefined
      ? { code: 'CONFIG_KEY_INVALID', key: sanitizeForDisplay(key), reason }
      : { code: 'CONFIG_KEY_INVALID', key: sanitizeForDisplay(key), reason, position },
  );

export const configValueInvalid = (key: string, position: number): TsgitError =>
  new TsgitError({
    code: 'CONFIG_VALUE_INVALID',
    key: sanitizeForDisplay(key),
    reason: 'control-character',
    position,
  });

export const configMultipleValues = (
  key: string,
  count: number,
  requested: 'read' | 'overwrite' | 'remove',
  scope?: ConfigScope,
): TsgitError =>
  new TsgitError(
    scope === undefined
      ? { code: 'CONFIG_MULTIPLE_VALUES', key: sanitizeForDisplay(key), count, requested }
      : { code: 'CONFIG_MULTIPLE_VALUES', key: sanitizeForDisplay(key), count, requested, scope },
  );

export const configSectionNotFound = (name: string, scope: ConfigScope): TsgitError =>
  new TsgitError({
    code: 'CONFIG_SECTION_NOT_FOUND',
    name: sanitizeForDisplay(name),
    scope,
  });

export const configScopeNotAvailable = (
  scope: ConfigScope,
  reason: 'browser-adapter' | 'worktree-extension-unset',
): TsgitError => new TsgitError({ code: 'CONFIG_SCOPE_NOT_AVAILABLE', scope, reason });

export const configSystemPathUnresolved = (): TsgitError =>
  new TsgitError({ code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' });

// `mv` refusal factories. `source`/`destination` are already
// `validateWorkingTreePath`-checked (no control chars, no traversal) before any
// of these is constructed, so they are embedded verbatim — matching git, which
// prints the full relative paths in `source=…, destination=…`.
export const mvSourceNotTracked = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_SOURCE_NOT_TRACKED', source, destination });

export const mvBadSource = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_BAD_SOURCE', source, destination });

export const mvDestinationExists = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_DESTINATION_EXISTS', source, destination });

export const mvIntoSelf = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_INTO_SELF', source, destination });

export const mvDestinationNotDirectory = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_DESTINATION_NOT_DIRECTORY', source, destination });

export const mvDestinationDirectoryMissing = (
  source: FilePath,
  destination: FilePath,
): TsgitError => new TsgitError({ code: 'MV_DESTINATION_DIRECTORY_MISSING', source, destination });

export const mvMultipleSourcesSameTarget = (source: FilePath, destination: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_MULTIPLE_SOURCES_SAME_TARGET', source, destination });

export const mvOverlappingSources = (child: FilePath, parent: FilePath): TsgitError =>
  new TsgitError({ code: 'MV_OVERLAPPING_SOURCES', child, parent });

// `rm` safety-valve refusals (faithful to `git rm`'s `check_local_mod`). `paths`
// are already pathspec-validated index paths, embedded verbatim. The override per
// category: `RM_STAGED_CHANGES` / `RM_LOCAL_MODIFICATIONS` accept `--cached` or
// `-f`; `RM_STAGED_AND_LOCAL_CHANGES` accepts only `-f`.
export const rmStagedChanges = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'RM_STAGED_CHANGES', paths });

export const rmLocalModifications = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'RM_LOCAL_MODIFICATIONS', paths });

export const rmStagedAndLocalChanges = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'RM_STAGED_AND_LOCAL_CHANGES', paths });

// `stash` errors. `NO_INITIAL_COMMIT` mirrors git's refusal to stash on an
// unborn branch; `STASH_NOT_FOUND` carries the selector index + stack size so
// callers can render `stash@{index}`; `STASH_APPLY_WOULD_OVERWRITE` mirrors
// git's pre-merge "local changes would be overwritten" abort. `paths` are
// pathspec-validated index paths, embedded verbatim like `rm`/`mv`.
export const noInitialCommit = (): TsgitError => new TsgitError({ code: 'NO_INITIAL_COMMIT' });

export const stashNotFound = (index: number, stackSize: number): TsgitError =>
  new TsgitError({ code: 'STASH_NOT_FOUND', index, stackSize });

export const stashApplyWouldOverwrite = (paths: ReadonlyArray<FilePath>): TsgitError =>
  new TsgitError({ code: 'STASH_APPLY_WOULD_OVERWRITE', paths });

// Abbreviated-oid resolution. `candidates` is capped by the caller so a hostile
// near-collision cannot inflate the thrown error payload; `prefix` is the
// validated 4–39-hex query, embedded verbatim.
export const ambiguousOidPrefix = (
  prefix: string,
  candidates: ReadonlyArray<ObjectId>,
): TsgitError => new TsgitError({ code: 'AMBIGUOUS_OID_PREFIX', prefix, candidates });

// Corrupt `.git/sequencer/todo` line. `reason` embeds the offending line
// (sanitised — a mid-write crash can leave control bytes behind).
export const invalidSequencerTodo = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_SEQUENCER_TODO', reason: sanitizeForDisplay(reason) });

// Picking a merge commit with no chosen mainline (`-m`). `commit` is a validated
// 40-hex oid, embedded verbatim.
export const cherryPickMergeNoMainline = (commit: ObjectId): TsgitError =>
  new TsgitError({ code: 'CHERRY_PICK_MERGE_NO_MAINLINE', commit });

// Reverting a merge commit with no chosen mainline (`-m`). `commit` is a
// validated 40-hex oid, embedded verbatim.
export const revertMergeNoMainline = (commit: ObjectId): TsgitError =>
  new TsgitError({ code: 'REVERT_MERGE_NO_MAINLINE', commit });
