import { MAX_FLAT_TREE_ENTRIES } from '../../domain/diff/index.js';
import { operationAborted } from '../../domain/error.js';
import {
  treeCycleDetected,
  treeDepthExceeded,
  treeEntryLimitExceeded,
  unexpectedObjectType,
} from '../../domain/objects/error.js';
import {
  type FileMode,
  type FilePath,
  isDirectory,
  type ObjectId,
  type Tree,
  type TreeEntry,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import { readObject } from './read-object.js';
import type { WalkTreeEntry, WalkTreeOptions } from './types.js';
import { exceedsMaxTreeDepth, exceedsMaxTreeEntries } from './validators.js';

interface WalkConfig {
  readonly ctx: Context;
  readonly recursive: boolean;
  readonly maxDepth: number;
  readonly maxEntries: number;
}

interface Counter {
  value: number;
}

/**
 * One tree entered on the explicit DFS stack: its entries plus the cursor
 * (`index`) of the next one to process. Pushed once per tree, in the same
 * place `walkInternal`'s recursive call used to happen, so the cycle and
 * depth guards below still fire exactly once per tree, not once per entry.
 */
interface WalkFrame {
  readonly entries: ReadonlyArray<TreeEntry>;
  index: number;
  readonly prefix: string;
  readonly depth: number;
  readonly ancestry: ReadonlyArray<ObjectId>;
}

/** Guard a tree on entry (cycle, then depth) and build its stack frame. */
function enterTree(
  maxDepth: number,
  tree: Tree,
  prefix: string,
  depth: number,
  ancestry: ReadonlyArray<ObjectId>,
): WalkFrame {
  if (ancestry.includes(tree.id)) throw treeCycleDetected(tree.id);
  if (exceedsMaxTreeDepth(depth, maxDepth)) throw treeDepthExceeded(depth);
  return { entries: tree.entries, index: 0, prefix, depth, ancestry: [...ancestry, tree.id] };
}

/** Build the once-per-operation {@link WalkConfig}, resolving `maxDepth` from
 * config only when the caller did not supply one. */
async function resolveWalkConfig(
  ctx: Context,
  options: WalkTreeOptions | undefined,
): Promise<WalkConfig> {
  return {
    ctx,
    recursive: options?.recursive ?? true,
    maxDepth: options?.maxDepth ?? (await resolveMaxTreeDepth(ctx)),
    maxEntries: options?.maxEntries ?? MAX_FLAT_TREE_ENTRIES,
  };
}

interface FrameStep {
  readonly path: FilePath;
  readonly entry: TreeEntry;
}

/**
 * Advance `frame` to its next entry: the abort check, the path join, and the
 * entry-count guard — everything that must happen before a value can be
 * yielded — extracted so `walkTree`'s own loop stays flat.
 */
function nextFrameEntry(config: WalkConfig, counter: Counter, frame: WalkFrame): FrameStep {
  const entry = frame.entries[frame.index]!;
  frame.index += 1;
  if (config.ctx.signal?.aborted) throw operationAborted();
  const path = (frame.prefix === '' ? entry.name : `${frame.prefix}/${entry.name}`) as FilePath;
  counter.value += 1;
  if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) {
    throw treeEntryLimitExceeded(counter.value, config.maxEntries);
  }
  return { path, entry };
}

/**
 * Lazy pre-order walk of a tree (directory before its contents), one entry
 * at a time. Descends with an explicit stack of tree frames instead of
 * recursion — depth costs an array push, not a JS/generator call frame — so
 * `maxDepth` is the only ceiling on how deep a walk can go.
 *
 * `maxDepth` defaults to `core.maxTreeDepth`, read from the repository-local
 * config (default 2048, honoured unclamped) — never from `~/.gitconfig` or
 * any other scope, which tsgit does not read for this key.
 */
export async function* walkTree(
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
  options?: WalkTreeOptions,
): AsyncIterable<WalkTreeEntry> {
  const config = await resolveWalkConfig(ctx, options);
  const counter: Counter = { value: 0 };
  const rootTree =
    typeof treeIdOrObject === 'string'
      ? await resolveTree(ctx, treeIdOrObject as ObjectId)
      : treeIdOrObject;

  const stack: WalkFrame[] = [enterTree(config.maxDepth, rootTree, '', 0, [])];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.entries.length) {
      stack.pop();
      continue;
    }
    const { path, entry } = nextFrameEntry(config, counter, frame);
    yield { path, id: entry.id, mode: entry.mode as FileMode };
    if (!shouldRecurse(config.recursive, entry.mode)) continue;
    const subtreeObj = await readObject(config.ctx, entry.id);
    if (subtreeObj.type === 'tree') {
      stack.push(enterTree(config.maxDepth, subtreeObj, path, frame.depth + 1, frame.ancestry));
    }
  }
}

function shouldRecurse(recursive: boolean, mode: string): boolean {
  if (!recursive) return false;
  // A gitlink (mode 160000) is never a directory (mode 40000), so isDirectory
  // alone already rejects it — no explicit isGitlink guard needed.
  return isDirectory(mode as FileMode);
}

async function resolveTree(ctx: Context, id: ObjectId): Promise<Tree> {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'tree') {
    throw unexpectedObjectType('tree', obj.type, id);
  }
  return obj;
}
