import type { CommandError } from './commands/error.js';
import type { DiffError } from './diff/error.js';
import type { IndexError } from './git-index/error.js';
import type { MergeError } from './merge/error.js';
import type { DomainObjectError } from './objects/error.js';
import type { ProtocolError } from './protocol/error.js';
import type { ReflogError } from './reflog/error.js';
import type { RefsError } from './refs/error.js';
import type { RepositoryError } from './repository/error.js';
import type { WorkdirStat } from './snapshot/workdir-entry-row.js';
import type { StorageError } from './storage/error.js';

export type AdapterError =
  | { readonly code: 'FILE_NOT_FOUND'; readonly path: string }
  | { readonly code: 'FILE_EXISTS'; readonly path: string }
  | { readonly code: 'NOT_A_DIRECTORY'; readonly path: string }
  | { readonly code: 'DIRECTORY_NOT_EMPTY'; readonly path: string }
  | { readonly code: 'PERMISSION_DENIED'; readonly path: string }
  | {
      readonly code: 'UNSUPPORTED_OPERATION';
      readonly operation: string;
      readonly reason: string;
    }
  | { readonly code: 'HASH_FAILED'; readonly reason: string }
  | { readonly code: 'COMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'DECOMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'HTTP_ERROR'; readonly statusCode: number; readonly reason: string }
  | { readonly code: 'NETWORK_ERROR'; readonly reason: string };

/** Cross-cutting application-tier codes raised by primitives (not adapters). */
export type ApplicationError =
  | { readonly code: 'INVALID_WALK_INPUT'; readonly reason: string }
  | { readonly code: 'OPERATION_ABORTED' }
  | {
      readonly code: 'RESOURCE_LOCKED';
      readonly resource: 'index' | 'ref';
      readonly path: string;
      readonly mtimeMs?: number;
    }
  | {
      readonly code: 'PACK_TOO_LARGE';
      readonly objectCount: number;
      readonly limit: number;
    }
  | { readonly code: 'SNAPSHOT_REQUIRED'; readonly reason: string }
  | {
      readonly code: 'WORKDIR_RACE';
      readonly path: string;
      readonly observed: WorkdirStat;
      readonly current: WorkdirStat;
    }
  | {
      readonly code: 'ORDER_INVARIANT_VIOLATION';
      readonly previous: string;
      readonly current: string;
    };

export type TsgitErrorData =
  | DomainObjectError
  | StorageError
  | RefsError
  | ReflogError
  | IndexError
  | AdapterError
  | DiffError
  | MergeError
  | ApplicationError
  | ProtocolError
  | RepositoryError
  | CommandError;

export class TsgitError extends Error {
  override readonly name = 'TsgitError';

  constructor(readonly data: TsgitErrorData) {
    super(`${data.code}: ${extractDetail(data)}`);
  }
}

/** @internal */
export function basename(path: string): string {
  const segments = path.split(/[/\\]/);
  // Stryker disable next-line ArithmeticOperator: equivalent — starting `i` at `segments.length + 1`
  // (instead of `- 1`) only performs extra `segments[i] === undefined` skips before landing on the
  // same real index, so the returned value is identical for every input.
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment !== undefined && segment !== '') {
      return segment;
    }
  }
  return path;
}

/**
 * The directory portion of a POSIX repo-relative path: everything before the
 * final `/`. A path with no `/` (a root-level leaf) yields `''`. Unlike
 * `basename`, this is POSIX-only (`/` separator) — working-tree paths are always
 * normalised to POSIX before reaching it.
 */
export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export const fileNotFound = (path: string): TsgitError =>
  new TsgitError({ code: 'FILE_NOT_FOUND', path });

export const fileExists = (path: string): TsgitError =>
  new TsgitError({ code: 'FILE_EXISTS', path });

export const notADirectory = (path: string): TsgitError =>
  new TsgitError({ code: 'NOT_A_DIRECTORY', path });

export const directoryNotEmpty = (path: string): TsgitError =>
  new TsgitError({ code: 'DIRECTORY_NOT_EMPTY', path });

export const permissionDenied = (path: string): TsgitError =>
  new TsgitError({ code: 'PERMISSION_DENIED', path });

