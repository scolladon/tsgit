/**
 * Order the corresponded patches into git's `range-diff` output sequence
 * (`output` in `range-diff.c`): drive by the new range, slotting deleted old
 * commits in once their predecessors are shown. Each emitted pair becomes a
 * structured `RangeDiffEntry` — status (`= ! < >`), the old/new commit position
 * + oid, the shown subject (old's when present), and, for a `changed` pair, the
 * structured diff-of-diffs (`diffLines` of the two `## ` patch texts).
 */

import { diffLines, type LineDiff } from '../diff/index.js';
import type { ObjectId } from '../objects/index.js';
import type { MatchedPatch } from './correspond.js';
import type { RenderedPatch } from './patch-text.js';

export type RangeDiffStatus = 'unchanged' | 'changed' | 'only-old' | 'only-new';

export interface RangeDiffCommit {
  /** 1-based position of the commit in its (merge-filtered, oldest-first) series. */
  readonly position: number;
  readonly id: ObjectId;
}

export interface RangeDiffEntry {
  readonly status: RangeDiffStatus;
  readonly old?: RangeDiffCommit;
  readonly new?: RangeDiffCommit;
  readonly subject: string;
  /** The diff-of-diffs (`diffLines(old.patch, new.patch)`); present iff `changed`. */
  readonly diffOfDiffs?: LineDiff;
}

const encoder = new TextEncoder();

const commit = (patch: RenderedPatch, index: number): RangeDiffCommit => ({
  position: index + 1,
  id: patch.id,
});

const deletion = (entry: MatchedPatch, index: number): RangeDiffEntry => ({
  status: 'only-old',
  old: commit(entry.patch, index),
  subject: entry.patch.subject,
});

const creation = (entry: MatchedPatch, index: number): RangeDiffEntry => ({
  status: 'only-new',
  new: commit(entry.patch, index),
  subject: entry.patch.subject,
});

const pair = (
  oldEntry: MatchedPatch,
  newEntry: MatchedPatch,
  oldIndex: number,
  newIndex: number,
): RangeDiffEntry => {
  const changed = oldEntry.patch.patch !== newEntry.patch.patch;
  return {
    status: changed ? 'changed' : 'unchanged',
    old: commit(oldEntry.patch, oldIndex),
    new: commit(newEntry.patch, newIndex),
    subject: oldEntry.patch.subject,
    ...(changed
      ? {
          diffOfDiffs: diffLines(
            encoder.encode(oldEntry.patch.patch),
            encoder.encode(newEntry.patch.patch),
          ),
        }
      : {}),
  };
};

export const interleave = (
  old: ReadonlyArray<MatchedPatch>,
  next: ReadonlyArray<MatchedPatch>,
): ReadonlyArray<RangeDiffEntry> => {
  const entries: RangeDiffEntry[] = [];
  const shown = new Array<boolean>(old.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < old.length || j < next.length) {
    while (i < old.length && shown[i]) i++;
    if (i < old.length && old[i]!.matching < 0) {
      entries.push(deletion(old[i]!, i));
      i++;
      continue;
    }
    while (j < next.length && next[j]!.matching < 0) {
      entries.push(creation(next[j]!, j));
      j++;
    }
    if (j < next.length) {
      const oldIndex = next[j]!.matching;
      entries.push(pair(old[oldIndex]!, next[j]!, oldIndex, j));
      shown[oldIndex] = true;
      j++;
    }
  }
  return entries;
};
