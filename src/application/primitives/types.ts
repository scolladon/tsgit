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
  ObjectId,
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

export interface UpdateRefOptions {
  readonly expected?: ObjectId | 'absent';
  readonly delete?: boolean;
}

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
}

export type { TreeDiff };
