import type { ObjectId, TreeEntry } from '../../../../domain/objects/index.js';
import { FILE_MODE } from '../../../../domain/objects/index.js';
import {
  matchesDotgitAlias,
  namesGitmodules,
} from '../../../../domain/objects/tree-entry-bytes.js';
import type { CachedGitObject } from './object-cache.js';

/** The two filenames whose blobs fsck checks for content. */
export type SpecialBlobName = '.gitmodules' | '.gitattributes';

/**
 * The special filename git's `fsck_tree` queues `entry`'s blob under: a name
 * that reads as `.gitmodules` or `.gitattributes` through git's HFS and NTFS
 * alias folds — matched on raw bytes, never the decoded `name`. A symlink is
 * never queued: git reports it as a symlink instead.
 */
function specialBlobName(entry: TreeEntry): SpecialBlobName | undefined {
  if (entry.mode === FILE_MODE.SYMLINK) return undefined;
  const { nameBytes } = entry;
  if (namesGitmodules(nameBytes, 0, nameBytes.length)) return '.gitmodules';
  if (matchesDotgitAlias(nameBytes, 0, nameBytes.length, 'gitattributes')) return '.gitattributes';
  return undefined;
}

/**
 * git's `gitmodules_found`/`gitmodules_done` pair (and its `.gitattributes`
 * twin), in the order fsck meets objects: a checked tree queues every blob it
 * names under a special filename; a blob met while queued is checked in place
 * and marked done; whatever stays queued-but-not-done is checked at the end.
 * Scoped to one fsck run.
 */
export interface SpecialBlobLedger {
  /** Queue the special blobs a just-checked tree names. */
  readonly noteTree: (id: ObjectId) => void;
  /** The special filename `id` is queued under, if any. */
  readonly queuedName: (id: ObjectId) => SpecialBlobName | undefined;
  /** Record that `id`'s content check has run. */
  readonly markDone: (id: ObjectId) => void;
  /** Every queued blob whose content check never ran, with its filename. */
  readonly pending: () => ReadonlyMap<ObjectId, SpecialBlobName>;
}

/** A ledger reading each checked tree's entries from fsck's object cache. */
export function createSpecialBlobLedger(
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
): SpecialBlobLedger {
  const found = new Map<ObjectId, SpecialBlobName>();
  const done = new Set<ObjectId>();
  return {
    noteTree: (id) => {
      const tree = objectCache.get(id);
      if (tree?.type !== 'tree') return;
      for (const entry of tree.entries) {
        const name = specialBlobName(entry);
        if (name !== undefined) found.set(entry.id, name);
      }
    },
    queuedName: (id) => found.get(id),
    markDone: (id) => {
      done.add(id);
    },
    pending: () => new Map([...found].filter(([id]) => !done.has(id))),
  };
}
