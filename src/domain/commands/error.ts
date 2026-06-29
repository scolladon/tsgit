import { TsgitError } from '../error.js';
import type { HookName } from '../hooks/index.js';
import type { FilePath, ObjectId, RefName } from '../objects/object-id.js';
import type { ReceivePackResponse as ReportStatus } from '../protocol/receive-pack.js';
import type { ConfigScope } from './config-key.js';

export type CommandError =
  | {
      readonly code: 'WORKING_TREE_DIRTY';
      readonly localChanges: ReadonlyArray<FilePath>;
      readonly untracked: ReadonlyArray<FilePath>;
    }
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
  | {
      readonly code: 'CHECKOUT_OVERWRITE_DIRTY';
      readonly localChanges: ReadonlyArray<FilePath>;
      readonly untracked: ReadonlyArray<FilePath>;
    }
  | {
      readonly code: 'REVPARSE_AMBIGUOUS';
      readonly expression: string;
      readonly candidates: ReadonlyArray<ObjectId>;
    }
  | { readonly code: 'REVPARSE_UNRESOLVED'; readonly expression: string }
  | { readonly code: 'PATH_NOT_IN_TREE'; readonly rev: string; readonly path: string }
  | { readonly code: 'WORKTREE_FILE_ABSENT'; readonly path: string }
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
      readonly code: 'GITATTRIBUTES_FILE_TOO_LARGE';
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
      readonly code: 'CLEAN_FILTER_FAILED';
      readonly path: FilePath;
      readonly filter: string;
      readonly exitCode: number;
    }
  | {
      readonly code: 'SMUDGE_FILTER_FAILED';
      readonly path: FilePath;
      readonly filter: string;
      readonly exitCode: number;
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
      readonly code: 'CONFIG_PARSE_ERROR';
      readonly line: number;
      readonly source?: string;
      readonly partialSectionName?: string;
    }
  | {
      readonly code: 'CONFIG_MISSING_VALUE';
      readonly key: string;
      readonly source: string;
      readonly line: number;
    }
  | {
      readonly code: 'CONFIG_BAD_NUMERIC_VALUE';
      readonly key: string;
      readonly source: string;
      readonly value: string;
      readonly reason: 'invalid unit' | 'out of range';
    }
  | { readonly code: 'CONFIG_BAD_ZLIB_LEVEL'; readonly level: number }
  | {
      readonly code: 'CONFIG_MULTIPLE_VALUES';
      readonly key: string;
      readonly count: number;
      readonly requested: 'read' | 'overwrite' | 'remove';
      readonly scope?: ConfigScope;
    }
  | { readonly code: 'CONFIG_INVALID_FILE'; readonly sectionName: string; readonly source: string }
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
  | { readonly code: 'REVERT_MERGE_NO_MAINLINE'; readonly commit: ObjectId }
  | { readonly code: 'NO_NAMES'; readonly oid: ObjectId }
  | { readonly code: 'NO_ANNOTATED_NAMES'; readonly oid: ObjectId }
  | { readonly code: 'NO_REACHABLE_NAMES'; readonly oid: ObjectId }
  | { readonly code: 'NO_EXACT_MATCH'; readonly oid: ObjectId }
  | { readonly code: 'CANNOT_DESCRIBE'; readonly oid: ObjectId }
  | { readonly code: 'BUNDLE_EMPTY'; readonly reason: 'no-refs' | 'no-objects' }
  | { readonly code: 'BUNDLE_READ_FAILED'; readonly path: string }
  | { readonly code: 'BUNDLE_BAD_HEADER'; readonly path: string; readonly reason: string }
  | {
      readonly code: 'BUNDLE_UNSUPPORTED_VERSION';
      readonly path?: string;
      readonly version: number;
    }
  | {
      readonly code: 'BUNDLE_PREREQUISITE_NOT_COMMIT';
      readonly oid: ObjectId;
      readonly objectType: string;
    }
  | { readonly code: 'NOTES_ALREADY_EXIST'; readonly object: ObjectId }
  | { readonly code: 'NOTES_OBJECT_HAS_NONE'; readonly object: ObjectId }
  | { readonly code: 'NOTES_REF_OUTSIDE'; readonly ref: string };

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

/**
 * The two would-overwrite refusal classes: `localChanges` is git's "Your local
 * changes …" block (tracked, locally-modified paths); `untracked` is git's "The
 * following untracked working tree files …" block (index-absent paths present on
 * disk). A refusal is raised when either array is non-empty.
 */
