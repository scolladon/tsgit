import { type IndexEntry, STAGE0_FLAGS } from '../../../domain/git-index/index.js';
import {
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
  indexPathOfBytes,
  keyOfPath,
  pathBytesOf,
} from '../../../domain/git-index/index-path-key.js';
import { compareEntryPath, inOrder } from '../../../domain/git-index/index-writer.js';

const PATH_SEPARATOR = '/';
const SLASH_BYTE = 0x2f;

const zeroStat = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  uid: 0,
  gid: 0,
  fileSize: 0,
  flags: STAGE0_FLAGS,
});

/** Stage-0 entries in byte order: an index an older writer left in UTF-16 order is re-sorted. */
const stageZero = (entries: ReadonlyArray<IndexEntry>): ReadonlyArray<IndexEntry> =>
  inOrder(
    entries.filter((e) => e.flags.stage === 0),
    compareEntryPath,
  );

const sameContent = (a: IndexEntry, b: IndexEntry): boolean => a.id === b.id && a.mode === b.mode;

function* utf8AncestorKeys(path: string): Generator<IndexPathKey> {
  for (let at = path.indexOf(PATH_SEPARATOR); at !== -1; at = path.indexOf(PATH_SEPARATOR, at + 1))
    yield keyOfPath(path.slice(0, at) as IndexPath['path']);
}

function* lossyAncestorKeys(bytes: Uint8Array): Generator<IndexPathKey> {
  for (let at = bytes.indexOf(SLASH_BYTE); at !== -1; at = bytes.indexOf(SLASH_BYTE, at + 1))
    yield indexPathKey(indexPathOfBytes(bytes.subarray(0, at)));
}

/** Directory keys of an entry, cut from the raw bytes when the decoded view is lossy. */
const ancestorKeys = (entry: IndexPath): Generator<IndexPathKey> =>
  entry.pathBytes === undefined
    ? utf8AncestorKeys(entry.path)
    : lossyAncestorKeys(pathBytesOf(entry));

/** Paths a restored entry may not take: a kept new file, or a directory a kept new path lives in. */
const occupiedBy = (kept: ReadonlyArray<IndexEntry>): ((entry: IndexPath) => boolean) => {
  const files = new Set<IndexPathKey>(kept.map(indexPathKey));
  const dirs = new Set<IndexPathKey>(kept.flatMap((e) => [...ancestorKeys(e)]));
  return (entry) =>
    dirs.has(indexPathKey(entry)) || [...ancestorKeys(entry)].some((dir) => files.has(dir));
};

interface PathJoin {
  /** Every entry that survives or is a candidate for restoring, in path order. */
  readonly ordered: IndexEntry[];
  /** Entries new to the merged index. */
  readonly added: IndexEntry[];
  /** The `before` entries (members of `ordered`) whose path the merge changed or deleted. */
  readonly undone: Set<IndexEntry>;
}

/** Undoes every previous entry ordered before `now`, from `from`; returns where the join resumes. */
const undoBefore = (
  previous: ReadonlyArray<IndexEntry>,
  from: number,
  now: IndexEntry,
  undo: (entry: IndexEntry) => void,
): number => {
  let at = from;
  for (let prev = previous[at]; prev !== undefined; prev = previous[at]) {
    if (compareEntryPath(prev, now) >= 0) break;
    undo(prev);
    at++;
  }
  return at;
};

/** Merge-join of two path-ordered stage-0 runs, so no lookup table and no re-sort is needed. */
const joinByPath = (
  current: ReadonlyArray<IndexEntry>,
  previous: ReadonlyArray<IndexEntry>,
): PathJoin => {
  const ordered: IndexEntry[] = [];
  const added: IndexEntry[] = [];
  const undone = new Set<IndexEntry>();
  const undo = (entry: IndexEntry): void => {
    undone.add(entry);
    ordered.push(entry);
  };
  let old = 0;
  for (const now of current) {
    old = undoBefore(previous, old, now, undo);
    const prev = previous[old];
    if (prev === undefined || indexPathKey(prev) !== indexPathKey(now)) {
      added.push(now);
      ordered.push(now);
      continue;
    }
    old++;
    if (sameContent(now, prev)) ordered.push(now);
    else undo(prev);
  }
  for (const prev of previous.slice(old)) undo(prev);
  return { ordered, added, undone };
};

const pathOf = (entry: IndexEntry): IndexPath =>
  entry.pathBytes === undefined
    ? { path: entry.path }
    : { path: entry.path, pathBytes: entry.pathBytes };

/** The entries after the unstage, and the paths git re-adds (so invalidates in the cache-tree). */
export interface UnstageOutcome {
  readonly entries: IndexEntry[];
  readonly restagedPaths: IndexPath[];
}

/**
 * git's `unstage_changes_unless_new`: after a clean `stash apply` every path the
 * merge changed or deleted goes back to its pre-apply entry (zero stat, as
 * `make_cache_entry` builds it), while a path new to the index stays staged.
 * A restored entry that file/directory-collides with a kept new path is dropped,
 * as git's refused `add_index_entry` does.
 */
export const unstageChangesUnlessNew = (
  merged: ReadonlyArray<IndexEntry>,
  before: ReadonlyArray<IndexEntry>,
): UnstageOutcome => {
  const { ordered, added, undone } = joinByPath(stageZero(merged), stageZero(before));
  const collides = occupiedBy(added);
  const entries: IndexEntry[] = [];
  const restored: IndexPath[] = [];
  for (const entry of ordered) {
    if (!undone.has(entry)) entries.push(entry);
    else if (!collides(entry)) {
      entries.push(zeroStat(entry));
      restored.push(pathOf(entry));
    }
  }
  return { entries, restagedPaths: [...added.map(pathOf), ...restored] };
};
