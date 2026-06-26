import {
  MSG_BAD_DATE,
  MSG_BAD_DATE_OVERFLOW,
  MSG_BAD_EMAIL,
  MSG_BAD_FILEMODE,
  MSG_BAD_GPGSIG,
  MSG_BAD_NAME,
  MSG_BAD_OBJECT_SHA1,
  MSG_BAD_PARENT_SHA1,
  MSG_BAD_TAG_NAME,
  MSG_BAD_TIMEZONE,
  MSG_BAD_TREE,
  MSG_BAD_TREE_SHA1,
  MSG_BAD_TYPE,
  MSG_DUPLICATE_ENTRIES,
  MSG_EMPTY_NAME,
  MSG_FULL_PATHNAME,
  MSG_GITATTRIBUTES_BLOB,
  MSG_GITATTRIBUTES_LARGE,
  MSG_GITATTRIBUTES_LINE_LENGTH,
  MSG_GITATTRIBUTES_MISSING,
  MSG_GITATTRIBUTES_SYMLINK,
  MSG_GITIGNORE_SYMLINK,
  MSG_GITMODULES_BLOB,
  MSG_GITMODULES_LARGE,
  MSG_GITMODULES_MISSING,
  MSG_GITMODULES_NAME,
  MSG_GITMODULES_PARSE,
  MSG_GITMODULES_PATH,
  MSG_GITMODULES_SYMLINK,
  MSG_GITMODULES_UPDATE,
  MSG_GITMODULES_URL,
  MSG_HAS_DOT,
  MSG_HAS_DOTDOT,
  MSG_HAS_DOTGIT,
  MSG_LARGE_PATHNAME,
  MSG_MAILMAP_SYMLINK,
  MSG_MISSING_AUTHOR,
  MSG_MISSING_COMMITTER,
  MSG_MISSING_EMAIL,
  MSG_MISSING_NAME_BEFORE_EMAIL,
  MSG_MISSING_OBJECT,
  MSG_MISSING_SPACE_BEFORE_DATE,
  MSG_MISSING_SPACE_BEFORE_EMAIL,
  MSG_MISSING_TAG,
  MSG_MISSING_TAG_ENTRY,
  MSG_MISSING_TAGGER_ENTRY,
  MSG_MISSING_TREE,
  MSG_MISSING_TYPE,
  MSG_MISSING_TYPE_ENTRY,
  MSG_MULTIPLE_AUTHORS,
  MSG_NUL_IN_COMMIT,
  MSG_NUL_IN_HEADER,
  MSG_NULL_SHA1,
  MSG_TREE_NOT_SORTED,
  MSG_UNKNOWN_TYPE,
  MSG_UNTERMINATED_HEADER,
  MSG_ZERO_PADDED_DATE,
  MSG_ZERO_PADDED_FILEMODE,
} from './msg-ids.js';
import type { FsckSeverity } from './types.js';

/**
 * Default severity for each msg-id.
 * Pinned against git 2.54.0 `fsck-msgids.adoc` and verified behaviourally.
 * IGNORE-severity ids are absent (never emitted).
 */
