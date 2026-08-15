/**
 * Raw byte-cursor descent that powers `flattenTree`. Walks tree bytes
 * directly via `TreeCursor` instead of materialising a `Tree` object per
 * level or a `TreeEntry` per entry — the same descent `walkTree` performs,
 * with the same guards (cycle stack, max depth, entry counter, abort check,
 * directory-skip filter, silent non-tree skip). No per-entry promise or
 * intermediate allocation for a LEAF entry; a DIRECTORY entry trades some of
 * that back — a prefetch-map entry and a hex oid string per child within the
 * prescan window (`raw-subtree-prefetch.ts`) — for overlapping child object
 * I/O across siblings instead of paying for it one descent at a time.
 *
 * Bounds are an explicit parameter rather than an inlined literal so the
 * entry-limit guard is reachable from a test with a small cap; `flattenTree`
 * calls this with `resolveFlattenBounds(ctx)`.
 *
 * This descent was measured honouring `core.maxTreeDepth` to at least
 * 15000 (2026-08-15): a fixture one level past a cap of 15000 refuses cleanly
 * with `TREE_DEPTH_EXCEEDED` at depth 15001. Deeper than that is
 * unmeasured — no raw stack overflow was observed at any depth tried.
 */
import type { FlatTree, FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import { MAX_FLAT_TREE_ENTRIES } from '../../../domain/diff/index.js';
import { operationAborted } from '../../../domain/error.js';
import {
  invalidTreeEntry,
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
} from '../../../domain/objects/error.js';
import {
  FILE_MODE,
  type FilePath,
  type ObjectId,
  type Tree,
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
import { prefetchSubtreeChildren, type SubtreePrefetch } from './raw-subtree-prefetch.js';
import { joinPath, readRawTreeById } from './raw-tree-io.js';
import { resolveMaxTreeDepth } from './resolve-max-tree-depth.js';

export interface FlattenBounds {
  readonly maxDepth: number;
  readonly maxEntries: number;
}

/**
 * Resolve the bounds `flattenRawTree` uses by default: `maxDepth` from the
 * repository-local `core.maxTreeDepth` (default 2048 when unset), `maxEntries`
 * fixed at `MAX_FLAT_TREE_ENTRIES`. `FlattenBounds.maxDepth` stays a required
 * field rather than an optional one so a call site can never forget the cap —
 * an optional field would push the default down into `flattenLevel` (i.e. per
 * level), which is exactly the hazard a single resolve-at-the-entry-point call
 * avoids.
 */
export const resolveFlattenBounds = async (ctx: Context): Promise<FlattenBounds> => ({
  maxDepth: await resolveMaxTreeDepth(ctx),
  maxEntries: MAX_FLAT_TREE_ENTRIES,
});

interface FlattenConfig {
  readonly ctx: Context;
  readonly bounds: FlattenBounds;
  /**
   * ONE limiter per `flattenRawTree` call, threaded through the whole
   * recursion (never rebuilt per level) — so nested levels queue behind the
   * same concurrency budget instead of each opening a fresh one and
   * multiplying the effective in-flight read count.
   */
  readonly limiter: ConcurrencyLimiter;
}

interface Counter {
  value: number;
}

interface FlattenState {
  readonly counter: Counter;
  readonly entries: Map<FilePath, FlatTreeEntry>;
}

/**
 * `preread`, when supplied, is the root's own raw content already read by
 * the caller (e.g. `diff-trees.ts`'s `peelToTree` reads the terminal tree as
 * its last peel hop) — passing it skips this function's own root read
 * entirely, so a caller that already paid for the bytes never pays twice.
 * It also skips the non-tree refusal that read performs: the caller MUST
 * have already verified the bytes are tree content.
 */
export async function flattenRawTree(
  ctx: Context,
  root: ObjectId | Tree,
  bounds: FlattenBounds,
  preread?: Uint8Array,
): Promise<FlatTree> {
  const rootId = typeof root === 'string' ? root : root.id;
  const content = preread ?? (await readRawTreeById(ctx, rootId));
  const config: FlattenConfig = {
    ctx,
    bounds,
    limiter: createConcurrencyLimiter(MAX_CONCURRENT_OBJECT_LOADS),
  };
  const state: FlattenState = { counter: { value: 0 }, entries: new Map() };
  await flattenLevel(config, state, content, rootId, '', 0, new Set());
  return { entries: state.entries };
}

async function flattenLevel(
  config: FlattenConfig,
  state: FlattenState,
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
  // window (or the remaining entry budget) is read directly by
  // `descendIfTree`'s fallback when the loop reaches it.
  const remainingEntries = config.bounds.maxEntries - state.counter.value;
  const prefetch = prefetchSubtreeChildren(config.ctx, content, config.limiter, remainingEntries);
  const cursor = openTreeCursor(content, config.ctx.hashConfig);
  while (!cursor.done) {
    const child = flattenEntry(config, state, cursor, prefix);
    if (child !== undefined) {
      await descendIfTree(config, state, child.id, child.path, depth, stack, prefetch);
    }
    advanceCursor(cursor);
  }
  stack.delete(id);
}

/**
 * Leaf-level work for one entry — abort check, name validation, counter/cap
 * check, and (for a leaf) the `Map` write — all synchronous: no promise is
 * allocated for an entry that turns out to be a leaf. Returns the child id
 * and path to descend into when the entry is a directory, `undefined`
 * otherwise (the leaf is already recorded).
 */
function flattenEntry(
  config: FlattenConfig,
  state: FlattenState,
  cursor: TreeCursor,
  prefix: string,
): { readonly id: ObjectId; readonly path: FilePath } | undefined {
  if (config.ctx.signal?.aborted) throw operationAborted();
  const path = joinPath(prefix, validatedName(cursor));
  state.counter.value += 1;
  if (exceedsMaxTreeEntries(state.counter.value, config.bounds.maxEntries)) {
    throw treeEntryLimitExceeded(state.counter.value, config.bounds.maxEntries);
  }
  const mode = cursorMode(cursor);
  const id = cursorOid(cursor);
  if (mode !== FILE_MODE.DIRECTORY) {
    state.entries.set(path, { id, mode });
    return undefined;
  }
  return { id, path };
}

// Name validation stays on this path (unlike the raw merge-join diff, which
// drops it) because flatten feeds worktree materialisation. An empty name
// never reaches here — the cursor's own structural scan already refuses it
// (nameEnd === nameStart) before a caller can observe it — so only the
// shape checks `parseTreeContent` layered on top of its own null-terminator
// scan are repeated here, with the identical reason string.
function validatedName(cursor: TreeCursor): string {
  const name = cursorName(cursor);
  if (name === '.' || name === '..' || name.includes('/')) {
    throw invalidTreeEntry(cursor.offset, `invalid entry name: ${name}`);
  }
  return name;
}

async function descendIfTree(
  config: FlattenConfig,
  state: FlattenState,
  childId: ObjectId,
  path: FilePath,
  depth: number,
  stack: Set<ObjectId>,
  prefetch: SubtreePrefetch,
): Promise<void> {
  // `prefetch` only covers a bounded window of this level's directory
  // children (see `raw-subtree-prefetch.ts`) — a child beyond the window, or
  // one the prescan never reached because it stopped tolerating a later
  // structural defect, is read directly here instead.
  const raw = await (prefetch.get(childId) ?? readRawObject(config.ctx, childId));
  if (raw.type !== 'tree') return;
  await flattenLevel(config, state, raw.content, childId, path, depth + 1, stack);
}
