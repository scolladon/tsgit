import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FILE_MODE } from '../objects/index.js';
import type { AddChange } from './diff-change.js';
import { kindOf } from './mode-kind.js';
import { sortByPath } from './path-compare.js';
import { MAX_SCORE } from './similarity.js';

// git's find_identical_files examines at most this many eligible candidates per destination.
const EXACT_CANDIDATE_CAP = 100;

// A candidate that is both unused and basename-matching stops the scan immediately.
const PERFECT_CANDIDATE_SCORE = 2;

export type SourceOrigin = 'deleted' | 'broken-delete' | 'modified' | 'unchanged';

export interface RenameSource {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
  readonly origin: SourceOrigin;
  /** git's initial rename_used: 0 for a fresh source, 1 for one already spent on a preimage. */
  readonly seedUses: 0 | 1;
}

export interface SourcePair {
  readonly source: number;
  readonly destination: AddChange;
  readonly score: number;
}

/** One candidate's rank inputs for git's matrix ordering (`score_compare`). */
export interface RankedCandidate {
  readonly score: number;
  /** 1 when the candidate's source and destination share a basename, else 0. */
  readonly nameScore: 0 | 1;
}

/**
 * git's `score_compare`: orders candidates score-descending, then
 * nameScore-descending on a score tie. A negative result means `a` ranks
 * ahead of `b`; 0 means neither outranks the other.
 */
export function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  return a.score === b.score ? b.nameScore - a.nameScore : b.score - a.score;
}

export interface ExactPairing {
  /** Every pair scores MAX_SCORE — the exact pass only ever pairs identical content. */
  readonly pairs: ReadonlyArray<SourcePair>;
  /** Destinations no eligible source claimed, in input order. */
  readonly unpaired: ReadonlyArray<AddChange>;
  /** Per source index: seedUses plus every pair naming it. */
  readonly uses: ReadonlyArray<number>;
}

type PairingMode = 'rename' | 'copy';

// Regular files pair across the executable bit, so both key as REGULAR; every
// other mode pairs only with itself.
function exactKey(id: ObjectId, mode: FileMode): string {
  return `${id} ${kindOf(mode) === 'file' ? FILE_MODE.REGULAR : mode}`;
}

// Last path segment; 'a/Foo' and 'Foo' share basename 'Foo'.
export function basenameOf(filePath: FilePath): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

// 'Foo' ≡ 'b/Foo', 'xFoo' ≢ 'Foo' (git's basename_same).
export function hasSameBasename(oldPath: FilePath, newPath: FilePath): boolean {
  return basenameOf(oldPath) === basenameOf(newPath);
}

/** Groups item indexes by a derived basename key, in the order visited. */
function indexByBasename<T>(
  items: ReadonlyArray<T>,
  basenameOfItem: (item: T) => string,
): ReadonlyMap<string, number[]> {
  const byBasename = new Map<string, number[]>();
  items.forEach((item, index) => {
    const basename = basenameOfItem(item);
    const group = byBasename.get(basename);
    if (group === undefined) byBasename.set(basename, [index]);
    else group.push(index);
  });
  return byBasename;
}

export interface BasenamePair {
  readonly source: number;
  readonly destination: number;
}

/**
 * git's find_basename_matches candidate set (`-M` only): pairs a source with
 * the destination sharing its basename, but only when that basename occurs
 * EXACTLY ONCE on each side — every mode counts toward uniqueness (a symlink
 * sharing a basename makes it non-unique), so this stays pure and byte-free.
 * Returned in source order; scoring the pairs is the primitive's job.
 */
export function uniqueBasenamePairs(
  sources: ReadonlyArray<RenameSource>,
  destinations: ReadonlyArray<AddChange>,
): ReadonlyArray<BasenamePair> {
  const sourcesByBasename = indexByBasename(sources, (source) => basenameOf(source.path));
  const destinationsByBasename = indexByBasename(destinations, (dest) => basenameOf(dest.newPath));
  const pairs: BasenamePair[] = [];

  sources.forEach((source, index) => {
    const basename = basenameOf(source.path);
    const sourceGroup = sourcesByBasename.get(basename) as number[];
    if (sourceGroup.length !== 1) return;
    const destinationGroup = destinationsByBasename.get(basename);
    if (destinationGroup === undefined || destinationGroup.length !== 1) return;
    pairs.push({ source: index, destination: destinationGroup[0] as number });
  });

  return pairs;
}

// Groups hold source indexes keyed by exactKey, stored latest-source-first (the
// reverse of source order). Under 'rename', an already-used source is never a
// legal candidate (one-shot), so it is dropped up front rather than skipped on
// every scan; a consumed candidate is then spliced near the tail, shifting only
// the cap's worth of entries instead of the whole group.
function buildSourceGroups(
  sources: ReadonlyArray<RenameSource>,
  mode: PairingMode,
): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  sources.forEach((source, index) => {
    if (mode === 'rename' && source.seedUses > 0) return;
    const key = exactKey(source.id, source.mode);
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [index]);
    else group.push(index);
  });
  for (const group of byKey.values()) group.reverse();
  return byKey;
}

function candidateScore(source: RenameSource, destination: AddChange, isUsed: boolean): number {
  const unusedBonus = isUsed ? 0 : 1;
  const basenameBonus = hasSameBasename(source.path, destination.newPath) ? 1 : 0;
  return unusedBonus + basenameBonus;
}

/**
 * Transcribes git's find_identical_files for one destination: scans the group
 * in source order (physical tail to head) over at most the candidate cap,
 * keeping the earliest candidate reaching the highest score. Returns its
 * position within group, or undefined when the group is empty.
 */
