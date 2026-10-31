import type { CommitGraphVerdict } from '../../../../domain/commit/commit-graph-verify.js';
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
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'hash-mismatch';
      readonly id: ObjectId;
      readonly actual: ObjectId;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'bad-ref';
      readonly ref: RefName;
      readonly msgId: string;
      readonly severity: FsckSeverity;
      readonly target?: ObjectId;
      /** The file git's `cannot read ref file` names, when the ref could not be read. */
      readonly path?: string;
      /** Why that file could not be read. */
      readonly reason?: 'PERMISSION_DENIED';
      /** The name a symbolic ref points to, exactly as read, on `badReferentName` and
       *  `symrefTargetIsNotARef` — not a `RefName`: git reports it because it is not one. */
      readonly referent?: string;
      /** The bytes after the object name, on a direct body's `trailingRefContent`. */
      readonly trailing?: string;
    }
  | {
      /** A path git's refs walk could not open or stat — `error opening directory` /
       *  `failed to stat`. A warning: no exit bit, gated by `checkReferences`, never re-typed. */
      readonly type: 'unreadable-ref-path';
      /** Absolute, as opened. */
      readonly path: string;
      readonly operation: 'open-directory' | 'stat';
      readonly reason: 'PERMISSION_DENIED';
    }
  | {
      /** git's iteration of a `refs` root that could not be opened — `failed to iterate over`,
       *  beside the `unreadable-ref-path` warning that names the same directory. Gated by
       *  `checkReferences`; exit bit 8. */
      readonly type: 'refs-walk-failed';
      /** Absolute, as opened. */
      readonly path: string;
      readonly reason: 'PERMISSION_DENIED';
    }
  | {
      /** git's `refs verify` child died on this symlinked ref: every content check after
       *  it is lost, pointers stand. Gated by `checkReferences`; exit bit 8. */
      readonly type: 'refs-verify-ended';
      readonly ref: RefName;
      /** Absolute, where the chain stopped. */
      readonly path: string;
      readonly reason: 'FILE_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'PERMISSION_DENIED' | 'SYMLINK_LOOP';
    }
  | {
      /** A reflog side naming an object the run never recorded — git's
       *  `invalid reflog entry`; one per side, so a line can yield two. */
      readonly type: 'invalid-reflog-entry';
      readonly ref: RefName;
      readonly id: ObjectId;
    }
  | {
      /** A cache-tree entry naming an object no store holds — git's
       *  `invalid sha1 pointer in cache-tree`; each one sets bit 8. */
      readonly type: 'invalid-cache-tree-pointer';
      readonly id: ObjectId;
      /** The index file naming it: one finding per worktree index that does. */
      readonly index: string;
    }
  | {
      /** A regular-file resolve-undo stage naming an object no store holds —
       *  git's `invalid sha1 pointer in resolve-undo`; each one sets bit 8. */
      readonly type: 'invalid-resolve-undo-pointer';
      readonly id: ObjectId;
      /** The index file naming it: one finding per worktree index that does. */
      readonly index: string;
    }
  | {
      /** No ref names an object git could parse — git's `No default references`
       *  notice, after which it reports no `unreachable` object. No exit bit. */
      readonly type: 'no-default-references';
    }
  | {
      /** A reflog-reached object whose served copy hashes to another id, under
       *  `connectivityOnly`, that no parse linking to it typed before the walk
       *  reached it — git's `Unknown object type for`: reached, never walked.
       *  No exit bit. */
      readonly type: 'unknown-object-type';
      readonly id: ObjectId;
    }
  | {
      /** An object a link typed as `expectedType` whose served copy is another
       *  type, under `connectivityOnly` — git's `Object <id> not a <type>`:
       *  reached, never walked. No exit bit. */
      readonly type: 'unexpected-object-type';
      readonly id: ObjectId;
      readonly expectedType: Exclude<FsckObjectType, 'blob'>;
    }
  | {
      /** A lookup asking for `expectedType` of an object an earlier lookup
       *  typed `objectType` — git's `object <id> is a <objectType>, not a
       *  <expectedType>`: the asking parse or walk gets no object. No exit bit. */
      readonly type: 'type-conflict';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType;
      readonly expectedType: FsckObjectType;
    }
  | {
      /** An object whose own parse failed on a type conflict — git's `<id>:
       *  object could not be parsed: <path>` for a loose copy, `<id>: object
       *  corrupt or missing` for a `pack` entry: never checked, never recorded
       *  as present. Bit 1. */
      readonly type: 'unparseable-object';
      readonly id: ObjectId;
      readonly pack?: string;
      readonly objectsDir?: string;
    }
  | {
      /** A commit (`tree`, `parent`) or tag (`tag`) whose link names `target`
       *  under a type conflict — git's `bad tree pointer <target> in commit
       *  <id>`, `bad parent <target> in commit <id>`, `bad tag pointer to
       *  <target> in <id>`. No exit bit of its own. */
      readonly type: 'bad-pointer';
      readonly id: ObjectId;
      readonly link: 'tree' | 'parent' | 'tag';
      readonly target: ObjectId;
    }
  | {
      /** An object whose check could not look up one of its links — git's
       *  `error in <objectType> <id>: broken links`. Bit 1. */
      readonly type: 'broken-links';
      readonly id: ObjectId;
      readonly objectType: FsckObjectType;
    }
  | {
      /** A link the reachability walk could not look up as `toType` — git's
       *  `broken link from <fromType> <fromId>` / `broken link from <toType>
       *  unknown`. Bit 2. */
      readonly type: 'unresolved-link';
      readonly fromId: ObjectId;
      readonly fromType: FsckObjectType;
      readonly toType: FsckObjectType;
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
       * scan-boundary filter already vetted: no path separator, no `..`, no
       * control character, so it is safe against traversal and line
       * injection. It is NOT shell-safe (spaces, quotes, `$`, backticks
       * survive the filter) — quote it before interpolating into a shell or
       * composing a path from it.
       */
      readonly pack: string;
      readonly reason: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'pack-index-unusable';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly reason: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'pack-rev-index-unusable';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly reason: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'pack-rev-index-invalid';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly reason: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'pack-rev-index-position-mismatch';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      /** Pack position — rank by ascending offset, `[0, objectCount)`. */
      readonly position: number;
      /** The index position `packPositionMap` derives from the pack's own `.idx`. */
      readonly expected: number;
      /** The index position the `.rev` file actually stores at `position`. */
      readonly stored: number;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      /** The `.idx`'s own trailing checksum disagrees with its bytes. */
      readonly type: 'pack-index-checksum-mismatch';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      /** The pack's trailing checksum disagrees with the bytes before it. */
      readonly type: 'pack-checksum-mismatch';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      /** An entry's raw bytes disagree with the CRC-32 its `.idx` records. */
      readonly type: 'pack-crc-mismatch';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly id: ObjectId;
      /** The entry's byte offset in the pack. */
      readonly offset: number;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      /** A packed entry that cannot be unpacked — git's `cannot unpack`. */
      readonly type: 'pack-entry-unpackable';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly id: ObjectId;
      /** The entry's byte offset in the pack. */
      readonly offset: number;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      /** A packed entry whose content does not hash to its indexed id. */
      readonly type: 'pack-entry-corrupt';
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      readonly id: ObjectId;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'midx-unusable';
      /** The artefact this verdict is about: `multi-pack-index`, or a chain
       *  layer's own file name. */
      readonly artefact: string;
      readonly reason: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'midx-checksum-mismatch';
      /** The artefact this verdict is about — always the flat file or the
       *  chain head; a base layer's trailer is never verified. */
      readonly artefact: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'midx-pack-unresolved';
      readonly artefact: string;
      /** Chain-global pack position: `Σ layers[0..k-1].numPacks + packIndex`. */
      readonly position: number;
      /** Pack base name (`pack-<sha>`) — see `pack-inaccessible`'s doc-comment. */
      readonly pack: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'midx-entry-unresolved';
      readonly artefact: string;
      readonly id: ObjectId;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | {
      readonly type: 'bitmap-checksum-mismatch';
      /** The artefact this verdict is about: a pack's `<base>.bitmap`, or
       *  the in-use multi-pack-index's `multi-pack-index-<hex>.bitmap`. */
      readonly artefact: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    }
  | ({
      readonly type: 'commit-graph-invalid';
      /** The commit-graph file the verdict is about. */
      readonly artefact: string;
      /** The alternate's objects dir the finding came from; absent for the primary. */
      readonly objectsDir?: string;
    } & CommitGraphVerdict);

/**
 * How `collectTypeFindings` treats a universe object whose cache entry is
 * `null` (unreadable). `'skip'` is today's default/`full: false` behaviour —
 * git turns unreadable loose objects into content errors there. `'classify'`
 * is `connectivityOnly` only — git yields `dangling unknown` there
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
   * (corrupt/hash-mismatch/strict-upgraded warn) and every pack, pack-index,
   * reverse-index, bitmap and multi-pack-index fault, 2=missing/broken-link,
   * 8=refs-verify content failure, 16=commit-graph verification failure.
   */
  readonly exitCode: number;
}