export interface WouldOverwriteClasses {
  readonly localChanges: ReadonlyArray<FilePath>;
  readonly untracked: ReadonlyArray<FilePath>;
}

export const workingTreeDirty = ({ localChanges, untracked }: WouldOverwriteClasses): TsgitError =>
  new TsgitError({ code: 'WORKING_TREE_DIRTY', localChanges, untracked });

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

export const checkoutOverwriteDirty = ({
  localChanges,
  untracked,
}: WouldOverwriteClasses): TsgitError =>
  new TsgitError({ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges, untracked });

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

export const worktreeFileAbsent = (path: string): TsgitError =>
  new TsgitError({ code: 'WORKTREE_FILE_ABSENT', path: sanitizeForDisplay(path) });

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

export const gitattributesFileTooLarge = (
  path: FilePath,
  size: number,
  limit: number,
): TsgitError => new TsgitError({ code: 'GITATTRIBUTES_FILE_TOO_LARGE', path, size, limit });

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

export const cleanFilterFailed = (path: FilePath, filter: string, exitCode: number): TsgitError =>
  new TsgitError({ code: 'CLEAN_FILTER_FAILED', path, filter, exitCode });

export const smudgeFilterFailed = (path: FilePath, filter: string, exitCode: number): TsgitError =>
  new TsgitError({ code: 'SMUDGE_FILTER_FAILED', path, filter, exitCode });

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

/**
 * Malformed config value or header at the 1-based physical `line`. `source`
 * labels the file when the caller knows it. `partialSectionName` carries the
 * partially-accumulated section.subsection name at the failure point — present
 * only for malformed quoted-subsection headers (git's `invalid section name`).
 */
export const configParseError = (
  line: number,
  source?: string,
  partialSectionName?: string,
): TsgitError =>
  new TsgitError({
    code: 'CONFIG_PARSE_ERROR',
    line,
    ...(source !== undefined ? { source } : {}),
    ...(partialSectionName !== undefined ? { partialSectionName } : {}),
  });

/**
 * A string-typed config key is present-but-valueless (git's internal NULL) at the
 * 1-based `line` of `source`. `key` is the fully-qualified config key
 * (`'user.name'`, `'remote.origin.url'`). Lets a caller reconstruct git's two-line
 * `missing value for '<key>'` / `bad config variable '<key>' … at line <N>` refusal.
 */
export const configMissingValue = (key: string, source: string, line: number): TsgitError =>
  new TsgitError({ code: 'CONFIG_MISSING_VALUE', key, source, line });

/**
 * An int-typed config key is present but its value cannot be parsed as a valid
 * git integer. `key` is the fully-qualified config key, `source` is the file path,
 * `value` is the raw read string (`''` for valueless), and `reason` is either
 * `'invalid unit'` (trailing garbage, no digits, empty) or `'out of range'`
 * (magnitude exceeds the signed 64-bit int range after scaling).
 */
export const configBadNumericValue = (
  key: string,
  source: string,
  value: string,
  reason: 'invalid unit' | 'out of range',
): TsgitError =>
  new TsgitError({
    code: 'CONFIG_BAD_NUMERIC_VALUE',
    key,
    source,
    value: sanitizeForDisplay(value),
    reason,
  });

/**
 * An int-typed zlib-level config key (`core.compression` / `core.loosecompression`)
 * is present and parses as a valid integer but falls outside zlib's accepted range
 * of `-1..9`. No key or file is embedded — git prints only the bare level value.
 */
export const configBadZlibLevel = (level: number): TsgitError =>
  new TsgitError({ code: 'CONFIG_BAD_ZLIB_LEVEL', level });

/**
 * A write operation was refused because the config file contains a malformed
 * quoted-subsection header. `sectionName` is the partially-accumulated
 * `section.subsection` name at the failure point (git's `invalid section name`
 * text); `source` is the file path.
 */
export const configInvalidFile = (sectionName: string, source: string): TsgitError =>
  new TsgitError({ code: 'CONFIG_INVALID_FILE', sectionName, source });

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

// `describe` refusals, mirroring git's three "cannot describe" conditions plus
// the exact-match miss. `oid` is the validated 40-hex target, embedded verbatim.
// `NO_NAMES`: no tags/refs exist (or all filtered out). `NO_ANNOTATED_NAMES`:
// only lightweight tags exist in the default annotated-only mode.
// `NO_REACHABLE_NAMES`: tags exist but none qualify/reach the target.
// `NO_EXACT_MATCH`: `exactMatch` and the commit carries no tag.
export const noNames = (oid: ObjectId): TsgitError => new TsgitError({ code: 'NO_NAMES', oid });

