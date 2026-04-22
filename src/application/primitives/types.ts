/**
 * Phase 7 primitive option shapes, walker value types, and shared constants.
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

/** Max symbolic-ref dereferences resolveRef will follow. */
export const MAX_SYMBOLIC_REF_DEPTH = 5;

/** Max tag-peel hops resolveRef / readTree will follow when peeling. */
export const MAX_PEEL_DEPTH = 5;

/** Max seeds walkCommits.from can contain. */
export const MAX_WALK_SEEDS = 1024;

/** Hard cap on walkCommits' pending queue size to prevent unbounded heap growth. */
export const MAX_WALK_QUEUE_SIZE = MAX_WALK_SEEDS * 64;

/** Max .git/index file size readIndex will accept. */
export const MAX_INDEX_BYTES = 256 * 1024 * 1024;

/** Max commit message byte length createCommit will accept. */
export const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024 * 1024;

export interface ReadObjectOptions {
  readonly verifyHash?: boolean;
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
}

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
