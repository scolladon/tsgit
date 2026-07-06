import type { TsgitErrorData } from '../../../src/domain/error.js';

/**
 * Shared exhaustiveness gate. Every domain submodule's error.test.ts asserts
 * that ALL TsgitErrorData variants are matchable via a single switch — kept in
 * one place so widening the union (e.g., /) only requires
 * editing this file.
 *
 * The function does not return a useful value at runtime; the type-level
 * `never` assignment in the default arm is what enforces exhaustiveness at
 * compile time.
 */
export function assertExhaustiveSwitch(data: TsgitErrorData): void {
  switch (data.code) {
    case 'INVALID_OBJECT_ID':
    case 'INVALID_OBJECT_HEADER':
    case 'INVALID_TREE_ENTRY':
    case 'INVALID_COMMIT':
    case 'INVALID_TAG':
    case 'INVALID_FILE_MODE':
    case 'INVALID_IDENTITY':
    case 'INVALID_PACK_HEADER':
    case 'INVALID_PACK_INDEX':
    case 'INVALID_PACK_ENTRY':
    case 'INVALID_DELTA':
    case 'INVALID_REF':
    case 'INVALID_PACKED_REFS':
    case 'INVALID_INDEX_HEADER':
    case 'INVALID_INDEX_ENTRY':
    case 'FILE_NOT_FOUND':
    case 'FILE_EXISTS':
    case 'NOT_A_DIRECTORY':
    case 'DIRECTORY_NOT_EMPTY':
    case 'PERMISSION_DENIED':
    case 'UNSUPPORTED_OPERATION':
    case 'HASH_FAILED':
    case 'COMPRESS_FAILED':
    case 'DECOMPRESS_FAILED':
    case 'HTTP_ERROR':
    case 'NETWORK_ERROR':
    case 'INVALID_TREE_FOR_DIFF':
    case 'INVALID_DIFF_INPUT':
    case 'INVALID_MERGE_TREE':
    case 'INVALID_MERGE_INPUT':
    case 'OBJECT_NOT_FOUND':
    case 'OBJECT_HASH_MISMATCH':
    case 'UNEXPECTED_OBJECT_TYPE':
    case 'TREE_CYCLE_DETECTED':
    case 'TREE_DEPTH_EXCEEDED':
    case 'TREE_ENTRY_LIMIT_EXCEEDED':
    case 'DELTA_CHAIN_TOO_DEEP':
    case 'REF_NOT_FOUND':
    case 'REF_CHAIN_TOO_DEEP':
    case 'REF_CYCLE_DETECTED':
    case 'REF_LOCKED':
    case 'REF_UPDATE_CONFLICT':
    case 'INVALID_WALK_INPUT':
    case 'OPERATION_ABORTED':
    case 'INVALID_PKT_LENGTH':
    case 'PKT_LENGTH_RESERVED':
    case 'PKT_TOO_LARGE':
    case 'PKT_TRUNCATED':
    case 'INVALID_BASE_URL':
    case 'MISSING_SERVICE_HEADER':
    case 'MISSING_CAPABILITIES':
    case 'INVALID_REF_LINE':
    case 'DUPLICATE_REF':
    case 'INVALID_SIDEBAND_CHANNEL':
    case 'SIDEBAND_FATAL':
    case 'UNKNOWN_ACK_STATUS':
    case 'INVALID_REPORT_STATUS':
    case 'EMPTY_WANTS':
    case 'EMPTY_RECEIVE_UPDATES':
    case 'RESOURCE_LOCKED':
    case 'PACK_TOO_LARGE':
    case 'NOT_A_REPOSITORY':
    case 'BARE_REPOSITORY':
    case 'ALREADY_INITIALIZED':
    case 'WORKING_TREE_DIRTY':
    case 'PATHSPEC_NO_MATCH':
    case 'PATHSPEC_OUTSIDE_REPO':
    case 'NOTHING_TO_COMMIT':
    case 'EMPTY_COMMIT_MESSAGE':
    case 'AUTHOR_UNCONFIGURED':
    case 'BRANCH_EXISTS':
    case 'BRANCH_NOT_FOUND':
    case 'TAG_EXISTS':
    case 'TAG_NOT_FOUND':
    case 'CANNOT_DELETE_CHECKED_OUT_BRANCH':
    case 'INVALID_URL':
    case 'BLOCKED_HOST':
    case 'TOO_MANY_REDIRECTS':
    case 'UNSUPPORTED_SCHEME':
    case 'TARGET_DIRECTORY_NOT_EMPTY':
    case 'REMOTE_ADVERTISES_NO_REFS':
    case 'NON_FAST_FORWARD':
    case 'PUSH_REJECTED':
    case 'MERGE_HAS_CONFLICTS':
    case 'CHECKOUT_OVERWRITE_DIRTY':
    case 'REVPARSE_AMBIGUOUS':
    case 'REVPARSE_UNRESOLVED':
    case 'PATH_NOT_IN_TREE':
    case 'WORKTREE_FILE_ABSENT':
    case 'EMPTY_PATHSPEC':
    case 'OPERATION_IN_PROGRESS':
    case 'NO_OPERATION_IN_PROGRESS':
    case 'MAX_REFSPECS_EXCEEDED':
    case 'REMOTE_NOT_CONFIGURED':
    case 'NO_UPSTREAM_CONFIGURED':
    case 'REMOTE_EXISTS':
    case 'REMOTE_NAME_INVALID':
    case 'NO_PROMISOR_REMOTE':
    case 'REFSPEC_INVALID':
    case 'INVALID_OPTION':
    case 'REPOSITORY_DISPOSED':
    case 'ADAPTER_UNAVAILABLE':
    case 'TOO_MANY_ADVERTISED_REFS':
    case 'OBJECT_TOO_LARGE':
    case 'WORKING_TREE_FILE_TOO_LARGE':
    case 'GITIGNORE_FILE_TOO_LARGE':
    case 'GITATTRIBUTES_FILE_TOO_LARGE':
    case 'SPARSE_PATTERN_FILE_TOO_LARGE':
    case 'INVALID_REFLOG_ENTRY':
    case 'REFLOG_NOT_FOUND':
    case 'REFLOG_ENTRY_OUT_OF_RANGE':
    case 'HOOK_FAILED':
    case 'CLEAN_FILTER_FAILED':
    case 'SMUDGE_FILTER_FAILED':
    case 'INVALID_FILTER_SPEC':
    case 'REMOTE_FILTER_UNSUPPORTED':
    case 'UNEXPECTED_V2_SECTION':
    case 'V2_COMMAND_UNSUPPORTED':
    case 'TOO_MANY_SECTION_ENTRIES':
    case 'UNSUPPORTED_OBJECT_FORMAT':
    case 'SNAPSHOT_REQUIRED':
    case 'WORKDIR_RACE':
    case 'ORDER_INVARIANT_VIOLATION':
    case 'CONFIG_KEY_INVALID':
    case 'CONFIG_VALUE_INVALID':
    case 'CONFIG_PARSE_ERROR':
    case 'CONFIG_MISSING_VALUE':
    case 'CONFIG_BAD_NUMERIC_VALUE':
    case 'CONFIG_BAD_ZLIB_LEVEL':
    case 'CONFIG_INVALID_FILE':
    case 'CONFIG_MULTIPLE_VALUES':
    case 'CONFIG_SECTION_NOT_FOUND':
    case 'CONFIG_SCOPE_NOT_AVAILABLE':
    case 'CONFIG_SYSTEM_PATH_UNRESOLVED':
    case 'MV_SOURCE_NOT_TRACKED':
    case 'MV_BAD_SOURCE':
    case 'MV_DESTINATION_EXISTS':
    case 'MV_INTO_SELF':
    case 'MV_DESTINATION_NOT_DIRECTORY':
    case 'MV_DESTINATION_DIRECTORY_MISSING':
    case 'MV_MULTIPLE_SOURCES_SAME_TARGET':
    case 'MV_OVERLAPPING_SOURCES':
    case 'RM_STAGED_CHANGES':
    case 'RM_LOCAL_MODIFICATIONS':
    case 'RM_STAGED_AND_LOCAL_CHANGES':
    case 'NO_INITIAL_COMMIT':
    case 'STASH_NOT_FOUND':
    case 'STASH_APPLY_WOULD_OVERWRITE':
    case 'AMBIGUOUS_OID_PREFIX':
    case 'INVALID_SEQUENCER_TODO':
    case 'CHERRY_PICK_MERGE_NO_MAINLINE':
    case 'REVERT_MERGE_NO_MAINLINE':
    case 'NO_NAMES':
    case 'NO_ANNOTATED_NAMES':
    case 'NO_REACHABLE_NAMES':
    case 'NO_EXACT_MATCH':
    case 'CANNOT_DESCRIBE':
    case 'RELATIVE_URL_UNRESOLVABLE':
    case 'SUBMODULE_HAS_MODIFICATIONS':
    case 'SUBMODULE_PATH_EXISTS':
    case 'WORKTREE_PATH_EXISTS':
    case 'BRANCH_CHECKED_OUT':
    case 'WORKTREE_LOCKED':
    case 'WORKTREE_DIRTY':
    case 'NOT_A_WORKTREE':
    case 'BUNDLE_EMPTY':
    case 'BUNDLE_READ_FAILED':
    case 'BUNDLE_BAD_HEADER':
    case 'BUNDLE_UNSUPPORTED_VERSION':
    case 'BUNDLE_PREREQUISITE_NOT_COMMIT':
    case 'NOTES_ALREADY_EXIST':
    case 'NOTES_OBJECT_HAS_NONE':
    case 'NOTES_REF_OUTSIDE':
    case 'SIGNING_FAILED':
    case 'SIGNED_PUSH_UNSUPPORTED':
    case 'PUSH_DETACHED_NO_REFSPEC':
    case 'PUSH_DEFAULT_NOTHING':
    case 'PUSH_REMOTE_NOT_UPSTREAM':
      return;
    default: {
      const _exhaustive: never = data;
      throw new Error(`Unhandled case: ${String(_exhaustive)}`);
    }
  }
}
