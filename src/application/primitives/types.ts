/**
 * Primitive option shapes, walker value types, and shared constants.
 * Defined in one location to avoid circular imports between primitive modules.
 */
import type { RenameDetectOptions, TreeDiff } from '../../domain/diff/index.js';
import type {
  AuthorIdentity,
  ExtraHeader,
  FileMode,
  FilePath,
  GitObject,
  ObjectId,
  RefName,
  Tree,
} from '../../domain/objects/index.js';
import type { FileStat } from '../../ports/file-system.js';

/** Max symbolic-ref dereferences resolveRef will follow. */
export const MAX_SYMBOLIC_REF_DEPTH = 5;

/** Max tag-peel hops resolveRef / readTree will follow when peeling. */
export const MAX_PEEL_DEPTH = 5;

/** Max seeds walkCommits.from can contain. */
export const MAX_WALK_SEEDS = 1024;

/** Hard cap on walkCommits' pending queue size to prevent unbounded heap growth. */
export const MAX_WALK_QUEUE_SIZE = MAX_WALK_SEEDS * 64;

/** Max.git/index file size readIndex will accept. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;

/** Max commit message byte length createCommit will accept. */
export const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Per-file size cap enforced by `add --all` before reading working-tree
 * bytes into memory. Mirrors `MAX_CONFLICT_OUTPUT_BYTES` (256 MiB) so the
 * write-side memory ceiling matches the read-side ceiling.
 * See `docs/adr/032-add-all-large-file-guard.md`.
 */
export const MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024;

/**
 * Per-file cap on `.gitignore`, `.git/info/exclude`, and the global
 * excludesFile. 1 MiB leaves a 20× margin over real-world max-size
 * gitignore corpora. See `docs/adr/036-gitignore-bounded-read.md`.
 */
export const MAX_GITIGNORE_BYTES = 1 * 1024 * 1024;

/**
 * Per-file cap on a single `.git/logs/<ref>` reflog file. 16 MiB is generous
 * — `reflog expire` is the size-management story; this guard only stops an
 * adversarial or corrupt log from being buffered unbounded into memory.
 */
export const MAX_REFLOG_BYTES = 16 * 1024 * 1024;

export interface ReadObjectOptions {
  readonly verifyHash?: boolean;
  /**
   * Reject objects whose serialised payload exceeds this byte count, before
   * inflating the full content into memory. Counts the raw object content
   * (post-inflate, pre-loose-header). When unset, no cap applies.
   *
   * Used by `merge`'s content merger to bound peak memory when an adversarial
   * remote ships pathologically large blobs. See `docs/design/phase-13-8-
   * bounded-object-reads.md`.
   */
  readonly maxBytes?: number;
}

export interface ResolveRefOptions {
  readonly peel?: boolean;
  readonly maxSymbolicDepth?: number;
  readonly maxPeelDepth?: number;
}

/**
 * `updateRef` option shapes. A write requires a `reflogMessage` — git's
 * builtins always supply a reason string; the type checker forces every
 * present and future ref write to state why the ref moved. A delete drops the
 * reflog file, so it carries no message.
 */
export type UpdateRefOptions =
  | {
      readonly delete?: false;
      readonly expected?: ObjectId | 'absent';
      readonly reflogMessage: string;
    }
  | {
      readonly delete: true;
      readonly expected?: ObjectId | 'absent';
    };

export interface WalkCommitsOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  readonly order?: 'topo' | 'first-parent';
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
  /**
   * Commits whose parents must NOT be enqueued. Used for shallow boundaries
   * . The commit itself is still yielded — only its parents are
   * skipped. Callers that want to also skip the boundary commit pass it in
   * `until`.
   */
  readonly shallow?: ReadonlySet<ObjectId>;
}

/** Maximum `have` lines a single-round fetch will send. */
export const MAX_HAVES = 256;

/** Hard cap on objects enumerated for a single push. design */
export const MAX_PUSH_OBJECTS = 1_000_000;

export interface WalkTreeEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

