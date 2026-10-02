import { bytesEqual, encode } from '../../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import type { CachedGitObject } from './object-cache.js';

/** The two filenames whose blobs fsck checks for content. */
export type SpecialBlobName = '.gitmodules' | '.gitattributes';

const GITMODULES_NAME_BYTES = encode('.gitmodules');
const GITATTRIBUTES_NAME_BYTES = encode('.gitattributes');

/**
 * The special filename `nameBytes` matches, when it matches one of fsck's
 * two dedicated blob-content checks. Compares raw bytes — never the entry's
 * decoded `name` — so a byte sequence that merely decodes to one of these
 * literals is never mistaken for it.
 */
function specialBlobName(nameBytes: Uint8Array): SpecialBlobName | undefined {
  if (bytesEqual(nameBytes, GITMODULES_NAME_BYTES)) return '.gitmodules';
  if (bytesEqual(nameBytes, GITATTRIBUTES_NAME_BYTES)) return '.gitattributes';
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
        const name = specialBlobName(entry.nameBytes);
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
