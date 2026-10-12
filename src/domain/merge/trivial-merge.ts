/**
 * git's "really trivial in-index merge" (`read_tree_trivial`): `threeway_merge`
 * without `--aggressive`, over a single merge base, failing as soon as one path
 * would need a file-level merge.
 */
import type { FlatTreeEntry } from '../diff/flat-tree.js';
import type { FilePath } from '../objects/index.js';

type FlatEntries = ReadonlyMap<FilePath, FlatTreeEntry>;
type Entry = FlatTreeEntry | undefined;

/** `unpack-trees`' `same`: both absent, or the same object in the same mode. */
const same = (a: Entry, b: Entry): boolean =>
  a === undefined || b === undefined ? a === b : a.id === b.id && a.mode === b.mode;

/** One path's trivial outcome: the entry kept, or `undefined` when it needs a file-level merge. */
const resolvePath = (base: Entry, head: Entry, remote: Entry): Entry => {
  if (same(base, head) && !same(base, remote)) return remote;
  if (same(head, remote)) return head;
  return same(base, remote) && !same(base, head) ? head : undefined;
};

/** A file path that is also a directory of another path: a directory/file clash. */
const clashes = (paths: ReadonlyArray<FilePath>): boolean => {
  const directories = new Set<string>();
  for (const path of paths) {
    // Stryker disable next-line StringLiteral: equivalent — searching '' first records '' as a directory, which no non-empty tree path equals, and the next search from 1 finds the same slashes
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      directories.add(path.slice(0, at));
    }
  }
  return paths.some((path) => directories.has(path));
};

/** The merged entries, or `undefined` when any path needs more than a trivial merge. */
export const trivialMerge = (
  base: FlatEntries,
  ours: FlatEntries,
  theirs: FlatEntries,
): ReadonlyMap<FilePath, FlatTreeEntry> | undefined => {
  const merged = new Map<FilePath, FlatTreeEntry>();
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const kept = resolvePath(base.get(path), ours.get(path), theirs.get(path));
    if (kept === undefined) return undefined;
    merged.set(path, kept);
  }
  return clashes([...merged.keys()]) ? undefined : merged;
};