export interface WalkTreeOptions {
  readonly recursive?: boolean;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

export interface WalkWorkingTreeEntry {
  readonly path: FilePath;
  readonly stat: FileStat;
}

export type WalkIgnorePredicate = (
  path: FilePath,
  isDirectory: boolean,
) => boolean | Promise<boolean>;

export interface WalkWorkingTreeOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  /**
   * predicate. Invoked on every directory BEFORE descent
   * (returning `true` prunes the entire subtree, skipping its `lstat`
   * cost) and on every leaf BEFORE yielding (returning `true` drops
   * the leaf). May be sync or async.
   */
  readonly ignore?: WalkIgnorePredicate;
}

export interface CreateCommitInput {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders?: ReadonlyArray<ExtraHeader>;
}

export type DiffTreesInput = Tree | ObjectId | undefined;

export interface DiffTreesOptions {
  readonly detectRenames?: boolean;
  readonly renameOptions?: RenameDetectOptions;
  /**
   * Recurse into sub-directories, surfacing nested blobs as full-path changes
   * (git's recursive diff) instead of one change per top-level sub-tree. Both
   * sides are flattened to full-path blob entries before classification.
   */
  readonly recursive?: boolean;
}

/**
 * Per-file cap on a single `.gitmodules` blob. 1 MiB matches the
 * `MAX_GITIGNORE_BYTES` budget: real `.gitmodules` files are KB-scale even in
 * very large superprojects, so a 1 MiB ceiling is a generous DoS guard
 * applied before inflate.
 */
export const MAX_GITMODULES_BYTES = 1 * 1024 * 1024;

/**
 * Recursion backstop for `walkSubmodules` — the cycle guard (visited gitdir
 * set) handles the genuine-cycle case; this cap stops a pathologically deep
 * but acyclic nest from running away.
 */
export const MAX_SUBMODULE_DEPTH = 100;

/** One submodule surfaced by `walkSubmodules`: a gitlink joined with its `.gitmodules` row. */
export interface SubmoduleEntry {
  /**
   * The `[submodule "<name>"]` subsection name in the `.gitmodules` of the
   * tree that contains this gitlink. Falls back to `path` when no row matches
   * the gitlink (a gitlink committed without a corresponding config entry).
   */
  readonly name: string;
  /** Slash-joined path from the *superproject* root to the gitlink. */
  readonly path: FilePath;
  /** `submodule.<name>.url` — absent when no `.gitmodules` row matched. */
  readonly url?: string;
  /** `submodule.<name>.branch` — absent when the key is unset. */
  readonly branch?: string;
  /** The commit object id the gitlink pins (the tree entry's id). */
  readonly commit: ObjectId;
  /** Recursion depth; 0 for a direct submodule of the superproject. */
  readonly depth: number;
  /** Path of the containing submodule; absent for `depth === 0` entries. */
  readonly parent?: FilePath;
}

/**
 * One entry yielded by `catFileBatch` — a discriminated union so that a
 * single bad id never aborts the stream. `ok: true` carries the parsed
 * object plus its canonical payload size (matches the `<size>` field of
 * `git cat-file --batch`'s header). `ok: false` is shaped to extend later:
 * `reason` is a literal union so a future variant is an additive change.
 */
/**
 * Optional knobs for the `catFileBatch` primitive — currently a single
 * `maxBytes` cap forwarded to each per-id `readObject` call so a long
 * batch over untrusted ids cannot exhaust the heap. Defaults to no cap.
 */
export interface CatFileBatchOptions {
  /**
   * Per-object byte cap. Rejected pre-inflate; same semantics as
   * `ReadObjectOptions.maxBytes`. When unset, no cap applies (parity
   * with `readObject`).
   */
  readonly maxBytes?: number;
}

export type CatFileBatchEntry =
  | {
      readonly ok: true;
      readonly id: ObjectId;
      readonly type: GitObject['type'];
      readonly size: number;
      readonly object: GitObject;
    }
  | {
      readonly ok: false;
      readonly id: ObjectId;
      readonly reason: 'missing';
    };

export interface WalkSubmodulesOptions {
  /** Tree-ish to walk. Default: `HEAD`. */
  readonly ref?: RefName | ObjectId;
  /** Descend into nested submodules' own `.gitmodules`. Default: `false`. */
  readonly recursive?: boolean;
  /**
   * Cap on recursion depth. Default: `MAX_SUBMODULE_DEPTH`. Entries at exactly
   * this depth are yielded but not recursed into.
   */
  readonly maxDepth?: number;
}

export type { TreeDiff };
