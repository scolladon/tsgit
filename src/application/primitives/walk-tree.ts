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
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
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

export async function* walkTree(
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
  options?: WalkTreeOptions,
): AsyncIterable<WalkTreeEntry> {
  const config: WalkConfig = {
    ctx,
    recursive: options?.recursive ?? true,
    maxDepth: options?.maxDepth ?? 1024,
    maxEntries: options?.maxEntries ?? MAX_FLAT_TREE_ENTRIES,
  };
  const counter: Counter = { value: 0 };
  const rootTree =
    typeof treeIdOrObject === 'string'
      ? await resolveTree(ctx, treeIdOrObject as ObjectId)
      : treeIdOrObject;
  yield* walkInternal(config, counter, rootTree, '', 0, []);
}

async function* walkInternal(
  config: WalkConfig,
  counter: Counter,
  tree: Tree,
  prefix: string,
  depth: number,
  stack: ObjectId[],
): AsyncIterable<WalkTreeEntry> {
  if (stack.includes(tree.id)) throw treeCycleDetected(tree.id);
  if (exceedsMaxTreeDepth(depth, config.maxDepth)) throw treeDepthExceeded(depth);
  const descentStack = [...stack, tree.id];
  for (const entry of tree.entries) {
    if (config.ctx.signal?.aborted) throw operationAborted();
    const path = (prefix === '' ? entry.name : `${prefix}/${entry.name}`) as FilePath;
    counter.value += 1;
    if (exceedsMaxTreeEntries(counter.value, config.maxEntries)) {
      throw treeEntryLimitExceeded(counter.value, config.maxEntries);
    }
    yield { path, id: entry.id, mode: entry.mode as FileMode };
    if (!shouldRecurse(config.recursive, entry.mode)) continue;
    const subtreeObj = await readObject(config.ctx, entry.id);
    if (subtreeObj.type === 'tree') {
      yield* walkInternal(config, counter, subtreeObj, path, depth + 1, descentStack);
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