export const unsupportedOperation = (operation: string, reason: string): TsgitError =>
  new TsgitError({ code: 'UNSUPPORTED_OPERATION', operation, reason });

export const hashFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'HASH_FAILED', reason });

export const compressFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'COMPRESS_FAILED', reason });

export const decompressFailed = (reason: string): TsgitError =>
  new TsgitError({ code: 'DECOMPRESS_FAILED', reason });

export const httpError = (statusCode: number, reason: string): TsgitError =>
  new TsgitError({ code: 'HTTP_ERROR', statusCode, reason });

export const networkError = (reason: string): TsgitError =>
  new TsgitError({ code: 'NETWORK_ERROR', reason });

export const invalidWalkInput = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_WALK_INPUT', reason });

export const operationAborted = (): TsgitError => new TsgitError({ code: 'OPERATION_ABORTED' });

export const snapshotRequired = (reason: string): TsgitError =>
  new TsgitError({ code: 'SNAPSHOT_REQUIRED', reason });

export const workdirRace = (
  path: string,
  observed: WorkdirStat,
  current: WorkdirStat,
): TsgitError => new TsgitError({ code: 'WORKDIR_RACE', path, observed, current });

export const orderInvariantViolation = (previous: string, current: string): TsgitError =>
  new TsgitError({ code: 'ORDER_INVARIANT_VIOLATION', previous, current });