export const DEFAULT_SEVERITY: ReadonlyMap<string, FsckSeverity> = new Map([
  // tree
  [MSG_BAD_FILEMODE, 'info'],
  [MSG_BAD_TREE, 'error'],
  [MSG_BAD_TREE_SHA1, 'error'],
  [MSG_DUPLICATE_ENTRIES, 'error'],
  [MSG_EMPTY_NAME, 'warning'],
  [MSG_FULL_PATHNAME, 'warning'],
  [MSG_HAS_DOT, 'warning'],
  [MSG_HAS_DOTDOT, 'warning'],
  [MSG_HAS_DOTGIT, 'warning'],
  [MSG_LARGE_PATHNAME, 'warning'],
  [MSG_NULL_SHA1, 'warning'],
  [MSG_TREE_NOT_SORTED, 'error'],
  [MSG_ZERO_PADDED_FILEMODE, 'warning'],
  // tree — special-file mode checks
  [MSG_GITATTRIBUTES_BLOB, 'error'],
  [MSG_GITATTRIBUTES_SYMLINK, 'info'],
  [MSG_GITIGNORE_SYMLINK, 'info'],
  [MSG_GITMODULES_BLOB, 'error'],
  [MSG_GITMODULES_SYMLINK, 'error'],
  [MSG_MAILMAP_SYMLINK, 'info'],
  // commit
  [MSG_BAD_DATE, 'error'],
  [MSG_BAD_DATE_OVERFLOW, 'error'],
  [MSG_BAD_EMAIL, 'error'],
  [MSG_BAD_NAME, 'error'],
  [MSG_BAD_OBJECT_SHA1, 'error'],
  [MSG_BAD_PARENT_SHA1, 'error'],
  [MSG_BAD_TIMEZONE, 'error'],
  [MSG_BAD_TYPE, 'error'],
  [MSG_MISSING_AUTHOR, 'error'],
  [MSG_MISSING_COMMITTER, 'error'],
  [MSG_MISSING_EMAIL, 'error'],
  [MSG_MISSING_NAME_BEFORE_EMAIL, 'error'],
  [MSG_MISSING_SPACE_BEFORE_DATE, 'error'],
  [MSG_MISSING_SPACE_BEFORE_EMAIL, 'error'],
  [MSG_MISSING_TREE, 'error'],
  [MSG_MULTIPLE_AUTHORS, 'error'],
  [MSG_NUL_IN_COMMIT, 'warning'],
  [MSG_NUL_IN_HEADER, 'error'],
  [MSG_UNKNOWN_TYPE, 'error'],
  [MSG_UNTERMINATED_HEADER, 'error'],
  [MSG_ZERO_PADDED_DATE, 'error'],
  // tag
  [MSG_BAD_GPGSIG, 'error'],
  [MSG_BAD_TAG_NAME, 'info'],
  [MSG_MISSING_OBJECT, 'error'],
  [MSG_MISSING_TAG, 'error'],
  [MSG_MISSING_TAG_ENTRY, 'error'],
  [MSG_MISSING_TAGGER_ENTRY, 'info'],
  [MSG_MISSING_TYPE, 'error'],
  [MSG_MISSING_TYPE_ENTRY, 'error'],
  // blob — gitmodules
  [MSG_GITMODULES_LARGE, 'error'],
  [MSG_GITMODULES_MISSING, 'error'],
  [MSG_GITMODULES_NAME, 'error'],
  [MSG_GITMODULES_PARSE, 'info'],
  [MSG_GITMODULES_PATH, 'error'],
  [MSG_GITMODULES_UPDATE, 'error'],
  [MSG_GITMODULES_URL, 'error'],
  // blob — gitattributes
  [MSG_GITATTRIBUTES_LARGE, 'error'],
  [MSG_GITATTRIBUTES_LINE_LENGTH, 'error'],
  [MSG_GITATTRIBUTES_MISSING, 'error'],
]);

/**
 * The strict-upgrade set: msg-ids whose default WARN severity is upgraded to
 * ERROR when `--strict` is active. Only WARN-default rows are in this set;
 * ERROR/INFO/IGNORE/FATAL ids are NOT upgraded (pinned: `treeNotSorted` and
 * `missingSpaceBeforeEmail` stay ERROR in both modes; `zeroPaddedFilemode`
 * flips WARN→ERROR under strict).
 */
export const STRICT_UPGRADE_SET: ReadonlySet<string> = new Set([
  MSG_EMPTY_NAME,
  MSG_FULL_PATHNAME,
  MSG_HAS_DOT,
  MSG_HAS_DOTDOT,
  MSG_HAS_DOTGIT,
  MSG_LARGE_PATHNAME,
  MSG_NUL_IN_COMMIT,
  MSG_NULL_SHA1,
  MSG_ZERO_PADDED_FILEMODE,
]);

/** Resolve final severity for a msg-id, applying the strict upgrade if applicable. */
export function resolveSeverity(msgId: string, strict: boolean): FsckSeverity {
  const base = DEFAULT_SEVERITY.get(msgId) ?? 'error';
  // Stryker disable next-line ConditionalExpression: equivalent — every warning-severity msgId in DEFAULT_SEVERITY is also in STRICT_UPGRADE_SET, so .has() is always true when base==='warning'.
  if (strict && base === 'warning' && STRICT_UPGRADE_SET.has(msgId)) return 'error';
  return base;
}
