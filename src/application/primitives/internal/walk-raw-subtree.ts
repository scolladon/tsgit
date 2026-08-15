/**
 * Raw byte-cursor descent that expands an added/deleted subtree into one
 * leaf entry per tree entry, in DFS pre-order — the per-entry twin of
 * `flatten-raw.ts`'s `Map`-backed descent. A whole-subtree add or delete
 * must surface once per ENTRY, duplicates included, exactly as
 * `git diff-tree -r` does; `flattenTree`'s de-duplicating `Map`
 * (last-name-wins) is the right structure for worktree materialisation but
 * the wrong one here, so this module walks the bytes itself rather than
 * reuse that Map.
 *
 * Deliberately does NOT validate entry names — matching the raw merge-join
 * (`raw-tree-diff.ts`), which streams both sides in on-disk order without
 * refusing a duplicate name, an embedded `/`, or a `.`/`..` segment.
 * `flattenTree` itself is untouched and keeps its own validation and `Map`
 * semantics for every other caller.
 *
 * Shares the same safety guards as `flatten-raw.ts`'s descent (cycle stack,
 * max depth, entry counter, abort check) so an adversarial or pathological
 * subtree is bounded identically. The guard chain is a SIBLING of
 * `flatten-raw.ts`'s rather than a shared one: `flattenEntry`'s leaf path is
 * deliberately promise-free (no `await` until a directory is confirmed), and
 * this module is an accumulator over an `emit` callback for the same reason
 * — merging the two into one generic walker would force a promise back onto
 * flatten's leaf path (or a callback onto its `Map` write), regressing the
 * property either module optimises for.
 *
 * `emit` is called synchronously per entry rather than yielding through an
 * async generator: an accumulator recursion (plain `async function` calls,
 * an in-place counter, a caller-supplied sink) has none of a generator's
 * per-`yield*` allocation across nested levels — the entry budget is a
 * single mutable `Counter`, threaded through and back to the caller (see
 * `diff-trees.ts`), so ONE `diffRecursive` call spends ONE total entry
 * budget across every subtree it expands, not one fresh budget per subtree.
 *
 * This descent was measured honouring `core.maxTreeDepth` to at least
 * 15000 (2026-08-15): a fixture one level past a cap of 15000 refuses cleanly
 * with `TREE_DEPTH_EXCEEDED` at depth 15001. Deeper than that is
 * unmeasured — no raw stack overflow was observed at any depth tried.
 */
import { operationAborted } from '../../../domain/error.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
} from '../../../domain/objects/error.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../../domain/objects/index.js';
import {
  advanceCursor,
  cursorMode,
  cursorName,
  cursorOid,
  openTreeCursor,
  type TreeCursor,
} from '../../../domain/objects/tree-cursor.js';
import type { Context } from '../../../ports/context.js';
import { readRawObject } from '../read-object.js';
import { exceedsMaxTreeDepth, exceedsMaxTreeEntries } from '../validators.js';
import { MAX_CONCURRENT_OBJECT_LOADS } from './bounded-map.js';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from './concurrency-limiter.js';
import type { FlattenBounds } from './flatten-raw.js';
import { prefetchSubtreeChildren, type SubtreePrefetch } from './raw-subtree-prefetch.js';
import { readRawTreeById } from './raw-tree-io.js';

export interface RawSubtreeEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

export interface Counter {
  value: number;
}

/** Every prefix `walkRawSubtree` ever sees is non-empty: both callers
 *  (`expandAddedSubtree` / `expandDeletedSubtree` in `diff-trees.ts`) join
 *  the directory entry's own name onto their cursor prefix before calling
 *  in, and a tree entry name is never empty (the cursor's structural scan
 *  refuses it). So — unlike `flatten-raw.ts`'s/`diff-trees.ts`'s own
 *  `joinPath`, whose callers DO start from an empty root prefix — this one
 *  never needs the empty-prefix branch. */
function joinPath(prefix: string, name: string): FilePath {
  return `${prefix}/${name}` as FilePath;
}

/**
 * Everything invariant across the WHOLE walk (never rebuilt per level or per
 * entry): the context, the bounds, the caller's sink, and ONE concurrency
 * limiter shared by every level's prefetch so nested levels queue behind the
 * same budget instead of each multiplying the effective in-flight count.
 */
