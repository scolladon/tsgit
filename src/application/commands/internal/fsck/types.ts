import type { FsckObjectType, FsckSeverity } from '../../../../domain/fsck/index.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';

// ---------------------------------------------------------------------------
// Public finding type — re-exported by fsck.ts
// ---------------------------------------------------------------------------

export type FsckFinding =
  | { readonly type: 'dangling'; readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'unreachable'; readonly id: ObjectId; readonly objectType: FsckObjectType }
  | {
      readonly type: 'missing';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType | 'unknown';
    }
  | {
      readonly type: 'broken-link';
      readonly fromId: ObjectId;
      readonly fromType: FsckObjectType;
      readonly toId: ObjectId;
      readonly toType: FsckObjectType | 'unknown';
    }
  | {
      readonly type: 'bad-object';
      readonly id: ObjectId;
      /** 'unknown' when the object is undecodable and the type cannot be determined. */
      readonly objectType: FsckObjectType | 'unknown';
      readonly msgId: string;
      readonly severity: FsckSeverity;
    }
  | {
      readonly type: 'hash-mismatch';
      readonly id: ObjectId;
      readonly actual: ObjectId;
    }
  | {
      readonly type: 'bad-ref';
      readonly ref: RefName;
      readonly msgId: string;
      readonly severity: FsckSeverity;
      readonly target?: ObjectId;
    }
  | { readonly type: 'root'; readonly id: ObjectId }
  | {
      readonly type: 'tagged';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType;
      readonly tagName: string;
      readonly tag: ObjectId;
    };

// ---------------------------------------------------------------------------
// Public options type — re-exported by fsck.ts
// ---------------------------------------------------------------------------

export interface FsckOptions {
  /** Skip object-content validation, check links only. */
  readonly connectivityOnly?: boolean;
  /** Default true — reflog oids are roots; false to exclude. */
  readonly reflogRoots?: boolean;
  /** Default true — index oids are roots. */
  readonly indexRoot?: boolean;
  /** Default true — include packs. */
  readonly full?: boolean;
  /** WARN-class msg-ids upgraded to ERROR (+exit bit). */
  readonly strict?: boolean;
  /** Default true — run refs-verify pass. */
  readonly checkReferences?: boolean;
}

// ---------------------------------------------------------------------------
// Public result type — re-exported by fsck.ts
// ---------------------------------------------------------------------------

export interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  /** Composite exit bitmask: 0=clean, 2=missing/broken-link. */
  readonly exitCode: number;
}
