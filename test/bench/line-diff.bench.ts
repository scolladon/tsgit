/**
 * Bench: pure line-diff domain hot paths — `diffLines`/`diffPresplitLines`
 * (src/domain/diff/line-diff.ts), `computeHunks` (patch-serializer.ts) and
 * `mergeContent` (three-way-content.ts). No fixture, no `git`: every input
 * is built once at module load from a seeded xorshift (reusing
 * fixture-generator's `makeXorshift32`) and encoded to `Uint8Array`. The
 * xdiff engine parts and the typed-fingerprint parts diff their own timing
 * against these medians.
 */
import { diffLines, diffPresplitLines, splitLines } from '../../src/domain/diff/line-diff.js';
import { computeHunks } from '../../src/domain/diff/patch-serializer.js';
import { mergeContent } from '../../src/domain/merge/three-way-content.js';
import { benchScenario } from './support/bench-dsl.js';
import { makeXorshift32 } from './support/fixture-generator.js';

const enc = new TextEncoder();

const SMALL_LINE_COUNT = 200;
const SMALL_EDIT_COUNT = 3;
const MEDIUM_LINE_COUNT = 5_000;
const MEDIUM_EDIT_COUNT = 20;
const LARGE_LINE_COUNT = 50_000;
const LARGE_EDIT_RATE = 0.01;
const MERGE_BASE_LINE_COUNT = 300;
const MERGE_OURS_START = 0;
const MERGE_OURS_END = 100;
const MERGE_THEIRS_START = 150;
const MERGE_THEIRS_END = 300;
const PATCH_CONTEXT_LINES = 3;

// Distinct per scenario purely for readability — determinism does not
// require it (each seed already keys its own closure-local xorshift state),
// mirroring fixture-generator's per-shape seed constants.
const SMALL_BASE_SEED = 10;
const SMALL_EDIT_SEED = 11;
const MEDIUM_BASE_SEED = 20;
const MEDIUM_EDIT_SEED = 21;
const LARGE_BASE_SEED = 30;
const LARGE_EDIT_SEED = 31;
const MERGE_BASE_SEED = 40;
const MERGE_OURS_SEED = 41;
const MERGE_THEIRS_SEED = 42;

/** `count` lines of high-entropy, reproducible text, advancing one closure-local xorshift call per line. */
const buildLines = (count: number, seed: number): readonly string[] => {
  const next = makeXorshift32(seed);
  return Array.from({ length: count }, (_, i) => `line ${i} ${next().toString(16)}\n`);
};

/** Rewrites `editCount` pseudo-random lines (scattered, may repeat an index) — mirrors `flipFewBytes`'s scatter pattern for line-granular content. */
const withScatteredEdits = (
  lines: readonly string[],
  editCount: number,
  seed: number,
): readonly string[] => {
  const next = makeXorshift32(seed);
  const edited = [...lines];
  for (let i = 0; i < editCount; i += 1) {
    const index = next() % edited.length;
    edited[index] = `edited ${index} ${next().toString(16)}\n`;
  }
  return edited;
};

/** Rewrites every line in `[start, end)` — a contiguous edited region, for pairing two disjoint-region edits of the same base without an overlap. */
const withRegionEdit = (
  lines: readonly string[],
  start: number,
  end: number,
  seed: number,
): readonly string[] => {
  const next = makeXorshift32(seed);
  const edited = [...lines];
  for (let i = start; i < end; i += 1) edited[i] = `merged ${i} ${next().toString(16)}\n`;
  return edited;
};

const toBytes = (lines: readonly string[]): Uint8Array => enc.encode(lines.join(''));

const smallBase = buildLines(SMALL_LINE_COUNT, SMALL_BASE_SEED);
const smallOursBytes = toBytes(smallBase);
const smallTheirsBytes = toBytes(withScatteredEdits(smallBase, SMALL_EDIT_COUNT, SMALL_EDIT_SEED));

const mediumBase = buildLines(MEDIUM_LINE_COUNT, MEDIUM_BASE_SEED);
const mediumOursBytes = toBytes(mediumBase);
const mediumTheirsBytes = toBytes(
  withScatteredEdits(mediumBase, MEDIUM_EDIT_COUNT, MEDIUM_EDIT_SEED),
);
const mediumOursLines = splitLines(mediumOursBytes);
const mediumTheirsLines = splitLines(mediumTheirsBytes);

const largeEditCount = Math.round(LARGE_LINE_COUNT * LARGE_EDIT_RATE);
const largeBase = buildLines(LARGE_LINE_COUNT, LARGE_BASE_SEED);
const largeOursBytes = toBytes(largeBase);
const largeTheirsBytes = toBytes(withScatteredEdits(largeBase, largeEditCount, LARGE_EDIT_SEED));

const mergeBase = buildLines(MERGE_BASE_LINE_COUNT, MERGE_BASE_SEED);
const mergeBaseBytes = toBytes(mergeBase);
const mergeOursBytes = toBytes(
  withRegionEdit(mergeBase, MERGE_OURS_START, MERGE_OURS_END, MERGE_OURS_SEED),
);
const mergeTheirsBytes = toBytes(
  withRegionEdit(mergeBase, MERGE_THEIRS_START, MERGE_THEIRS_END, MERGE_THEIRS_SEED),
);

benchScenario(
  `Given ${SMALL_LINE_COUNT} lines with ${SMALL_EDIT_COUNT} lines edited`,
  'When diffLines compares them, Then measure tsgit',
  () => ({
    sut: (): void => {
      diffLines(smallOursBytes, smallTheirsBytes);
    },
  }),
);

benchScenario(
  `Given ${MEDIUM_LINE_COUNT} lines with ${MEDIUM_EDIT_COUNT} scattered edits`,
  'When diffLines compares them, Then measure tsgit',
  () => ({
    sut: (): void => {
      diffLines(mediumOursBytes, mediumTheirsBytes);
    },
  }),
);

benchScenario(
  `Given ${MEDIUM_LINE_COUNT} lines with ${MEDIUM_EDIT_COUNT} scattered edits`,
  `When computeHunks builds a ${PATCH_CONTEXT_LINES}-line-context patch from them, Then measure tsgit`,
  () => ({
    sut: (): void => {
      computeHunks(mediumOursBytes, mediumTheirsBytes, PATCH_CONTEXT_LINES);
    },
  }),
);

benchScenario(
  `Given ${MEDIUM_LINE_COUNT} lines with ${MEDIUM_EDIT_COUNT} scattered edits, pre-split`,
  "When diffPresplitLines compares blame's already-split pair, Then measure tsgit",
  () => ({
    sut: (): void => {
      diffPresplitLines(mediumOursLines, mediumTheirsLines);
    },
  }),
);

benchScenario(
  `Given a ${MERGE_BASE_LINE_COUNT}-line base with ours and theirs editing disjoint regions`,
  'When mergeContent three-way-merges them, Then measure tsgit',
  () => ({
    sut: (): void => {
      mergeContent(mergeBaseBytes, mergeOursBytes, mergeTheirsBytes);
    },
  }),
);

benchScenario(
  `Given ${LARGE_LINE_COUNT} lines with ${(LARGE_EDIT_RATE * 100).toFixed(0)}% of lines rewritten`,
  'When diffLines compares them, Then measure tsgit',
  () => ({
    sut: (): void => {
      diffLines(largeOursBytes, largeTheirsBytes);
    },
  }),
);
