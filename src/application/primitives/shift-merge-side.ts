/**
 * merge-ort.c's `shift_tree_object` over flattened trees: decides the shift
 * with the domain's `match_trees` port, then re-roots the side's paths the way
 * git's `splice_tree` / `get_tree_entry` reshape its tree.
 */
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import {
  shiftTree,
  shiftTreeBy,
  type TreeLister,
  type TreeShift,
} from '../../domain/merge/match-trees.js';
import type { FilePath, ObjectId, TreeEntry } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readTree } from './read-tree.js';

const EMPTY_ENTRIES: ReadonlyArray<TreeEntry> = [];
const EMPTY_FLAT: FlatTree = { entries: new Map() };

const cachedLister = (ctx: Context): TreeLister => {
  const cache = new Map<ObjectId, Promise<ReadonlyArray<TreeEntry>>>();
  return (id) => {
    if (id === undefined) return Promise.resolve(EMPTY_ENTRIES);
    let listed = cache.get(id);
    if (listed === undefined) {
      listed = readTree(ctx, id).then((tree) => tree.entries);
      cache.set(id, listed);
    }
    return listed;
  };
};

const normalizedPrefix = (prefix: string): string =>
  prefix
    .split('/')
    .filter((part) => part !== '')
    .join('/');

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/** git's `splice_tree`: ours, with the side's whole tree standing at `prefix`. */
function spliced(ours: FlatTree, side: FlatTree, prefix: string): FlatTree {
  const kept = [...ours.entries].filter(([path]) => !isUnder(path, prefix));
  const moved = [...side.entries].map(([path, entry]): [FilePath, FlatTreeEntry] => [
    `${prefix}/${path}` as FilePath,
    entry,
  ]);
  return { entries: new Map([...kept, ...moved]) };
}

/** git's `get_tree_entry`: the side's subtree at `prefix`, re-rooted. */
function extracted(side: FlatTree, prefix: string): FlatTree {
  const inside = [...side.entries].filter(([path]) => path.startsWith(`${prefix}/`));
  return {
    entries: new Map(
      inside.map(([path, entry]): [FilePath, FlatTreeEntry] => [
        path.slice(prefix.length + 1) as FilePath,
        entry,
      ]),
    ),
  };
}

function applyShift<Side extends FlatTree | undefined>(
  shift: TreeShift,
  ours: FlatTree,
  side: Side,
): FlatTree | Side {
  if (shift.kind === 'none') return side;
  const prefix = normalizedPrefix(shift.prefix);
  if (shift.kind === 'add') return spliced(ours, side ?? EMPTY_FLAT, prefix);
  return extracted(side ?? EMPTY_FLAT, prefix);
}

export interface ShiftableTree<Side extends FlatTree | undefined> {
  readonly tree: ObjectId | undefined;
  readonly flat: Side;
}

/**
 * Lines `side` up with `ours` for `-X subtree[=<path>]`: an empty
 * `subtreeShift` guesses the prefix (`shift_tree`), any other shifts by it
 * (`shift_tree_by`). An absent side tree is git's empty tree.
 */
export const shiftMergeSide = async <Side extends FlatTree | undefined>(
  ctx: Context,
  ours: { readonly tree: ObjectId; readonly flat: FlatTree },
  side: ShiftableTree<Side>,
  subtreeShift: string,
): Promise<FlatTree | Side> => {
  const list = cachedLister(ctx);
  const shift =
    subtreeShift === ''
      ? await shiftTree(list, ours.tree, side.tree)
      : await shiftTreeBy(list, ours.tree, side.tree, subtreeShift);
  return applyShift(shift, ours.flat, side.flat);
};
