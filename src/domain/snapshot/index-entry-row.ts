import type { FileMode } from '../objects/file-mode.js';
import type { FilePath, ObjectId } from '../objects/object-id.js';

/**
 * Three index-entry boolean flags lifted out of git's wire format. Each is
 * a real index attribute; they collectively cover the bits status / add /
 * checkout consult.
 *
 * - `assumeUnchanged` (git-update-index `--assume-unchanged`): the user has
 *   promised the file does not change; tools may skip stat checks.
 * - `skipWorktree` (sparse-checkout): the file is tracked but should not be
 *   materialized in the working tree.
 * - `intentToAdd` (`git add --intent-to-add`): the entry exists with mode +
 *   path but its content has not yet been staged; oid is the empty blob.
 */
export interface IndexFlags {
  readonly assumeUnchanged: boolean;
  readonly skipWorktree: boolean;
  readonly intentToAdd: boolean;
}

/**
 * Stat snapshot persisted alongside each index entry by git's stat-cache.
 * May be stale (the file may have been modified since the index was
 * written); validity is determined by comparing against a fresh `lstat`
 * per git's racy-stat rules. Fields mirror the optional-precision shape
 * already used by `src/ports/file-system.ts:FileStat`.
 */
export interface IndexCachedStat {
  readonly mtimeMs: number;
  readonly mtimeNs?: bigint;
  readonly size: number;
  readonly ino?: bigint;
}

/**
 * Pure data shape for an index-source row. Stage > 0 means the entry is
 * part of an unmerged path (1 = base, 2 = ours, 3 = theirs); stage 0 is
 * the resolved / normal entry.
 */
export interface IndexEntryRow {
  readonly source: 'index';
  readonly path: FilePath;
  readonly oid: ObjectId;
  readonly mode: FileMode;
  readonly stage: 0 | 1 | 2 | 3;
  readonly flags: IndexFlags;
  readonly cachedStat?: IndexCachedStat;
}
