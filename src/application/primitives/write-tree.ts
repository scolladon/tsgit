import { MAX_FLAT_TREE_ENTRIES } from '../../domain/diff/index.js';
import { treeEntryLimitExceeded } from '../../domain/objects/error.js';
import type { ObjectId, Tree, TreeEntry } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { writeObject } from './write-object.js';

export async function writeTree(
  ctx: Context,
  entries: ReadonlyArray<TreeEntry>,
): Promise<ObjectId> {
  if (entries.length > MAX_FLAT_TREE_ENTRIES) {
    throw treeEntryLimitExceeded(entries.length, MAX_FLAT_TREE_ENTRIES);
  }
  const tree: Tree = { type: 'tree', id: '' as ObjectId, entries };
  return writeObject(ctx, tree);
}
