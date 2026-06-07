/**
 * git's `diffsize` (`range-diff.c`): the cost metric used to build the
 * assignment cost matrix — the number of lines a 3-context unified diff between
 * two texts emits (one per hunk header plus every context / `+` / `-` line). The
 * coalescing matches `diff -U3` (the same boundaries the unified-diff serializer
 * produces), so the count equals git's `xdi_diff_outf` callback total.
 */

import { diffLines } from '../diff/index.js';

const CONTEXT_LINES = 3;
/** Changes within this many lines coalesce into one hunk (`2 * ctxlen + 1`). */
const MIN_GAP = 2 * CONTEXT_LINES + 1;

const encoder = new TextEncoder();

/** One boolean per emitted diff line: `true` for a change (`+`/`-`), `false`
 *  for a context line. Order matches the unified-diff serializer's edit list. */
const changeFlags = (a: string, b: string): boolean[] => {
  const lineDiff = diffLines(encoder.encode(a), encoder.encode(b));
  const flags: boolean[] = [];
  for (const hunk of lineDiff.hunks) {
    const span =
      hunk.kind === 'theirs-only'
        ? hunk.theirsEnd - hunk.theirsStart
        : hunk.oursEnd - hunk.oursStart;
    for (let i = 0; i < span; i++) flags.push(hunk.kind !== 'common');
  }
  return flags;
};

interface Group {
  readonly first: number;
  readonly last: number;
}

const groupChanges = (flags: ReadonlyArray<boolean>): ReadonlyArray<Group> => {
  const groups: Group[] = [];
  flags.forEach((isChange, idx) => {
    if (!isChange) return;
    const last = groups[groups.length - 1];
    if (last !== undefined && idx - last.last <= MIN_GAP) {
      groups[groups.length - 1] = { first: last.first, last: idx };
    } else {
      groups.push({ first: idx, last: idx });
    }
  });
  return groups;
};

export const diffSize = (a: string, b: string): number => {
  const flags = changeFlags(a, b);
  let total = 0;
  for (const group of groupChanges(flags)) {
    const start = Math.max(0, group.first - CONTEXT_LINES);
    const end = Math.min(flags.length, group.last + CONTEXT_LINES + 1);
    total += 1 + (end - start); // one hunk header + every emitted body line
  }
  return total;
};
