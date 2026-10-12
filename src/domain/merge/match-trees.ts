// Transcribes git's match-trees.c (git 2.55.0): `score_trees`, `match_trees`,
// `shift_tree` and `shift_tree_by`. The domain only decides the shift; the
// caller reads the trees (through `TreeLister`) and applies it, so no object
// is read or written here. An absent tree is git's empty tree.
import { FILE_MODE, type FileMode, type ObjectId, type TreeEntry } from '../objects/index.js';
import { treeEntryCompare } from '../objects/tree.js';

/** Lists a tree's entries in tree order; `undefined` stands for the empty tree. */
export type TreeLister = (id: ObjectId | undefined) => Promise<ReadonlyArray<TreeEntry>>;

/** How to move the second tree so it lines up with the first. */
export type TreeShift =
  | { readonly kind: 'none' }
  /** Splice the second tree into the first at `prefix`. */
  | { readonly kind: 'add'; readonly prefix: string }
  /** Take the second tree's subtree at `prefix`. */
  | { readonly kind: 'remove'; readonly prefix: string };

const NO_SHIFT: TreeShift = { kind: 'none' };
const DEFAULT_DEPTH_LIMIT = 2;

const isDir = (mode: FileMode): boolean => mode === FILE_MODE.DIRECTORY;
const isLink = (mode: FileMode): boolean => mode === FILE_MODE.SYMLINK;

function scoreMissing(mode: FileMode): number {
  if (isDir(mode)) return -1000;
  return isLink(mode) ? -500 : -50;
}

// Tree order sorts a directory as `name/`, so a paired entry never mixes a
// directory with a non-directory: git's directory-mismatch scores are unreachable.
function scoreDiffers(a: FileMode, b: FileMode): number {
  return isLink(a) !== isLink(b) ? -50 : -5;
}

function scoreMatches(a: FileMode, b: FileMode): number {
  if (isLink(a) !== isLink(b)) return -50;
  if (isDir(a)) return 1000;
  return isLink(a) ? 500 : 250;
}

function scorePair(one: TreeEntry, two: TreeEntry): number {
  return one.id === two.id ? scoreMatches(one.mode, two.mode) : scoreDiffers(one.mode, two.mode);
}

/** match-trees.c's `score_trees`: how alike two trees' top-level entries are. */
export async function scoreTrees(
  list: TreeLister,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
): Promise<number> {
  const [a, b] = await Promise.all([list(one), list(two)]);
  let score = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const cmp = i >= a.length ? 1 : j >= b.length ? -1 : treeEntryCompare(a[i]!, b[j]!);
    if (cmp < 0) score += scoreMissing(a[i++]!.mode);
    else if (cmp > 0) score += scoreMissing(b[j++]!.mode);
    else score += scorePair(a[i++]!, b[j++]!);
  }
  return score;
}

interface BestMatch {
  score: number;
  path: string;
}

/** match-trees.c's `match_trees`: the subtree of `one` most like `two`, depth-first. */
async function matchTrees(
  list: TreeLister,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
  scope: { readonly best: BestMatch; readonly base: string; readonly limit: number },
): Promise<void> {
  for (const entry of await list(one)) {
    if (!isDir(entry.mode)) continue;
    const score = await scoreTrees(list, entry.id, two);
    if (scope.best.score < score) {
      scope.best.path = `${scope.base}${entry.name}`;
      scope.best.score = score;
    }
    if (scope.limit === 0) continue;
    const base = `${scope.base}${entry.name}/`;
    await matchTrees(list, entry.id, two, { best: scope.best, base, limit: scope.limit - 1 });
  }
}

/** match-trees.c's `shift_tree`: guesses the prefix that lines `two` up with `one`. */
export async function shiftTree(
  list: TreeLister,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
): Promise<TreeShift> {
  const initial = await scoreTrees(list, one, two);
  const add: BestMatch = { score: initial, path: '' };
  // Stryker disable next-line StringLiteral: equivalent — del.path is read only once del.score beats add.score >= initial, and matchTrees overwrites the path whenever it raises the score
  const del: BestMatch = { score: initial, path: '' };
  await matchTrees(list, one, two, { best: add, base: '', limit: DEFAULT_DEPTH_LIMIT });
  await matchTrees(list, two, one, { best: del, base: '', limit: DEFAULT_DEPTH_LIMIT });
  // del only beats add after improving on the initial score, so it then holds a prefix.
  if (add.score < del.score) return { kind: 'remove', prefix: del.path };
  return add.path === '' ? NO_SHIFT : { kind: 'add', prefix: add.path };
}

/** git's `get_tree_entry` for a directory: the subtree at `path`, if it is one. */
async function subtreeAt(
  list: TreeLister,
  root: ObjectId | undefined,
  path: string,
): Promise<ObjectId | undefined> {
  let current = root;
  for (const name of path.split('/').filter((part) => part !== '')) {
    const entry = (await list(current)).find((candidate) => candidate.name === name);
    if (entry === undefined || !isDir(entry.mode)) return undefined;
    current = entry.id;
  }
  return current;
}

/** match-trees.c's `shift_tree_by`: shifts by the given prefix, whichever way scores better. */
export async function shiftTreeBy(
  list: TreeLister,
  one: ObjectId | undefined,
  two: ObjectId | undefined,
  prefix: string,
): Promise<TreeShift> {
  const [sub1, sub2] = await Promise.all([
    subtreeAt(list, one, prefix),
    subtreeAt(list, two, prefix),
  ]);
  if (sub1 === undefined) return sub2 === undefined ? NO_SHIFT : { kind: 'remove', prefix };
  if (sub2 === undefined) return { kind: 'add', prefix };
  const initial = await scoreTrees(list, one, two);
  const addScore = await scoreTrees(list, sub1, two);
  const removeScore = await scoreTrees(list, sub2, one);
  if (removeScore > Math.max(initial, addScore)) return { kind: 'remove', prefix };
  return addScore > initial ? { kind: 'add', prefix } : NO_SHIFT;
}
