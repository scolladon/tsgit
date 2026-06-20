import type { DiffChange } from './diff-change.js';
import { diffLines, isBinary, type LineDiff, type LineHunk } from './line-diff.js';
import { isBlankLine, type LineKey, NONE_KEY } from './whitespace.js';

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

/** Options for `computeStatFields` controlling line normalization and blank suppression. */
export interface StatFieldsOptions {
  readonly lineKey?: LineKey;
  readonly ignoreBlankLines?: boolean;
}

function hunkHasNonBlank(diff: LineDiff, hunk: LineHunk, key: LineKey): boolean {
  if (hunk.kind === 'ours-only') {
    for (let i = hunk.oursStart; i < hunk.oursEnd; i++) {
      if (!isBlankLine(diff.oursLines[i]!, key)) return true;
    }
    return false;
  }
  for (let i = hunk.theirsStart; i < hunk.theirsEnd; i++) {
    if (!isBlankLine(diff.theirsLines[i]!, key)) return true;
  }
  return false;
}

function hunkContributesToAdded(
  diff: LineDiff,
  hunk: LineHunk,
  blankKey: LineKey | undefined,
): number {
  if (hunk.kind !== 'theirs-only') return 0;
  if (blankKey !== undefined && !hunkHasNonBlank(diff, hunk, blankKey)) return 0;
  return hunk.theirsEnd - hunk.theirsStart;
}

function hunkContributesToDeleted(
  diff: LineDiff,
  hunk: LineHunk,
  blankKey: LineKey | undefined,
): number {
  if (hunk.kind !== 'ours-only') return 0;
  if (blankKey !== undefined && !hunkHasNonBlank(diff, hunk, blankKey)) return 0;
  return hunk.oursEnd - hunk.oursStart;
}

/**
 * Count added/deleted lines between two blob contents. A binary side short-
 * circuits to `{ 0, 0, binary: true }`; otherwise added lines are the
 * theirs-only hunks and deleted lines the ours-only hunks of the line diff
 * (`old` is ours, `next` is theirs).
 *
 * When `options.lineKey` is set the line-equality is whitespace-normalized.
 * When `options.ignoreBlankLines` is true, hunks whose lines are all blank
 * (empty after the active line-key normalization) do not contribute to counts.
 */
export const computeStatFields = (
  old: Uint8Array,
  next: Uint8Array,
  options?: StatFieldsOptions,
): StatFields => {
  if (isBinary(old) || isBinary(next)) {
    return { added: 0, deleted: 0, binary: true };
  }
  const lineKey = options?.lineKey;
  const diff = diffLines(old, next, lineKey !== undefined ? { lineKey } : undefined);
  const blankKey = options?.ignoreBlankLines === true ? (lineKey ?? NONE_KEY) : undefined;
  let added = 0;
  let deleted = 0;
  for (const hunk of diff.hunks) {
    added += hunkContributesToAdded(diff, hunk, blankKey);
    deleted += hunkContributesToDeleted(diff, hunk, blankKey);
  }
  return { added, deleted, binary: false };
};
