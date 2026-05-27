import type { GitIndex } from '../domain/git-index/index.js';
import type { ObjectId, Tree } from '../domain/objects/index.js';
import type { FilePath } from '../domain/objects/object-id.js';
import type { Pathspec } from '../domain/pathspec/index.js';
import type { WorkdirEntryRow } from '../domain/snapshot/index.js';
import type { Context } from './context.js';

/**
 * Options shared by every resolver port. The `bypassCache` flag asks a
 * caching adapter to skip its cache for this call; raw adapters ignore it.
 */
export interface ResolveOptions {
  readonly bypassCache?: boolean;
}

/**
 * Predicate used by `WorkdirEnumerator` to prune working-tree traversal.
 * Mirrors the existing `WalkIgnorePredicate` shape (14.3) so the same
 * `repo.ignoreMatcher()` builder can be used at both the legacy walker
 * surface and the new snapshot surface.
 *
 * Invoked on every directory BEFORE descent (returning `true` prunes the
 * entire subtree, skipping its `lstat` cost) and on every leaf BEFORE
 * yielding (returning `true` drops the leaf). Composes with `paths`
 * (pathspec inclusion filter) via logical AND.
 */
export type WalkIgnorePredicate = (
  path: FilePath,
  isDirectory: boolean,
) => boolean | Promise<boolean>;

/**
 * Options for `WorkdirEnumerator.enumerate`. The snapshot layer translates
 * `WorkdirSnapshotOptions` (which carries higher-level concerns like
 * `consistency`) down to this shape; the enumerator port itself stays
 * focused on what to enumerate.
 */
export interface WorkdirEnumOptions {
  readonly paths?: Pathspec;
  readonly excludes?: WalkIgnorePredicate;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
}

/**
 * Resolves `.git/index` to its parsed `GitIndex` structure. Caching
 * adapters (see `src/adapters/snapshot-resolvers/caching-index-resolver.ts`)
 * implement freshness via the `WriteEventStream` + `GenerationView` ports;
 * raw adapters parse on every call.
 *
 * Callers MUST treat the returned value as deeply frozen — implementations
 * are free to share the same `GitIndex` reference across calls.
 */
export interface IndexResolver {
  resolve(ctx: Context, opts?: ResolveOptions): Promise<GitIndex>;
}

/**
 * Resolves a tree object by its oid. Caching adapters use a content-addressed
 * LRU (oids are immutable, no invalidation needed). Throws on type
 * mismatch — the oid must address a tree.
 */
export interface TreeResolver {
  resolve(ctx: Context, treeId: ObjectId, opts?: ResolveOptions): Promise<Tree>;
}

/**
 * Streams working-tree entries in canonical git path order. Honors
 * `ctx.signal` and the optional `opts.signal`; aborts surface as
 * `operationAborted()` from the iterator.
 */
export interface WorkdirEnumerator {
  enumerate(ctx: Context, opts: WorkdirEnumOptions): AsyncIterable<WorkdirEntryRow>;
}
