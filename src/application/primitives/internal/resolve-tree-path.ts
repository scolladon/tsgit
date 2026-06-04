import { pathNotInTree } from '../../../domain/commands/error.js';
import type { Tree, TreeEntry } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';

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
  const segments = path.split('/');
  const lastIndex = segments.length - 1;
  let current: Tree = rootTree;
  for (let i = 0; i < lastIndex; i += 1) {
    const entry = findEntry(current, segments[i] as string, rev, path);
    const object = await readObject(ctx, entry.id);
    if (object.type !== 'tree') throw pathNotInTree(rev, path);
    current = object;
  }
  return findEntry(current, segments[lastIndex] as string, rev, path);
};

const findEntry = (tree: Tree, name: string, rev: string, path: string): TreeEntry => {
  const entry = tree.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) throw pathNotInTree(rev, path);
  return entry;
};
