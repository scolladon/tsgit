import fc from 'fast-check';
import type { BlameEntry } from '../../../../src/domain/blame/types.js';
import { diffLines, type LineDiff } from '../../../../src/domain/diff/line-diff.js';

// Small alphabets keep diffs interesting: a shared one produces common regions;
// the disjoint pair guarantees no line matches (the annihilator case).
const SHARED = ['a', 'b', 'c', 'd', 'e'];
const PARENT_ONLY = ['f', 'g', 'h', 'i', 'j'];
const CHILD_ONLY = ['k', 'l', 'm', 'n', 'o'];

const encoder = new TextEncoder();

/** Join single-token lines into a newline-terminated blob (one line per token). */
export const linesToBlob = (lines: ReadonlyArray<string>): Uint8Array =>
  encoder.encode(lines.map((line) => `${line}\n`).join(''));

const linesFrom = (alphabet: ReadonlyArray<string>): fc.Arbitrary<ReadonlyArray<string>> =>
  fc.array(fc.constantFrom(...alphabet), { minLength: 0, maxLength: 10 });

export interface SplitCase {
  readonly entries: ReadonlyArray<BlameEntry>;
  readonly lineDiff: LineDiff;
  /** Constant added to every entry's `finalStart`, decoupling it from `sourceStart`. */
  readonly finalBase: number;
}

/** Partition `[0, childLen)` into consecutive entries, splitting where the mask is set. */
const buildEntries = (
  childLen: number,
  mask: ReadonlyArray<boolean>,
  finalBase: number,
): ReadonlyArray<BlameEntry> => {
  const entries: BlameEntry[] = [];
  let start = 0;
  for (let i = 1; i <= childLen; i += 1) {
    if (i === childLen || mask[i] === true) {
      entries.push({ finalStart: finalBase + start, count: i - start, sourceStart: start });
      start = i;
    }
  }
  return entries;
};

const arbMask = (): fc.Arbitrary<ReadonlyArray<boolean>> =>
  fc.array(fc.boolean(), { maxLength: 10 });

const toCase = (
  parentLines: ReadonlyArray<string>,
  childLines: ReadonlyArray<string>,
  mask: ReadonlyArray<boolean>,
  finalBase: number,
): SplitCase => ({
  entries: buildEntries(childLines.length, mask, finalBase),
  lineDiff: diffLines(linesToBlob(parentLines), linesToBlob(childLines)),
  finalBase,
});

/** Parent and child drawn from the shared alphabet — a mix of common and changed lines. */
export const arbSplitCase = (): fc.Arbitrary<SplitCase> =>
  fc
    .tuple(linesFrom(SHARED), linesFrom(SHARED), arbMask(), fc.nat(5))
    .map(([parentLines, childLines, mask, finalBase]) =>
      toCase(parentLines, childLines, mask, finalBase),
    );

/** Child identical to parent — every line is common (identity). */
export const arbIdentityCase = (): fc.Arbitrary<SplitCase> =>
  fc
    .tuple(linesFrom(SHARED), arbMask(), fc.nat(5))
    .map(([lines, mask, finalBase]) => toCase(lines, lines, mask, finalBase));

/** Parent and child from disjoint alphabets — no line is common (annihilator). */
export const arbDisjointCase = (): fc.Arbitrary<SplitCase> =>
  fc
    .tuple(linesFrom(PARENT_ONLY), linesFrom(CHILD_ONLY), arbMask(), fc.nat(5))
    .map(([parentLines, childLines, mask, finalBase]) =>
      toCase(parentLines, childLines, mask, finalBase),
    );
