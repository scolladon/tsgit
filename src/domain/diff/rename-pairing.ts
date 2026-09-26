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

// Last path segment equality; 'Foo' ≡ 'b/Foo', 'xFoo' ≢ 'Foo' (git's basename_same).
export function hasSameBasename(oldPath: FilePath, newPath: FilePath): boolean {
  const oldBasename = oldPath.slice(oldPath.lastIndexOf('/') + 1);
  const newBasename = newPath.slice(newPath.lastIndexOf('/') + 1);
  return oldBasename === newBasename;
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
