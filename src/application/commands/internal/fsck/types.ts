import type { FsckObjectType, FsckSeverity } from '../../../../domain/fsck/index.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';

// ---------------------------------------------------------------------------
// Public finding type — re-exported by fsck.ts
// ---------------------------------------------------------------------------

export type FsckFinding =
  | {
      readonly type: 'dangling';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType | 'unknown';
    }
  | {
      readonly type: 'unreachable';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType | 'unknown';
    }
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
    }
  | {
      readonly type: 'pack-inaccessible';
      /**
       * Pack base name (`pack-<sha>`) — the same value the registry's
       * scan-boundary filter already vetted (no `/`, `\`, `..`, or control
       * character), so it crosses the library boundary as data no further
       * sanitiser needs to touch.
       */
      readonly pack: string;
      readonly reason: string;
    }
  | {
      readonly type: 'pack-index-unusable';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly reason: string;
    }
  | {
      readonly type: 'pack-rev-index-unusable';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly reason: string;
    };

/**
 * How `collectTypeFindings` treats a universe object whose cache entry is
 * `null` (unreadable). `'skip'` is today's default/`full: false` behaviour —
 * git turns unreadable loose objects into content errors there. `'classify'`
 * is `connectivityOnly` only (Pin P) — git yields `dangling unknown` there
 * instead. Not re-exported from `fsck.ts`: internal to the reachability pass.
 */
export type UnreadableMode = 'skip' | 'classify';

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
  /**
   * Composite exit bitmask, bits compose by OR: 0=clean, 1=content error
   * (corrupt/hash-mismatch/strict-upgraded warn), 2=missing/broken-link,
   * 4=pack inaccessible or index not opened, 8=refs-verify content failure,
   * 64=pack reverse-index unusable.
   */
  readonly exitCode: number;
}
