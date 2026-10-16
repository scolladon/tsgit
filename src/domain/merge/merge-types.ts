import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import type { SidePaths } from './merge-renames.js';

export type ConflictType =
  | 'content'
  | 'add-add'
  | 'distinct-types'
  | 'file-directory'
  | 'modify-delete'
  | 'rename-delete'
  | 'type-change'
  | 'rename-rename'
  | 'file-location'
  | 'gitlink'
  | 'binary';

export interface MergeConflict {
  readonly type: ConflictType;
  readonly path: FilePath;
  readonly baseId?: ObjectId;
  readonly ourId?: ObjectId;
  readonly theirId?: ObjectId;
  readonly baseMode?: FileMode;
  readonly ourMode?: FileMode;
  readonly theirMode?: FileMode;
  readonly conflictContent?: Uint8Array;
  readonly contentVerdict?: 'clean' | 'content' | 'binary';
  /**
   * Three-way-merged mode for `content` conflicts (theirs' mode when only
   * theirs diverged from the base, ours' otherwise). The working tree is
   * materialised with this mode; the per-side stage entries keep their own.
   */
  readonly mergedMode?: FileMode;
  /** Recorded path for our side; populated only on `distinct-types` conflicts. */
  readonly ourPath?: FilePath;
  /** Recorded path for their side; populated only on `distinct-types` conflicts. */
  readonly theirPath?: FilePath;
  /** Recorded path of the base's stage-1 entry; populated only on `distinct-types` conflicts that have a base. */
  readonly basePath?: FilePath;
}

export type MergeOutcome =
  | {
      readonly status: 'unchanged';
      readonly path: FilePath;
      readonly id: ObjectId;
      readonly mode: FileMode;
    }
  | {
      readonly status: 'resolved-known';
      readonly path: FilePath;
      readonly id: ObjectId;
      readonly mode: FileMode;
    }
  | {
      readonly status: 'resolved-merged';
      readonly path: FilePath;
      readonly bytes: Uint8Array;
      readonly mode: FileMode;
    }
  | { readonly status: 'resolved-deleted'; readonly path: FilePath }
  | { readonly status: 'conflict'; readonly conflict: MergeConflict };

export interface TreeMergeResult {
  readonly outcomes: ReadonlyArray<MergeOutcome>;
  readonly conflicts: ReadonlyArray<MergeConflict>;
  readonly cleanMerge: boolean;
}

export type ContentMergeResult =
  | { readonly status: 'clean'; readonly bytes: Uint8Array; readonly id?: ObjectId }
  | {
      readonly status: 'conflict';
      readonly markedBytes: Uint8Array;
      readonly conflictType: 'content' | 'binary';
    };

export interface ContentMergeContext {
  readonly path: FilePath;
  readonly baseId?: ObjectId;
  readonly ourId: ObjectId;
  readonly theirId: ObjectId;
  readonly baseMode?: FileMode;
  readonly ourMode: FileMode;
  readonly theirMode: FileMode;
  /** Where base, ours and theirs held the path, present only when a rename makes them differ. */
  readonly sidePaths?: SidePaths;
  /** Characters added to the path's conflict-marker-size, so a nested merge's markers outgrow the outer ones. */
  readonly extraMarkerSize?: number;
}

/**
 * How an overlapping region is resolved: `none` → conflict markers, `union` →
 * both sides concatenated, `ours` / `theirs` → that side alone (git's `-X ours`
 * / `-X theirs`, which also settle a binary merge on that side).
 */
export type MergeFavor = 'none' | 'union' | 'ours' | 'theirs';

/** git's `merge.conflictStyle`: plain markers, or a `|||||||` base section (`zdiff3` trims common edges). */
export type ConflictStyle = 'merge' | 'diff3' | 'zdiff3';

export interface ConflictMarkerOptions {
  readonly labels?: {
    readonly ours?: string;
    readonly base?: string;
    readonly theirs?: string;
  };
  readonly conflictStyle?: ConflictStyle;
  /** Marker run length (git's `conflict-marker-size`); defaults to 7 when omitted. */
  readonly markerSize?: number;
}

/** Conflicts that stage each side at its own recorded path rather than at `path`. */
export const recordsOwnPaths = (conflict: MergeConflict): boolean =>
  conflict.type === 'distinct-types' || conflict.type === 'file-directory';

export const MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024;
