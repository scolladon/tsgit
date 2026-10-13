import type { FlatTree, FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { IndexBlobLookup } from './read-gitattributes.js';

/** merge-ort's `initialize_attr_index` reads the root file only; a nested one never governs. */
const ROOT_ATTRIBUTES = '.gitattributes' as FilePath;

const sameEntry = (a: FlatTreeEntry | undefined, b: FlatTreeEntry | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.id === b.id && a.mode === b.mode);

/**
 * The root `.gitattributes` a renormalizing merge reads: its merge result when
 * the tree merge settled it without a content merge, else the lowest stage
 * present (base, then ours) — merge-ort's attribute index quirk. A theirs-only
 * file is always settled by the first arm (both other stages absent are equal).
 */
const governingEntry = (
  base: FlatTreeEntry | undefined,
  ours: FlatTreeEntry | undefined,
  theirs: FlatTreeEntry | undefined,
): FlatTreeEntry | undefined => {
  if (sameEntry(ours, theirs) || sameEntry(base, theirs)) return ours;
  if (sameEntry(base, ours)) return theirs;
  return base ?? ours;
};

export const renormalizeAttributeLookup = (
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
): IndexBlobLookup => {
  const entry = governingEntry(
    base?.entries.get(ROOT_ATTRIBUTES),
    ours?.entries.get(ROOT_ATTRIBUTES),
    theirs?.entries.get(ROOT_ATTRIBUTES),
  );
  return (path) => (path === ROOT_ATTRIBUTES ? entry?.id : undefined);
};