function extractDetail(data: TsgitErrorData): string {
  switch (data.code) {
    case 'INVALID_OBJECT_ID':
    case 'INVALID_FILE_MODE':
      return data.value;
    case 'INVALID_OBJECT_HEADER':
    case 'INVALID_TREE_ENTRY':
    case 'INVALID_COMMIT':
    case 'INVALID_TAG':
    case 'INVALID_IDENTITY':
    case 'INVALID_PACK_HEADER':
    case 'INVALID_PACK_INDEX':
    case 'INVALID_PACK_ENTRY':
    case 'INVALID_DELTA':
    case 'INVALID_REF':
    case 'INVALID_PACKED_REFS':
    case 'INVALID_INDEX_HEADER':
    case 'INVALID_INDEX_ENTRY':
      return data.reason;
    case 'FILE_NOT_FOUND':
      return `file not found: ${basename(data.path)}`;
    case 'FILE_EXISTS':
      return `file already exists: ${basename(data.path)}`;
    case 'NOT_A_DIRECTORY':
      return `not a directory: ${basename(data.path)}`;
    case 'DIRECTORY_NOT_EMPTY':
      return `directory not empty: ${basename(data.path)}`;
    case 'PERMISSION_DENIED':
      return `permission denied: ${basename(data.path)}`;
    case 'UNSUPPORTED_OPERATION':
      return `unsupported operation: ${data.operation}: ${data.reason}`;
    case 'HASH_FAILED':
      return `hash computation failed: ${data.reason}`;
    case 'COMPRESS_FAILED':
      return `compression failed: ${data.reason}`;
    case 'DECOMPRESS_FAILED':
      return `decompression failed: ${data.reason}`;
    case 'HTTP_ERROR':
      return `HTTP ${data.statusCode}: ${data.reason}`;
    case 'NETWORK_ERROR':
      return `network error: ${data.reason}`;
    case 'INVALID_TREE_FOR_DIFF':
      return `invalid tree for diff: ${data.reason}`;
    case 'INVALID_DIFF_INPUT':
      return `invalid diff input: ${data.reason}`;
    case 'INVALID_MERGE_TREE':
      return `invalid merge tree: ${data.reason}`;
    case 'INVALID_MERGE_INPUT':
      return `invalid merge input: ${data.reason}`;
    case 'OBJECT_NOT_FOUND':
      return `object not found: ${data.id}`;
    case 'OBJECT_HASH_MISMATCH':
      return `object hash mismatch: expected=${data.expected} actual=${data.actual}`;
    case 'UNEXPECTED_OBJECT_TYPE':
      return `unexpected object type: expected=${data.expected} actual=${data.actual} id=${data.id}`;
    case 'TREE_CYCLE_DETECTED':
      return `tree cycle detected: ${data.id}`;
    case 'TREE_DEPTH_EXCEEDED':
      return `tree depth exceeded: ${data.depth}`;
    case 'TREE_ENTRY_LIMIT_EXCEEDED':
      return `tree entry limit exceeded: count=${data.count} limit=${data.limit}`;
    case 'OBJECT_TOO_LARGE':
      return `object too large: id=${data.id} size=${data.actualSize} limit=${data.limit}`;
    case 'DELTA_CHAIN_TOO_DEEP':
      return `delta chain too deep: ${data.depth}`;
    case 'REF_NOT_FOUND':
      return `ref not found: ${data.name}`;
    case 'REF_CHAIN_TOO_DEEP':
      return `ref chain too deep: depth=${data.depth} chain=${data.chain.join('->')}`;
    case 'REF_CYCLE_DETECTED':
      return `ref cycle detected: ${data.chain.join('->')}`;
    case 'REF_LOCKED':
      return `ref locked: ${data.name}`;
    case 'REF_UPDATE_CONFLICT':
      return `ref update conflict: name=${data.name} expected=${data.expected} actual=${data.actual}`;
    case 'INVALID_WALK_INPUT':
      return `invalid walk input: ${data.reason}`;
    case 'OPERATION_ABORTED':
      return 'operation aborted';
    case 'INVALID_PKT_LENGTH':
      return `invalid pkt-line length: ${data.value}`;
    case 'PKT_LENGTH_RESERVED':
      return `reserved pkt-line length: ${data.value}`;
    case 'PKT_TOO_LARGE':
      return `pkt-line too large: ${data.value} bytes (max 65520)`;
    case 'PKT_TRUNCATED':
      return `pkt-line truncated: ${data.remaining} bytes remaining`;
    case 'INVALID_BASE_URL':
      return `invalid base URL: ${data.reason}`;
    case 'MISSING_SERVICE_HEADER':
      return `missing service header: expected=${data.expected} actual=${data.actual}`;
    case 'MISSING_CAPABILITIES':
      return 'missing capabilities in advertisement';
    case 'INVALID_REF_LINE':
      return `invalid ref line: ${data.line}`;
    case 'DUPLICATE_REF':
      return `duplicate ref: ${data.name}`;
    case 'INVALID_SIDEBAND_CHANNEL':
      return `invalid sideband channel: ${data.channel}`;
    case 'SIDEBAND_FATAL':
      return `sideband fatal: ${data.message}`;
    case 'UNKNOWN_ACK_STATUS':
      return `unknown ack status: ${data.value}`;
    case 'INVALID_REPORT_STATUS':
      return `invalid report-status line: ${data.line}`;
    case 'EMPTY_WANTS':
      return 'upload-pack request has no wants';
    case 'EMPTY_RECEIVE_UPDATES':
      return 'receive-pack request has no updates';
    case 'TOO_MANY_ADVERTISED_REFS':
      return `advertised refs (${data.count}) exceed limit ${data.limit}`;
    case 'RESOURCE_LOCKED':
      return `${data.resource} locked: ${basename(data.path)}`;
    case 'PACK_TOO_LARGE':
      return `pack contains ${data.objectCount} objects, exceeds limit ${data.limit}`;
    case 'NOT_A_REPOSITORY':
      return `not a git repository: ${basename(data.path)}`;
    case 'BARE_REPOSITORY':
      return `operation requires a working tree: ${data.operation}`;
    case 'ALREADY_INITIALIZED':
      return `repository already exists: ${basename(data.path)}`;
    case 'WORKING_TREE_DIRTY':
      return `working tree has uncommitted changes: ${data.paths.length} files`;
    case 'PATHSPEC_NO_MATCH':
      return `pathspec did not match any files: ${data.pattern}`;
    case 'PATHSPEC_OUTSIDE_REPO':
      return `pathspec resolves outside repository: ${basename(data.path)}`;
    case 'NOTHING_TO_COMMIT':
      return 'nothing to commit (use allowEmpty: true to commit anyway)';
    case 'EMPTY_COMMIT_MESSAGE':
      return 'commit message is empty (use allowEmptyMessage: true to commit anyway)';
    case 'AUTHOR_UNCONFIGURED':
      return 'author identity not configured (set ctx.config.user or pass author/committer)';
    case 'BRANCH_EXISTS':
      return `branch already exists: ${data.name}`;
    case 'BRANCH_NOT_FOUND':
      return `branch not found: ${data.name}`;
    case 'TAG_EXISTS':
      return `tag already exists: ${data.name}`;
    case 'TAG_NOT_FOUND':
      return `tag not found: ${data.name}`;
    case 'CANNOT_DELETE_CHECKED_OUT_BRANCH':
      return `cannot delete branch currently checked out: ${data.name}`;
    case 'INVALID_URL':
      return `invalid URL: ${data.reason}`;
    case 'BLOCKED_HOST':
      return `host blocked: ${data.host} (${data.reason})`;
    case 'TOO_MANY_REDIRECTS':
      return `too many redirects: ${data.count}`;
    case 'UNSUPPORTED_SCHEME':
      return `unsupported URL scheme: ${data.scheme}`;
    case 'TARGET_DIRECTORY_NOT_EMPTY':
      return `target directory is not empty: ${basename(data.path)}`;
    case 'REMOTE_ADVERTISES_NO_REFS':
      return 'remote advertised no refs';
    case 'NON_FAST_FORWARD':
      return `non-fast-forward update for ${data.ref}: local=${data.local} remote=${data.remote}`;
    case 'PUSH_REJECTED':
      return `push rejected for ${data.ref}: ${data.reason}`;
    case 'MERGE_HAS_CONFLICTS':
      return `merge has unresolved conflicts: ${data.count} files`;
    case 'CHECKOUT_OVERWRITE_DIRTY':
      return `checkout would overwrite uncommitted changes: ${data.paths.length} files`;
    case 'REVPARSE_AMBIGUOUS':
      return `revision expression "${data.expression}" is ambiguous (${data.candidates.length} candidates)`;
    case 'REVPARSE_UNRESOLVED':
      return `cannot resolve revision: ${data.expression}`;
    case 'EMPTY_PATHSPEC':
      return 'pathspec is empty (use "." to mean "all paths")';
    case 'OPERATION_IN_PROGRESS':
      return `${data.operation} in progress; complete or abort it before running this command`;
    case 'NO_OPERATION_IN_PROGRESS':
      return `no ${data.operation} in progress`;
    case 'MAX_REFSPECS_EXCEEDED':
      return `${data.count} refspecs exceeds limit ${data.limit}`;
    case 'REMOTE_NOT_CONFIGURED':
      return `remote not configured: ${data.remote}`;
    case 'NO_UPSTREAM_CONFIGURED':
      return `no upstream configured for ${data.branch}`;
    case 'REMOTE_EXISTS':
      return `remote already exists: ${data.remote}`;
    case 'REMOTE_NAME_INVALID':
      return `invalid remote name "${data.name}": ${data.reason}`;
    case 'NO_PROMISOR_REMOTE':
      return 'no promisor remote configured; this repository is not a partial clone';
    case 'REFSPEC_INVALID':
      return `invalid refspec "${data.raw}": ${data.reason}`;
    case 'INVALID_OPTION':
      return `invalid option: ${data.option} — ${data.reason}`;
    case 'REPOSITORY_DISPOSED':
      return 'repository has been disposed; create a new one with openRepository()';
    case 'ADAPTER_UNAVAILABLE':
      return `adapter unavailable for runtime ${data.runtime}: ${data.reason}`;
    case 'WORKING_TREE_FILE_TOO_LARGE':
      return `working-tree file too large: ${basename(data.path)} size=${data.size} limit=${data.limit}`;
    case 'GITIGNORE_FILE_TOO_LARGE':
      return `.gitignore too large: ${basename(data.path)} size=${data.size} limit=${data.limit}`;
    case 'SPARSE_PATTERN_FILE_TOO_LARGE':
      return `sparse-checkout file too large: ${basename(data.path)} size=${data.size} limit=${data.limit}`;
    case 'INVALID_REFLOG_ENTRY':
      return `invalid reflog entry: ${data.reason}`;
    case 'REFLOG_NOT_FOUND':
      return `reflog not found: ${data.ref}`;
    case 'REFLOG_ENTRY_OUT_OF_RANGE':
      return `reflog entry out of range: ref=${data.ref} requested=${data.requested} available=${data.available}`;
    case 'HOOK_FAILED':
      return `hook ${data.hook} failed with exit code ${data.exitCode}`;
    case 'INVALID_FILTER_SPEC':
      return `invalid object filter "${data.spec}": ${data.reason}`;
    case 'REMOTE_FILTER_UNSUPPORTED':
      return 'remote does not support partial-clone object filtering';
    case 'SNAPSHOT_REQUIRED':
      return `snapshot required: ${data.reason}`;
    case 'WORKDIR_RACE':
      return `working-tree changed under us at ${basename(data.path)} (observed mtime=${data.observed.mtimeMs} size=${data.observed.size}, current mtime=${data.current.mtimeMs} size=${data.current.size})`;
    case 'ORDER_INVARIANT_VIOLATION':
      return `row order broken: ${data.previous} followed by ${data.current}`;
    case 'CONFIG_KEY_INVALID':
      return data.position === undefined
        ? `invalid config key "${data.key}": ${data.reason}`
        : `invalid config key "${data.key}": ${data.reason} at position ${data.position}`;
    case 'CONFIG_VALUE_INVALID':
      return `invalid config value for "${data.key}": ${data.reason} at position ${data.position}`;
    case 'CONFIG_MULTIPLE_VALUES':
      return data.scope === undefined
        ? `config key "${data.key}" has ${data.count} values (${data.requested} requires single)`
        : `config key "${data.key}" has ${data.count} values in scope ${data.scope} (${data.requested} requires single)`;
    case 'CONFIG_SECTION_NOT_FOUND':
      return `config section not found in scope ${data.scope}: ${data.name}`;
    case 'CONFIG_SCOPE_NOT_AVAILABLE':
      return `config scope not available: ${data.scope} (${data.reason})`;
    case 'CONFIG_SYSTEM_PATH_UNRESOLVED':
      return 'config system path could not be resolved on this platform';
    case 'MV_SOURCE_NOT_TRACKED':
      return `not under version control, source=${data.source}, destination=${data.destination}`;
    case 'MV_BAD_SOURCE':
      return `bad source, source=${data.source}, destination=${data.destination}`;
    case 'MV_DESTINATION_EXISTS':
      return `destination exists, source=${data.source}, destination=${data.destination}`;
    case 'MV_INTO_SELF':
      return `can not move directory into itself, source=${data.source}, destination=${data.destination}`;
    case 'MV_DESTINATION_NOT_DIRECTORY':
      return `destination '${data.destination}' is not a directory, source=${data.source}`;
    case 'MV_DESTINATION_DIRECTORY_MISSING':
      return `destination directory does not exist, source=${data.source}, destination=${data.destination}`;
    case 'MV_MULTIPLE_SOURCES_SAME_TARGET':
      return `multiple sources for the same target, source=${data.source}, destination=${data.destination}`;
    case 'MV_OVERLAPPING_SOURCES':
      return `cannot move both '${data.child}' and its parent directory '${data.parent}'`;
    case 'RM_STAGED_CHANGES':
      return `cannot remove ${data.paths.length} file(s) with changes staged in the index (use --cached to keep the file, or -f to force removal)`;
    case 'RM_LOCAL_MODIFICATIONS':
      return `cannot remove ${data.paths.length} file(s) with local modifications (use --cached to keep the file, or -f to force removal)`;
    case 'RM_STAGED_AND_LOCAL_CHANGES':
      return `cannot remove ${data.paths.length} file(s) with staged content different from both the file and HEAD (use -f to force removal)`;
    case 'NO_INITIAL_COMMIT':
      return 'you do not have the initial commit yet';
    case 'STASH_NOT_FOUND':
      return `stash@{${data.index}} is not a valid stash reference (stack size ${data.stackSize})`;
    case 'STASH_APPLY_WOULD_OVERWRITE':
      return `cannot apply stash: ${data.paths.length} local change(s) would be overwritten`;
    case 'AMBIGUOUS_OID_PREFIX':
      return `short object id ${data.prefix} is ambiguous (${data.candidates.length} candidates)`;
    case 'INVALID_SEQUENCER_TODO':
      return `invalid sequencer todo: ${data.reason}`;
    case 'CHERRY_PICK_MERGE_NO_MAINLINE':
      return `commit ${data.commit} is a merge but no -m option was given`;
    default: {
      const _exhaustive: never = data;
      return String(_exhaustive);
    }
  }
}
