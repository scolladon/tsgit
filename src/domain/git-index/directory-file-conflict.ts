import { encode } from '../objects/encoding.js';
import type { FilePath } from '../objects/index.js';
import type { IndexEntry } from './index-entry.js';
import { hasBytePrefix, type IndexPathKey, isLossy, keyOfPath } from './index-path-key.js';
import { compareEntryPath } from './index-writer.js';

const SEPARATOR = '/';

const lowerBound = (sorted: ReadonlyArray<IndexEntry>, probe: { readonly path: FilePath }) => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareEntryPath(sorted[middle] as IndexEntry, probe) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
};

const beneathPredicate = (path: FilePath): ((entry: IndexEntry) => boolean) => {
  const directory = `${path}${SEPARATOR}`;
  const directoryBytes = encode(path);
  return (entry) =>
    isLossy(entry)
      ? hasBytePrefix(entry.pathBytes as Uint8Array, directoryBytes)
      : entry.path.startsWith(directory);
};

const firstBeneath = (sorted: ReadonlyArray<IndexEntry>, path: FilePath): number =>
  lowerBound(sorted, { path: `${path}${SEPARATOR}` as FilePath });

/** Entries beneath path/ (every stage), in index order; `sorted` is in index order. */
export const entriesBeneath = (
  sorted: ReadonlyArray<IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry> => {
  const isBeneath = beneathPredicate(path);
  const first = firstBeneath(sorted, path);
  let end = first;
  while (end < sorted.length && isBeneath(sorted[end] as IndexEntry)) end++;
  return sorted.slice(first, end);
};

/** Whether any entry lies beneath path/: a single lookup, for callers that only need the answer. */
export const hasEntryBeneath = (sorted: ReadonlyArray<IndexEntry>, path: FilePath): boolean => {
  const first = sorted[firstBeneath(sorted, path)];
  return first !== undefined && beneathPredicate(path)(first);
};

/** Stage-0 entries at a leading directory of `path` (`a` and a/x for a/x/y). */
export const entriesAtLeadingDirectories = (
  byKey: ReadonlyMap<IndexPathKey, IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry> => {
  const found: IndexEntry[] = [];
  for (let at = path.indexOf(SEPARATOR); at !== -1; at = path.indexOf(SEPARATOR, at + 1)) {
    const entry = byKey.get(keyOfPath(path.slice(0, at) as FilePath));
    if (entry?.flags.stage === 0) found.push(entry);
  }
  return found;
};
