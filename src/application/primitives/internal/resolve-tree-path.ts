import { pathNotInTree } from '../../../domain/commands/error.js';
import type { ObjectId, Tree, TreeEntry } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { readTree } from '../read-tree.js';

/**
 * Descend a `<rev>:<path>` tree path from an already-resolved root `Tree` to the
 * entry it addresses, returning that `TreeEntry` verbatim (no blob-guard, no read
 * of the final entry). Each intermediate `/`-separated segment must be present
 * and a sub-tree; a missing segment or a non-tree intermediate refuses with
 * `PATH_NOT_IN_TREE`. The caller decides what the final entry must be (a blob,
 * for `readFileAt`; any object, for `rev-parse`'s `<tree-ish>:<path>`).
 *
 * `rev` is carried only to populate the refusal's display fields.
 */
export const descendTreePath = async (
  ctx: Context,
  rootTree: Tree,
  path: string,
  rev: string,
): Promise<TreeEntry> => {
  const entry = await findTreeEntry(ctx, rootTree, path);
  if (entry === undefined) throw pathNotInTree(rev, path);
  return entry;
};

/**
 * Descend a `/`-separated tree path from a root oid or an already-resolved
 * `Tree`, returning the addressed `TreeEntry` — or `undefined` if any segment
 * is absent or a non-final segment is not itself a tree. Carries no refusal;
 * callers that need one (`descendTreePath`) wrap the `undefined` case.
 */
export const findTreeEntry = async (
  ctx: Context,
  root: ObjectId | Tree,
  path: string,
): Promise<TreeEntry | undefined> => {
  const segments = path.split('/');
  const lastIndex = segments.length - 1;
  let current: Tree = typeof root === 'string' ? await readTree(ctx, root) : root;
  for (let i = 0; i < lastIndex; i += 1) {
    const entry = findEntry(current, segments[i] as string);
    if (entry === undefined) return undefined;
    const object = await readObject(ctx, entry.id);
    if (object.type !== 'tree') return undefined;
    current = object;
  }
  return findEntry(current, segments[lastIndex] as string);
};

const findEntry = (tree: Tree, name: string): TreeEntry | undefined =>
  tree.entries.find((candidate) => candidate.name === name);
