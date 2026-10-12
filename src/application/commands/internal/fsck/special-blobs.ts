import {
  parseTreeEntriesTolerant,
  type RawTreeEntry,
} from '../../../../domain/fsck/validate-tree.js';
import { bytesToHex } from '../../../../domain/objects/encoding.js';
import type { HashConfig } from '../../../../domain/objects/hash-config.js';
import type { ObjectId } from '../../../../domain/objects/index.js';
import {
  matchesDotgitAlias,
  namesGitmodules,
} from '../../../../domain/objects/tree-entry-bytes.js';

/** The two filenames whose blobs fsck checks for content. */
export type SpecialBlobName = '.gitmodules' | '.gitattributes';

/** fsck's special filenames, in the order git's `fsck_blob` and `fsck_finish` check them. */
export const SPECIAL_BLOB_NAMES: ReadonlyArray<SpecialBlobName> = ['.gitmodules', '.gitattributes'];

const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;
const OCTAL_DIGIT_BITS = 3;

/** git's symlink test over the raw octal mode `parse_mode` accumulates — no
 *  canonicalisation, so `0120000` and `120755` read as symlinks too. */
function isSymlinkMode(mode: string): boolean {
  let bits = 0;
  for (const digit of mode) bits = (bits << OCTAL_DIGIT_BITS) + Number(digit);
  return (bits & FILE_TYPE_MASK) === SYMLINK_TYPE;
}

/**
 * The special filenames git's `fsck_tree` queues `entry`'s object under: a
 * name that reads as `.gitmodules` or `.gitattributes` through git's HFS and
 * NTFS alias folds, matched on raw bytes. A symlink is never queued: git
 * reports it as a symlink instead.
 */
function specialBlobNames(body: Uint8Array, entry: RawTreeEntry): ReadonlyArray<SpecialBlobName> {
  if (isSymlinkMode(entry.mode)) return [];
  const { nameStart, nameEnd } = entry;
  const names: SpecialBlobName[] = [];
  if (namesGitmodules(body, nameStart, nameEnd)) names.push('.gitmodules');
  if (matchesDotgitAlias(body, nameStart, nameEnd, 'gitattributes')) names.push('.gitattributes');
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
  /** Queue the special blobs a just-checked tree copy names, read from that
   *  copy's own body — git's `fsck_tree` parses every copy it checks. */
  readonly noteTree: (body: Uint8Array) => void;
  /** Every special filename `id` is queued under, in check order. */
  readonly queuedNames: (id: ObjectId) => ReadonlyArray<SpecialBlobName>;
  /** Record that `id`'s content check has run under every name it is queued under now. */
  readonly markDone: (id: ObjectId) => void;
  /** Every blob queued under `name` whose check has not run yet. */
  readonly pendingUnder: (name: SpecialBlobName) => ReadonlyArray<ObjectId>;
}

type NameSets = Readonly<Record<SpecialBlobName, Set<ObjectId>>>;

const emptyNameSets = (): NameSets => ({ '.gitmodules': new Set(), '.gitattributes': new Set() });

/** A ledger over one fsck run's tree bodies, in `hash`'s digest width. */
export function createSpecialBlobLedger(hash: HashConfig): SpecialBlobLedger {
  const found = emptyNameSets();
  const done = emptyNameSets();
  return {
    noteTree: (body) => {
      for (const entry of parseTreeEntriesTolerant(body, hash.digestLength).entries) {
        const id = bytesToHex(entry.sha) as ObjectId;
        for (const name of specialBlobNames(body, entry)) found[name].add(id);
      }
    },
    queuedNames: (id) => SPECIAL_BLOB_NAMES.filter((name) => found[name].has(id)),
    markDone: (id) => {
      for (const name of SPECIAL_BLOB_NAMES) if (found[name].has(id)) done[name].add(id);
    },
    pendingUnder: (name) => [...found[name]].filter((id) => !done[name].has(id)),
  };
}
