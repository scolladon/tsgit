/**
 * Raw byte-cursor descent that powers `flattenTree`. Walks tree bytes
 * directly via `TreeCursor` instead of materialising a `Tree` object per
 * level or a `TreeEntry` per entry — the same descent `walkTree` performs,
 * with the same guards (cycle stack, max depth, entry counter, abort check,
 * directory-skip filter, silent non-tree skip), but with no per-entry
 * promise and no intermediate allocation.
 *
 * Bounds are an explicit parameter rather than an inlined literal so the
 * entry-limit guard is reachable from a test with a small cap; `flattenTree`
 * calls this with `DEFAULT_FLATTEN_BOUNDS`.
 */
import type { FlatTree, FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import { MAX_TREE_WALK_DEPTH } from '../../../domain/diff/flat-tree.js';
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
import { exceedsMaxTreeDepth, exceedsMaxTreeEntries } from '../validators.js';
import { MAX_CONCURRENT_BLOB_LOADS } from './bounded-map.js';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from './concurrency-limiter.js';
import { prefetchSubtreeChildren, type SubtreePrefetch } from './raw-subtree-prefetch.js';
import { joinPath, readRawTreeById } from './raw-tree-io.js';

export interface FlattenBounds {
  readonly maxDepth: number;
  readonly maxEntries: number;
}

export const DEFAULT_FLATTEN_BOUNDS: FlattenBounds = {
  maxDepth: MAX_TREE_WALK_DEPTH,
  maxEntries: MAX_FLAT_TREE_ENTRIES,
};

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
    limiter: createConcurrencyLimiter(MAX_CONCURRENT_BLOB_LOADS),
  };
  const state: FlattenState = { counter: { value: 0 }, entries: new Map() };
  await flattenLevel(config, state, content, rootId, '', 0, []);
  return { entries: state.entries };
}

async function flattenLevel(
  config: FlattenConfig,
  state: FlattenState,
  content: Uint8Array,
  id: ObjectId,
  prefix: string,
  depth: number,
  stack: ReadonlyArray<ObjectId>,
): Promise<void> {
  if (stack.includes(id)) throw treeCycleDetected(id);
  if (exceedsMaxTreeDepth(depth, config.bounds.maxDepth)) throw treeDepthExceeded(depth);
  const descentStack = [...stack, id];
  // Fires off bounded-concurrency reads for every directory child at THIS
  // level before the (unchanged) sequential loop below even starts — the
  // loop still processes entries and awaits each descent one at a time, so
  // DFS pre-order and every guard's ordering are untouched; only WHEN the
  // underlying I/O was kicked off moves earlier.
  const prefetch = prefetchSubtreeChildren(config.ctx, content, config.limiter);
  const cursor = openTreeCursor(content, config.ctx.hashConfig);
  while (!cursor.done) {
    const child = flattenEntry(config, state, cursor, prefix);
    if (child !== undefined) {
      await descendIfTree(config, state, child.id, child.path, depth, descentStack, prefetch);
    }
    advanceCursor(cursor);
  }
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
  stack: ReadonlyArray<ObjectId>,
  prefetch: SubtreePrefetch,
): Promise<void> {
  // `prefetch` was built from THIS SAME content by a prescan that flags a
  // directory child exactly when `cursorMode` would (both key off the same
  // `S_ISDIR` byte test) — every id `flattenEntry` hands back as a directory
  // is guaranteed present.
  const raw = await prefetch.get(childId)!;
  if (raw.type !== 'tree') return;
  await flattenLevel(config, state, raw.content, childId, path, depth + 1, stack);
}
