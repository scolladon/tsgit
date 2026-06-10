import type { FileMode, FilePath, ObjectId } from '../objects/index.js';

export type ConflictType =
  | 'content'
  | 'add-add'
  | 'modify-delete'
  | 'type-change'
  | 'rename-rename'
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
}

/** How an overlapping region is resolved: `none` → conflict markers, `union` → both sides concatenated. */
export type MergeFavor = 'none' | 'union';

export interface ConflictMarkerOptions {
  readonly labels?: {
    readonly ours?: string;
    readonly base?: string;
    readonly theirs?: string;
  };
  readonly conflictStyle?: 'merge' | 'diff3';
  /** Marker run length (git's `conflict-marker-size`); defaults to 7 when omitted. */
  readonly markerSize?: number;
}

export const MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024;