export const noAnnotatedNames = (oid: ObjectId): TsgitError =>
  new TsgitError({ code: 'NO_ANNOTATED_NAMES', oid });

export const noReachableNames = (oid: ObjectId): TsgitError =>
  new TsgitError({ code: 'NO_REACHABLE_NAMES', oid });

export const noExactMatch = (oid: ObjectId): TsgitError =>
  new TsgitError({ code: 'NO_EXACT_MATCH', oid });

// `describe --contains` with `--no-undefined`: the target is reachable from no
// qualifying ref and `always` was not set (git: `cannot describe '<oid>'`).
export const cannotDescribe = (oid: ObjectId): TsgitError =>
  new TsgitError({ code: 'CANNOT_DESCRIBE', oid });

// `bundle create` refusals. `reason` discriminates between a zero-ref selection
// (git `Refusing to create empty bundle.`) and a zero-object closure (same message
// but triggered when all selected tips are identical to their exclusions).
export const bundleEmpty = (reason: 'no-refs' | 'no-objects'): TsgitError =>
  new TsgitError({ code: 'BUNDLE_EMPTY', reason });

// `bundle verify`/`bundle list-heads` open-failure: the path does not exist or is
// unreadable. `path` is caller-supplied and sanitised before embedding.
// git: `error: could not open '<path>'`.
export const bundleReadFailed = (path: string): TsgitError =>
  new TsgitError({ code: 'BUNDLE_READ_FAILED', path: sanitizeForDisplay(path) });

// `bundle verify`/`bundle list-heads` header-parse failure: the file opened but
// its content does not conform to the bundle header grammar.
// git: `error: '<path>' does not look like a v2 or v3 bundle file`.
// `reason` is a short discriminator tag (`'not-a-bundle' | 'malformed-header'`).
export const bundleBadHeader = (path: string, reason: string): TsgitError =>
  new TsgitError({ code: 'BUNDLE_BAD_HEADER', path: sanitizeForDisplay(path), reason });

// `bundle verify`/`bundle list-heads` version refusal: the magic line indicates
// a bundle version tsgit does not support (currently v3 only).
// git 2.54.0 reads v3-sha1; tsgit refuses (sanctioned divergence).
export const bundleUnsupportedVersion = (path: string, version: number): TsgitError =>
  new TsgitError({
    code: 'BUNDLE_UNSUPPORTED_VERSION',
    path: sanitizeForDisplay(path),
    version,
  });

// `bundle create` version refusal: the caller requested a version that
// `serializeBundleHeader` does not support (only v2 is supported for writing).
export const bundleUnsupportedSerializeVersion = (version: number): TsgitError =>
  new TsgitError({ code: 'BUNDLE_UNSUPPORTED_VERSION', version });

// `bundle create` internal-invariant guard: a boundary oid resolved to a
// non-commit object. Boundary oids are always commits by construction (they
// come from `peel(ctx, oid, 'commit')`); this error surfaces store corruption.
export const bundlePrerequisiteNotCommit = (oid: ObjectId, objectType: string): TsgitError =>
  new TsgitError({ code: 'BUNDLE_PREREQUISITE_NOT_COMMIT', oid, objectType });

// `notes add` refusal when a note already exists and `force` was not set.
// git: `error: Cannot add notes. Found existing notes for object <oid>.`
export const notesAlreadyExist = (object: ObjectId): TsgitError =>
  new TsgitError({ code: 'NOTES_ALREADY_EXIST', object });

// `notes remove` refusal when the target object carries no note.
// git: `error: Object <oid> has no note`
export const notesObjectHasNone = (object: ObjectId): TsgitError =>
  new TsgitError({ code: 'NOTES_OBJECT_HAS_NONE', object });

// notes-ref refusal when GIT_NOTES_REF / core.notesRef names a ref outside
// refs/notes/. git uses env/config values verbatim (no expansion) and refuses:
// `fatal: refusing to <subcommand> notes in <ref> (outside of refs/notes/)`.
export const notesRefOutside = (ref: string): TsgitError =>
  new TsgitError({ code: 'NOTES_REF_OUTSIDE', ref });
