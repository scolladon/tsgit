import type { ObjectId, TreeEntry } from '../../../../domain/objects/index.js';
import { FILE_MODE } from '../../../../domain/objects/index.js';
import {
  matchesDotgitAlias,
  namesGitmodules,
} from '../../../../domain/objects/tree-entry-bytes.js';
import type { CachedGitObject } from './object-cache.js';

/** The two filenames whose blobs fsck checks for content. */
export type SpecialBlobName = '.gitmodules' | '.gitattributes';

/** fsck's special filenames, in the order git's `fsck_blob` and `fsck_finish` check them. */
export const SPECIAL_BLOB_NAMES: ReadonlyArray<SpecialBlobName> = ['.gitmodules', '.gitattributes'];

/**
 * The special filenames git's `fsck_tree` queues `entry`'s blob under: a name
 * that reads as `.gitmodules` or `.gitattributes` through git's HFS and NTFS
 * alias folds — matched on raw bytes, never the decoded `name`. A symlink is
 * never queued: git reports it as a symlink instead.
 */
function specialBlobNames(entry: TreeEntry): ReadonlyArray<SpecialBlobName> {
  if (entry.mode === FILE_MODE.SYMLINK) return [];
  const { nameBytes } = entry;
  const names: SpecialBlobName[] = [];
  if (namesGitmodules(nameBytes, 0, nameBytes.length)) names.push('.gitmodules');
  if (matchesDotgitAlias(nameBytes, 0, nameBytes.length, 'gitattributes')) {
    names.push('.gitattributes');
  }
  return names;
}

/**
 * git's `gitmodules_found`/`gitmodules_done` pair and its `.gitattributes`
 * twin, in the order fsck meets objects: a checked tree queues every blob it
 * names under a special filename — under both, when trees disagree; a blob
 * met while queued is checked in place under every name and marked done for
 * all of them; whatever stays queued-but-not-done is checked at the end, one
 * name after the other. Scoped to one fsck run.
 */
export interface SpecialBlobLedger {
  /** Queue the special blobs a just-checked tree names. */
  readonly noteTree: (id: ObjectId) => void;
  /** Every special filename `id` is queued under, in check order. */
  readonly queuedNames: (id: ObjectId) => ReadonlyArray<SpecialBlobName>;
  /** Record that `id`'s content check has run under every name it is queued under now. */
  readonly markDone: (id: ObjectId) => void;
  /** Every blob queued under `name` whose check has not run yet. */
  readonly pendingUnder: (name: SpecialBlobName) => ReadonlyArray<ObjectId>;
}

type NameSets = Readonly<Record<SpecialBlobName, Set<ObjectId>>>;

const emptyNameSets = (): NameSets => ({ '.gitmodules': new Set(), '.gitattributes': new Set() });

/** A ledger reading each checked tree's entries from fsck's object cache. */
export function createSpecialBlobLedger(
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): SpecialBlobLedger {
  const found = emptyNameSets();
  const done = emptyNameSets();
  return {
    noteTree: (id) => {
      const tree = objectCache.get(id);
      if (tree?.type !== 'tree') return;
      for (const entry of tree.entries) {
        for (const name of specialBlobNames(entry)) found[name].add(entry.id);
      }
    },
    queuedNames: (id) => SPECIAL_BLOB_NAMES.filter((name) => found[name].has(id)),
    markDone: (id) => {
      for (const name of SPECIAL_BLOB_NAMES) if (found[name].has(id)) done[name].add(id);
    },
    pendingUnder: (name) => [...found[name]].filter((id) => !done[name].has(id)),
  };
}
