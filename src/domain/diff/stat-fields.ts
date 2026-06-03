import type { DiffChange } from './diff-change.js';
import { diffLines, isBinary } from './line-diff.js';

/**
 * Per-file line counts for one changed path — the data half of git's
 * `--numstat`. `binary` flags a file whose either side trips binary detection
 * (then `added`/`deleted` are zero, matching git's `-`); otherwise the counts
 * come from the line diff. The cosmetic graph (`--stat` widths, `Bin … bytes`)
 * is the caller's to render from these counts plus the blob sizes.
 */
export interface StatFields {
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
}

/** A `DiffChange` carrying its per-file line counts (populated via `withStat`). */
export type StatDiffChange = DiffChange & StatFields;

/** A tree diff whose every change carries `StatFields`. */
export interface StatTreeDiff {
  readonly changes: ReadonlyArray<StatDiffChange>;
}

/**
 * Count added/deleted lines between two blob contents. A binary side short-
 * circuits to `{ 0, 0, binary: true }`; otherwise added lines are the
 * theirs-only hunks and deleted lines the ours-only hunks of the line diff
 * (`old` is ours, `next` is theirs).
 */
export const computeStatFields = (old: Uint8Array, next: Uint8Array): StatFields => {
  if (isBinary(old) || isBinary(next)) {
    return { added: 0, deleted: 0, binary: true };
  }
  const diff = diffLines(old, next);
  let added = 0;
  let deleted = 0;
  for (const hunk of diff.hunks) {
    if (hunk.kind === 'theirs-only') added += hunk.theirsEnd - hunk.theirsStart;
    else if (hunk.kind === 'ours-only') deleted += hunk.oursEnd - hunk.oursStart;
  }
  return { added, deleted, binary: false };
};
