import { type BinaryOverride, pairIsBinary } from './binary-decision.js';
import type { DiffChange } from './diff-change.js';
import { diffLines, type LineDiff, type LineHunk } from './line-diff.js';
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
  /** Override the binary-vs-text decision for the numstat surface. `'binary'` ⇒
   *  `{ added: 0, deleted: 0, binary: true }`; `'text'` ⇒ count lines even over NUL;
   *  `undefined` ⇒ today's `isBinary` content-sniff. */
  readonly numstatBinaryOverride?: 'binary' | 'text';
}

const LF = 0x0a;

/**
 * git's `count_lines`: the number of LF bytes, plus one more when the
 * content is non-empty and does not itself end with LF (an unterminated
 * last line still counts). Empty content is zero lines.
 */
function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lineFeeds = 0;
  for (const byte of bytes) {
    if (byte === LF) lineFeeds++;
  }
  return bytes[bytes.length - 1] === LF ? lineFeeds : lineFeeds + 1;
}

/**
 * Stat fields for a kept-broken modify — git's `complete_rewrite` path.
 * `-B` classified the pair as a rewrite that stayed broken, so numstat
 * reports the WHOLE file as removed-and-added: no line diff runs, and
 * neither line-key normalization nor blank-line suppression apply (git
 * skips xdiff entirely for a complete rewrite). A binary side still wins
 * over the rewrite counts, matching `computeStatFields`.
 */
export const computeRewriteStatFields = (
  old: Uint8Array,
  next: Uint8Array,
  override?: BinaryOverride,
): StatFields => {
  if (pairIsBinary(old, next, override)) {
    return { added: 0, deleted: 0, binary: true };
  }
  return { added: countLines(next), deleted: countLines(old), binary: false };
};

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
  const override: BinaryOverride | undefined = options?.numstatBinaryOverride;
  if (pairIsBinary(old, next, override)) {
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