interface WalkConfig {
  readonly ctx: Context;
  readonly bounds: FlattenBounds;
  readonly limiter: ConcurrencyLimiter;
  readonly emit: (entry: RawSubtreeEntry) => void;
}

/**
 * `limiter` defaults to a fresh, walk-scoped instance for a standalone
 * caller (tests; any future direct consumer). `diff-trees.ts` passes its own
 * `DiffWalkState.limiter` instead — ONE limiter per diff OPERATION, shared
 * across every `walkRawSubtree` call that operation runs (added/deleted
 * subtrees can be expanded concurrently, sibling to sibling), so two
 * concurrent expansions queue behind the same budget rather than each
 * multiplying the effective in-flight count.
 */
export async function walkRawSubtree(
  ctx: Context,
  root: ObjectId,
  bounds: FlattenBounds,
  prefix: string,
  counter: Counter,
  emit: (entry: RawSubtreeEntry) => void,
  limiter: ConcurrencyLimiter = createConcurrencyLimiter(MAX_CONCURRENT_OBJECT_LOADS),
): Promise<void> {
  const content = await readRawTreeById(ctx, root);
  const config: WalkConfig = { ctx, bounds, limiter, emit };
  await walkLevel(config, counter, content, root, prefix, 0, new Set());
}

async function walkLevel(
  config: WalkConfig,
  counter: Counter,
  content: Uint8Array,
  id: ObjectId,
  prefix: string,
  depth: number,
  stack: Set<ObjectId>,
): Promise<void> {
  if (stack.has(id)) throw treeCycleDetected(id);
  if (exceedsMaxTreeDepth(depth, config.bounds.maxDepth)) throw treeDepthExceeded(depth);
  // `stack` is the single root-to-current path, owned by the entry point and
  // mutated as the descent moves: added here, removed when this level returns.
  // Deliberately not a fresh per-level copy — rebuilding one at every level
  // costs O(depth^2) live pointers, which turns a deep descent into heap
  // exhaustion (an uncatchable abort) instead of the typed refusal the depth
  // cap exists to produce. The cap is a user-supplied config value with no
  // internal ceiling, so that wall would be reachable by configuration alone.
  // The delete is what keeps two siblings sharing one subtree oid from
  // reading as a cycle.
  stack.add(id);
  // Fires off bounded-concurrency reads for a bounded WINDOW of directory
  // children at THIS level before the (unchanged) sequential loop below even
  // starts — the loop still processes entries and awaits each descent one at
  // a time, so DFS pre-order and every guard's ordering are untouched; only
  // WHEN the underlying I/O was kicked off moves earlier. A child beyond the
  // window (or the remaining entry budget) is read directly by `emitEntry`'s
  // fallback when the loop reaches it.
  const remainingEntries = config.bounds.maxEntries - counter.value;
  const prefetch = prefetchSubtreeChildren(config.ctx, content, config.limiter, remainingEntries);
  const cursor = openTreeCursor(content, config.ctx.hashConfig);
  while (!cursor.done) {
    await emitEntry(config, counter, cursor, prefix, depth, stack, prefetch);
    advanceCursor(cursor);
  }
  stack.delete(id);
}

async function emitEntry(
  config: WalkConfig,
  counter: Counter,
  cursor: TreeCursor,
  prefix: string,
  depth: number,
  stack: Set<ObjectId>,
  prefetch: SubtreePrefetch,
): Promise<void> {
  if (config.ctx.signal?.aborted) throw operationAborted();
  const path = joinPath(prefix, cursorName(cursor));
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, config.bounds.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, config.bounds.maxEntries);
  }
  const mode = cursorMode(cursor);
  const id = cursorOid(cursor);
  if (mode !== FILE_MODE.DIRECTORY) {
    config.emit({ path, id, mode });
    return;
  }
  // `prefetch` only covers a bounded window of this level's directory
  // children (see `raw-subtree-prefetch.ts`) — a child beyond the window, or
  // one the prescan never reached because it stopped tolerating a later
  // structural defect, is read directly here instead.
  const raw = await (prefetch.get(id) ?? readRawObject(config.ctx, id));
  if (raw.type !== 'tree') return;
  await walkLevel(config, counter, raw.content, id, path, depth + 1, stack);
}
