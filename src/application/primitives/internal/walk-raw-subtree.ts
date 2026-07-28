/**
 * Raw byte-cursor descent that expands an added/deleted subtree into one
 * leaf entry per tree entry, in DFS pre-order — the per-entry twin of
 * `flatten-raw.ts`'s `Map`-backed descent. A whole-subtree add or delete
 * must surface once per ENTRY, duplicates included, exactly as
 * `git diff-tree -r` does; `flattenRawTree`'s de-duplicating `Map`
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
 * subtree is bounded identically.
 */
import { operationAborted } from '../../../domain/error.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
  unexpectedObjectType,
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

export interface RawSubtreeEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface Counter {
  value: number;
}

export async function* walkRawSubtree(
  ctx: Context,
  root: ObjectId,
  bounds: FlattenBounds,
  prefix: string,
): AsyncGenerator<RawSubtreeEntry> {
  const content = await readRawTreeById(ctx, root);
  const counter: Counter = { value: 0 };
  yield* walkLevel(ctx, bounds, counter, content, root, prefix, 0, []);
}

async function readRawTreeById(ctx: Context, id: ObjectId): Promise<Uint8Array> {
  const raw = await readRawObject(ctx, id);
  if (raw.type !== 'tree') throw unexpectedObjectType('tree', raw.type, id);
  return raw.content;
}

async function* walkLevel(
  ctx: Context,
  bounds: FlattenBounds,
  counter: Counter,
  content: Uint8Array,
  id: ObjectId,
  prefix: string,
  depth: number,
  stack: ReadonlyArray<ObjectId>,
): AsyncGenerator<RawSubtreeEntry> {
  if (stack.includes(id)) throw treeCycleDetected(id);
  if (exceedsMaxTreeDepth(depth, bounds.maxDepth)) throw treeDepthExceeded(depth);
  const descentStack = [...stack, id];
  const cursor = openTreeCursor(content, ctx.hashConfig);
  while (!cursor.done) {
    yield* emitEntry(ctx, bounds, counter, cursor, prefix, depth, descentStack);
    advanceCursor(cursor);
  }
}

async function* emitEntry(
  ctx: Context,
  bounds: FlattenBounds,
  counter: Counter,
  cursor: TreeCursor,
  prefix: string,
  depth: number,
  stack: ReadonlyArray<ObjectId>,
): AsyncGenerator<RawSubtreeEntry> {
  if (ctx.signal?.aborted) throw operationAborted();
  const path = joinPath(prefix, cursorName(cursor));
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, bounds.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, bounds.maxEntries);
  }
  const mode = cursorMode(cursor);
  const id = cursorOid(cursor);
  if (mode !== FILE_MODE.DIRECTORY) {
    yield { path, id, mode };
    return;
  }
  const raw = await readRawObject(ctx, id);
  if (raw.type !== 'tree') return;
  yield* walkLevel(ctx, bounds, counter, raw.content, id, path, depth + 1, stack);
}

function joinPath(prefix: string, name: string): FilePath {
  return (prefix === '' ? name : `${prefix}/${name}`) as FilePath;
}
