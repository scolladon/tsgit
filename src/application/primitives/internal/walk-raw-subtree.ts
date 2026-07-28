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
import type { FlattenBounds } from './flatten-raw.js';
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

export async function walkRawSubtree(
  ctx: Context,
  root: ObjectId,
  bounds: FlattenBounds,
  prefix: string,
  counter: Counter,
  emit: (entry: RawSubtreeEntry) => void,
): Promise<void> {
  const content = await readRawTreeById(ctx, root);
  await walkLevel(ctx, bounds, counter, content, root, prefix, 0, [], emit);
}

async function walkLevel(
  ctx: Context,
  bounds: FlattenBounds,
  counter: Counter,
  content: Uint8Array,
  id: ObjectId,
  prefix: string,
  depth: number,
  stack: ReadonlyArray<ObjectId>,
  emit: (entry: RawSubtreeEntry) => void,
): Promise<void> {
  if (stack.includes(id)) throw treeCycleDetected(id);
  if (exceedsMaxTreeDepth(depth, bounds.maxDepth)) throw treeDepthExceeded(depth);
  const descentStack = [...stack, id];
  const cursor = openTreeCursor(content, ctx.hashConfig);
  while (!cursor.done) {
    await emitEntry(ctx, bounds, counter, cursor, prefix, depth, descentStack, emit);
    advanceCursor(cursor);
  }
}

async function emitEntry(
  ctx: Context,
  bounds: FlattenBounds,
  counter: Counter,
  cursor: TreeCursor,
  prefix: string,
  depth: number,
  stack: ReadonlyArray<ObjectId>,
  emit: (entry: RawSubtreeEntry) => void,
): Promise<void> {
  if (ctx.signal?.aborted) throw operationAborted();
  const path = joinPath(prefix, cursorName(cursor));
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, bounds.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, bounds.maxEntries);
  }
  const mode = cursorMode(cursor);
  const id = cursorOid(cursor);
  if (mode !== FILE_MODE.DIRECTORY) {
    emit({ path, id, mode });
    return;
  }
  const raw = await readRawObject(ctx, id);
  if (raw.type !== 'tree') return;
  await walkLevel(ctx, bounds, counter, raw.content, id, path, depth + 1, stack, emit);
}