function findBestCandidate(
  group: ReadonlyArray<number>,
  sources: ReadonlyArray<RenameSource>,
  uses: ReadonlyArray<number>,
  destination: AddChange,
): number | undefined {
  const scanStart = Math.max(0, group.length - EXACT_CANDIDATE_CAP);
  let bestPosition: number | undefined;
  let bestScore = -1;

  for (let position = group.length - 1; position >= scanStart; position--) {
    const sourceIndex = group[position] as number;
    const isUsed = (uses[sourceIndex] as number) > 0;
    const score = candidateScore(sources[sourceIndex] as RenameSource, destination, isUsed);
    if (score > bestScore) {
      bestScore = score;
      bestPosition = position;
      if (score === PERFECT_CANDIDATE_SCORE) break;
    }
  }

  return bestPosition;
}

/**
 * git's copy-aware find_identical_files. Under 'rename', a used source is
 * never registered and a consumed candidate is removed from its group
 * (one-shot). Under 'copy', used sources stay eligible — they are scored,
 * counted toward the cap, and never removed, so one source can fan out to
 * every identical destination.
 */
export function pairIdenticalFiles(
  sources: ReadonlyArray<RenameSource>,
  destinations: ReadonlyArray<AddChange>,
  mode: PairingMode,
): ExactPairing {
  const groups = buildSourceGroups(sources, mode);
  const uses: number[] = sources.map((source) => source.seedUses);
  const pairs: SourcePair[] = [];
  const unpaired: AddChange[] = [];

  for (const destination of destinations) {
    const group = groups.get(exactKey(destination.newId, destination.newMode));
    const position =
      group === undefined ? undefined : findBestCandidate(group, sources, uses, destination);
    if (group === undefined || position === undefined) {
      unpaired.push(destination);
      continue;
    }

    const sourceIndex = group[position] as number;
    pairs.push({ source: sourceIndex, destination, score: MAX_SCORE });
    uses[sourceIndex] = (uses[sourceIndex] as number) + 1;
    if (mode === 'rename') group.splice(position, 1);
  }

  return { pairs, unpaired, uses };
}

/** One inexact-matrix candidate: a ranked (score, nameScore) pair between a
 *  registry source (by index) and a destination, as `buildMatrix` records it. */
export type MatrixCandidate = RankedCandidate & {
  readonly source: number;
  readonly destination: AddChange;
};

export interface SelectPairsOptions {
  readonly copies: boolean;
  readonly threshold: number;
}

export interface SelectPairsResult {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly uses: ReadonlyArray<number>;
}

type SelectionPass = 'rename' | 'copy';

/**
 * One greedy scan over `sorted` (score-descending): pairs a destination with
 * the first candidate that clears both guards, in place, mutating `uses` and
 * `pairedDestinations` as it goes. Stops at the first below-threshold
 * candidate — `sorted` is score-descending, so every later one is too.
 */
function runSelectionPass(
  sorted: ReadonlyArray<MatrixCandidate>,
  uses: number[],
  threshold: number,
  pairedDestinations: Set<AddChange>,
  pass: SelectionPass,
): SourcePair[] {
  const pairs: SourcePair[] = [];
  for (const candidate of sorted) {
    if (candidate.score < threshold) break;
    if (pairedDestinations.has(candidate.destination)) continue;
    if (pass === 'rename' && (uses[candidate.source] as number) > 0) continue;

    pairedDestinations.add(candidate.destination);
    uses[candidate.source] = (uses[candidate.source] as number) + 1;
    pairs.push({
      source: candidate.source,
      destination: candidate.destination,
      score: candidate.score,
    });
  }
  return pairs;
}

/**
 * git's `find_renames`, run once per pass (`diffcore-rename.c:1380` step 7).
 * Pass 1 (rename) skips a source already used and stops at the first
 * below-threshold candidate. Pass 2 (copy, only when `options.copies`) skips
 * only a destination pass 1 already claimed — any source, used or not, is
 * eligible. `uses` seeds both passes and accumulates every recorded pair.
 */
export function selectPairs(
  sorted: ReadonlyArray<MatrixCandidate>,
  uses: ReadonlyArray<number>,
  options: SelectPairsOptions,
): SelectPairsResult {
  const workingUses = [...uses];
  const pairedDestinations = new Set<AddChange>();

  const renamePairs = runSelectionPass(
    sorted,
    workingUses,
    options.threshold,
    pairedDestinations,
    'rename',
  );
  const copyPairs = options.copies
    ? runSelectionPass(sorted, workingUses, options.threshold, pairedDestinations, 'copy')
    : [];

  return { pairs: [...renamePairs, ...copyPairs], uses: workingUses };
}

export interface LabelledPair {
  readonly pair: SourcePair;
  readonly kind: 'rename' | 'copy';
}

/**
 * git's use-count labelling (`diff.c:6699`): walked in destination (queue)
 * path order, each pair decrements its source's remaining-use counter — the
 * pair that drives the counter to 0 is the rename, every earlier one is a
 * copy. `uses` already includes any seed use (the preimage file itself),
 * which is never a pair here, so a retained source's counter never reaches 0
 * and it only ever yields copies.
 */
export function labelRenameCopy(
  pairs: ReadonlyArray<SourcePair>,
  uses: ReadonlyArray<number>,
): ReadonlyArray<LabelledPair> {
  const ordered = sortByPath(pairs, (candidate) => candidate.destination.newPath);
  const remaining = [...uses];

  return ordered.map((candidate) => {
    const left = (remaining[candidate.source] as number) - 1;
    remaining[candidate.source] = left;
    return { pair: candidate, kind: left > 0 ? 'copy' : 'rename' };
  });
}
