import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
  CopyChange,
  DeleteChange,
  DiffChange,
  ModifyChange,
  RenameChange,
  TreeDiff,
} from '../../domain/diff/diff-change.js';
import type { FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { isGitlink } from '../../domain/diff/index.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import { detectRenames, type RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import { compareCandidates, hasSameBasename } from '../../domain/diff/rename-pairing.js';
import {
  buildChunkMap,
  countSpanhashChanges,
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarityFromMaps,
  MAX_SCORE,
} from '../../domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { boundedMapFor } from './internal/concurrency.js';
import { readBlob } from './read-blob.js';
import { readDeclaredObjectSize } from './read-object.js';

/** git's default `diff.renameLimit`. */
const DEFAULT_LIMIT = 1000;

interface CopySource {
  readonly oldPath: FilePath;
  readonly oldId: ObjectId;
  readonly oldMode: FileMode;
}

/**
 * Build the copy source set for `copies: 'on'`:
 * PREIMAGE blobs of files MODIFIED (modify/type-change) in the diff
 * plus the unpaired deletes already in the rename source set.
 * An UNCHANGED file is NOT a copy source under plain -C — only a file the
 * diff itself touches lends its preimage.
 */
function buildCopySourcesForOn(
  deletes: ReadonlyArray<DeleteChange>,
  other: ReadonlyArray<DiffChange>,
): ReadonlyArray<CopySource> {
  const sources: CopySource[] = [];
  for (const del of deletes) {
    sources.push({ oldPath: del.oldPath, oldId: del.oldId, oldMode: del.oldMode });
  }
  for (const change of other) {
    if (change.type === 'modify' || change.type === 'type-change') {
      if (!isGitlink(change.oldMode))
        sources.push({ oldPath: change.path, oldId: change.oldId, oldMode: change.oldMode });
    }
  }
  return sources;
}

/**
 * Build the copy source set for `copies: 'harder'` (--find-copies-harder):
 * ALL paths in the preimage tree (tree A), unchanged included.
 * When the harder source count would push num_create * num_src over the limit,
 * git falls back to only the 'on' (changed-files) source set — this function
 * always returns the FULL harder set; the caller applies the limit fallback.
 */
function buildCopySourcesForHarder(
  preimage: ReadonlyMap<FilePath, FlatTreeEntry>,
): ReadonlyArray<CopySource> {
  const sources: CopySource[] = [];
  for (const [path, entry] of preimage) {
    if (!isGitlink(entry.mode))
      sources.push({ oldPath: path, oldId: entry.id, oldMode: entry.mode });
  }
  return sources;
}

/** @internal — exported for direct unit testing of the matrix helpers. */
export type ScoredTriple =
  | {
      readonly kind: 'rename';
      readonly src: DeleteChange;
      readonly add: AddChange;
      readonly score: number;
      readonly nameScore: 0 | 1;
    }
  | {
      readonly kind: 'copy';
      readonly src: CopySource;
      readonly add: AddChange;
      readonly score: number;
      readonly nameScore: 0 | 1;
    };

/**
 * Maximum candidates retained per destination, matching git's NUM_CANDIDATE_PER_DST.
 * git's record_if_better keeps only the top 4 candidates per destination, ranked by
 * compareCandidates (score, then nameScore); when the slot array is full, a new
 * entry replaces the current worst-ranked slot only when it ranks strictly better.
 * A tie on both score and nameScore does not displace an existing entry.
 *
 * @internal — exported for direct unit testing.
 */
export const NUM_CANDIDATE_PER_DST = 4;

/**
 * Maintain the top-N candidates for one destination.
 * Mirrors git's record_if_better: the worst-ranked slot (compareCandidates order;
 * a tie keeps the lowest index) is replaced only when the candidate outranks it.
 */
export function recordIfBetter(slots: ScoredTriple[], candidate: ScoredTriple): void {
  if (slots.length < NUM_CANDIDATE_PER_DST) {
    slots.push(candidate);
    return;
  }
  // slots is always full (length === NUM_CANDIDATE_PER_DST) here; each element is defined.
  let worst = 0;
  for (let i = 1; i < slots.length; i++) {
    if (compareCandidates(slots[i] as ScoredTriple, slots[worst] as ScoredTriple) > 0) worst = i;
  }
  if (compareCandidates(slots[worst] as ScoredTriple, candidate) > 0) {
    slots[worst] = candidate;
  }
}

/** Precomputed spanhash fingerprint for one blob. */
export interface BlobFingerprint {
  readonly chunkMap: Map<number, number>;
  readonly size: number;
}

/**
 * Git's size prefilter: returns true when the size delta alone makes it impossible
 * to reach `threshold`, so the pair can be skipped before the expensive chunk scan.
 * Mirrors git's estimate_similarity early-reject:
 *   max * (MAX_SCORE − threshold) < (max − min) * MAX_SCORE
 */
export function isSizeRejected(sfSize: number, dfSize: number, threshold: number): boolean {
  const maxSize = Math.max(sfSize, dfSize);
  const minSize = Math.min(sfSize, dfSize);
  return maxSize * (MAX_SCORE - threshold) < (maxSize - minSize) * MAX_SCORE;
}

/** Score one (src, dst) fingerprint pair and record in slots if it meets the threshold. */
function scoreAndRecord(
  sf: BlobFingerprint,
  df: BlobFingerprint,
  threshold: number,
  candidate: ScoredTriple,
  slots: ScoredTriple[],
): void {
  // Stryker disable next-line ConditionalExpression: equivalent — a conservative necessary condition for `score >= threshold`; every pair it rejects also scores below threshold, so skipping the early return still records nothing at the gate below. Distinct from the id-level size gate upstream (`sizeCompatibleIds`, `selectHydrationIds`), whose own rejections ARE independently observable — a rejected id is never fingerprinted, never passed to `readBlob` at all — and which has its own dedicated tests; this per-PAIR check runs only on ids that already cleared that coarser gate.
  if (isSizeRejected(sf.size, df.size, threshold)) return;
  const score = estimateSimilarityFromMaps(sf.chunkMap, sf.size, df.chunkMap, df.size);
  if (score >= threshold) recordIfBetter(slots, { ...candidate, score });
}

/**
 * Build rename-candidate triples using git's dst-outer / src-inner iteration order
 * with a per-destination cap of NUM_CANDIDATE_PER_DST (= 4) top-scoring sources.
 * Mirrors diffcore-rename.c's record_if_better matrix construction.
 *
 * Accepts precomputed fingerprints so each blob is hashed at most once regardless
 * of how many (src, dst) pairs reference it.
 */
function buildRenameTriples(
  deletes: ReadonlyArray<DeleteChange>,
  adds: ReadonlyArray<AddChange>,
  fingerprints: ReadonlyMap<ObjectId, BlobFingerprint>,
  threshold: number,
): ScoredTriple[] {
  const triples: ScoredTriple[] = [];
  for (const add of adds) {
    const df = fingerprints.get(add.newId);
    if (df === undefined) continue;
    const slots: ScoredTriple[] = [];
    for (const del of deletes) {
      const sf = fingerprints.get(del.oldId);
      if (sf !== undefined) {
        const nameScore = hasSameBasename(del.oldPath, add.newPath) ? 1 : 0;
        scoreAndRecord(
          sf,
          df,
          threshold,
          { kind: 'rename', src: del, add, score: 0, nameScore },
          slots,
        );
      }
    }
    for (const triple of slots) triples.push(triple);
  }
  return triples;
}

/**
 * Build copy-candidate triples using git's dst-outer / src-inner iteration order
 * with a per-destination cap of NUM_CANDIDATE_PER_DST (= 4) top-scoring sources.
 *
 * Accepts precomputed fingerprints so each blob is hashed at most once.
 */
function buildCopyTriples(
  copySources: ReadonlyArray<CopySource>,
  adds: ReadonlyArray<AddChange>,
  fingerprints: ReadonlyMap<ObjectId, BlobFingerprint>,
  threshold: number,
): ScoredTriple[] {
  const triples: ScoredTriple[] = [];
  for (const add of adds) {
    const df = fingerprints.get(add.newId);
    if (df === undefined) continue;
    const slots: ScoredTriple[] = [];
    for (const src of copySources) {
      const sf = fingerprints.get(src.oldId);
      if (sf !== undefined) {
        const nameScore = hasSameBasename(src.oldPath, add.newPath) ? 1 : 0;
        scoreAndRecord(sf, df, threshold, { kind: 'copy', src, add, score: 0, nameScore }, slots);
      }
    }
    for (const triple of slots) triples.push(triple);
  }
  return triples;
}

/**
 * Sort triples by compareCandidates (score, then nameScore); at a full tie a
 * rename sorts AHEAD of a copy, so a deleted source claims the destination
 * before an unchanged one.
 */
function sortTriples(triples: ScoredTriple[]): void {
  triples.sort((a, b) => {
    const rankDiff = compareCandidates(a, b);
    if (rankDiff !== 0) return rankDiff;
    // Rename candidate wins over copy at equal score and equal nameScore.
    // Stryker disable next-line UnaryOperator: equivalent — build order concatenates all rename triples before all copy triples, so V8's stable insertion sort (each pivot compared against already-placed elements) never invokes this comparator with a=rename, b=copy; the arm is unreached and its sign is unobservable.
    if (a.kind === 'rename' && b.kind === 'copy') return -1;
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent — the only reached call is compare(copy, rename) when a copy is inserted after the renames; returning 1 or 0 both keep the copy after the rename via build order + stable sort, and the same-kind variants only reaffirm the stable a-after-b order, so no pairing changes.
    if (a.kind === 'copy' && b.kind === 'rename') return 1;
    return 0;
  });
}

interface RenameMatch {
  readonly kind: 'rename';
  readonly change: RenameChange;
  readonly del: DeleteChange;
  readonly add: AddChange;
}

interface CopyMatch {
  readonly kind: 'copy';
  readonly change: CopyChange;
  readonly add: AddChange;
}

type GreedyMatch = RenameMatch | CopyMatch;

function buildRenameChange(del: DeleteChange, add: AddChange, score: number): RenameChange {
  return {
    type: 'rename',
    oldPath: del.oldPath,
    newPath: add.newPath,
    oldId: del.oldId,
    newId: add.newId,
    oldMode: del.oldMode,
    newMode: add.newMode,
    similarity: { score, maxScore: MAX_SCORE },
  };
}

function buildCopyChange(src: CopySource, add: AddChange, score: number): CopyChange {
  return {
    type: 'copy',
    oldPath: src.oldPath,
    newPath: add.newPath,
    oldId: src.oldId,
    newId: add.newId,
    oldMode: src.oldMode,
    newMode: add.newMode,
    similarity: { score, maxScore: MAX_SCORE },
  };
}

function greedySelect(triples: ReadonlyArray<ScoredTriple>): ReadonlyArray<GreedyMatch> {
  const usedDeletes = new Set<DeleteChange>();
  const usedAdds = new Set<AddChange>();
  const matches: GreedyMatch[] = [];

  for (const triple of triples) {
    if (usedAdds.has(triple.add)) continue;

    if (triple.kind === 'rename') {
      // Discriminated union: triple.src is DeleteChange here — no cast needed.
      if (usedDeletes.has(triple.src)) continue;
      usedDeletes.add(triple.src);
      usedAdds.add(triple.add);
      matches.push({
        kind: 'rename',
        change: buildRenameChange(triple.src, triple.add, triple.score),
        del: triple.src,
        add: triple.add,
      });
    } else {
      // Copy: only the add is consumed; the copy source is NOT consumed (retained in result set).
      // Discriminated union: triple.src is CopySource here — no cast needed.
      usedAdds.add(triple.add);
      matches.push({
        kind: 'copy',
        change: buildCopyChange(triple.src, triple.add, triple.score),
        add: triple.add,
      });
    }
  }

  return matches;
}

function partitionLeftovers(changes: ReadonlyArray<DiffChange>): {
  readonly adds: ReadonlyArray<AddChange>;
  readonly deletes: ReadonlyArray<DeleteChange>;
  readonly other: ReadonlyArray<DiffChange>;
} {
  const adds: AddChange[] = [];
  const deletes: DeleteChange[] = [];
  const other: DiffChange[] = [];
  for (const change of changes) {
    if (change.type === 'add') {
      if (isGitlink(change.newMode)) other.push(change);
      else adds.push(change);
    } else if (change.type === 'delete') {
      if (isGitlink(change.oldMode)) other.push(change);
      else deletes.push(change);
    } else other.push(change);
  }
  return { adds, deletes, other };
}

interface InexactPassOptions {
  readonly adds: ReadonlyArray<AddChange>;
  readonly deletes: ReadonlyArray<DeleteChange>;
  readonly other: ReadonlyArray<DiffChange>;
  readonly threshold: number;
  readonly copies: 'off' | 'on' | 'harder';
  /** Effective copy sources resolved by the caller (after limit-fallback applied). */
  readonly copySources: ReadonlyArray<CopySource>;
}

interface InexactPassResult {
  readonly renames: ReadonlyArray<RenameChange>;
  readonly copyChanges: ReadonlyArray<CopyChange>;
  readonly consumedDeletes: ReadonlySet<DeleteChange>;
  readonly consumedAdds: ReadonlySet<AddChange>;
}

/**
 * git's rename-limit size gate: below this many unique ids, no id even
 * PASSES through a size read — every candidate is fingerprinted directly
 * (the common small-diff case never pays for it). Above it, a size read per
 * unique id decides which ids can possibly reach `threshold` against some
 * partner on the other side before any blob is ever read.
 *
 * @internal — exported for direct unit testing.
 */
export const SIZE_GATE_MIN_IDS = 16;

/** The first index in `sortedPartnerSizes` whose value `d` satisfies
 *  `d >= size || !isSizeRejected(size, d, threshold)` — monotone in `d`
 *  because that band is exactly the CONTIGUOUS region `isSizeRejected`
 *  admits around `size`, so a plain binary search finds its lower edge. */
function firstCandidatePartnerIndex(
  sortedPartnerSizes: ReadonlyArray<number>,
  size: number,
  threshold: number,
): number {
  let lo = 0;
  let hi = sortedPartnerSizes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const d = sortedPartnerSizes[mid] as number;
    const isCandidate = d >= size || !isSizeRejected(size, d, threshold);
    if (isCandidate) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Whether `size` has at least one size-compatible partner in
 *  `sortedPartnerSizes` — the smallest candidate the binary search finds is
 *  the only one that needs the exact `isSizeRejected` check: every partner
 *  before it is too small, every one after it is no better a fit. */
function hasSizeCompatiblePartner(
  size: number,
  sortedPartnerSizes: ReadonlyArray<number>,
  threshold: number,
): boolean {
  const index = firstCandidatePartnerIndex(sortedPartnerSizes, size, threshold);
  const candidate = sortedPartnerSizes[index];
  return candidate !== undefined && !isSizeRejected(size, candidate, threshold);
}

function sortedSizesOf(
  ids: ReadonlyArray<ObjectId>,
  sizes: ReadonlyMap<ObjectId, number>,
): number[] {
  return ids.map((id) => sizes.get(id) as number).sort((a, b) => a - b);
}

function addSizeCompatible(
  ids: ReadonlyArray<ObjectId>,
  sizes: ReadonlyMap<ObjectId, number>,
  sortedPartnerSizes: ReadonlyArray<number>,
  threshold: number,
  into: Set<ObjectId>,
): void {
  for (const id of ids) {
    const size = sizes.get(id) as number;
    if (hasSizeCompatiblePartner(size, sortedPartnerSizes, threshold)) into.add(id);
  }
}

/**
 * git's rename-limit size prefilter at the ID level (design D3): an id is
 * needed for fingerprinting only when at least one partner on the OTHER
 * side could possibly reach `threshold` against it. `sizes` is total over
 * `srcIds ∪ dstIds` — every id passed in has an entry, guaranteed by the
 * caller (`selectHydrationIds` reads a size for every unique id first).
 *
 * @internal — exported for direct unit testing (property lens 2, aggregator).
 */
export function sizeCompatibleIds(
  sizes: ReadonlyMap<ObjectId, number>,
  srcIds: ReadonlyArray<ObjectId>,
  dstIds: ReadonlyArray<ObjectId>,
  threshold: number,
): ReadonlySet<ObjectId> {
  const sortedSrcSizes = sortedSizesOf(srcIds, sizes);
  const sortedDstSizes = sortedSizesOf(dstIds, sizes);
  const needed = new Set<ObjectId>();
  addSizeCompatible(srcIds, sizes, sortedDstSizes, threshold, needed);
  addSizeCompatible(dstIds, sizes, sortedSrcSizes, threshold, needed);
  return needed;
}

async function readDeclaredSizes(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyMap<ObjectId, number>> {
  const entries = await boundedMapFor(
    ctx,
    'ioBound',
    ids,
    async (id): Promise<readonly [ObjectId, number]> => [id, await readDeclaredObjectSize(ctx, id)],
  );
  return new Map(entries);
}

/**
 * Which ids actually need fingerprinting for one inexact pass (design D3):
 * at or below `SIZE_GATE_MIN_IDS` unique ids, every one of them (no size
 * read pays for itself below the gate — the common small-diff path never
 * touches it); above it, only the ids `sizeCompatibleIds` keeps.
 */
async function selectHydrationIds(
  ctx: Context,
  srcIds: ReadonlyArray<ObjectId>,
  dstIds: ReadonlyArray<ObjectId>,
  threshold: number,
): Promise<ReadonlyArray<ObjectId>> {
  const unique = Array.from(new Set([...srcIds, ...dstIds]));
  if (unique.length <= SIZE_GATE_MIN_IDS) return unique;
  const sizes = await readDeclaredSizes(ctx, unique);
  return Array.from(sizeCompatibleIds(sizes, srcIds, dstIds, threshold));
}

function dedupeMissing(
  ids: ReadonlyArray<ObjectId>,
  known: ReadonlyMap<ObjectId, BlobFingerprint>,
): ObjectId[] {
  const seen = new Set<ObjectId>();
  const missing: ObjectId[] = [];
  for (const id of ids) {
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }
  return missing;
}

/**
 * Fingerprint-and-drop hydration (design D3): reads each missing blob just
 * long enough to build its spanhash fingerprint, then lets the bytes go —
 * only the fingerprint (and its size) escapes the bounded worker, so a
 * blob's content never outlives the read that produced it. `ids` already
 * merges src and dst candidates into ONE array, so the single
 * `boundedMapFor` call below is the one shared pool for both arms — no
 * per-arm pool to double the true ioBound ceiling.
 *
 * Skips every id already in `known` and returns a NEW map (`known` plus the
 * newly hydrated entries) — `known` itself is never mutated, so a caller
 * accumulating fingerprints across phased hydration passes keeps its own
 * map intact.
 */
export async function hydrateFingerprints(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
  known: ReadonlyMap<ObjectId, BlobFingerprint>,
): Promise<ReadonlyMap<ObjectId, BlobFingerprint>> {
  const missing = dedupeMissing(ids, known);
  const fetched = await boundedMapFor(
    ctx,
    'ioBound',
    missing,
    async (id): Promise<readonly [ObjectId, BlobFingerprint]> => {
      const { content } = await readBlob(ctx, id);
      return [id, { chunkMap: buildChunkMap(content), size: content.length }];
    },
  );
  const merged = new Map(known);
  for (const [id, fingerprint] of fetched) merged.set(id, fingerprint);
  return merged;
}

/** Build and sort all rename+copy triples for one inexact pass. */
function buildAllTriples(
  deletes: ReadonlyArray<DeleteChange>,
  adds: ReadonlyArray<AddChange>,
  copySources: ReadonlyArray<CopySource>,
  copies: 'off' | 'on' | 'harder',
  threshold: number,
  fingerprints: ReadonlyMap<ObjectId, BlobFingerprint>,
): ScoredTriple[] {
  const renameTriples = buildRenameTriples(deletes, adds, fingerprints, threshold);
  const copyTriples =
    // Stryker disable next-line ConditionalExpression: equivalent — resolveCopySources returns [] whenever copies==='off', so buildCopyTriples over the empty copySources yields [], identical to the : [] arm.
    copies !== 'off' ? buildCopyTriples(copySources, adds, fingerprints, threshold) : [];
  const allTriples: ScoredTriple[] = [...renameTriples, ...copyTriples];
  sortTriples(allTriples);
  return allTriples;
}

async function runInexactPass(
  ctx: Context,
  opts: InexactPassOptions,
): Promise<InexactPassResult | null> {
  const { adds, deletes, threshold, copies, copySources } = opts;
  // Stryker disable next-line ConditionalExpression: equivalent — with deletes and copySources both empty the pass builds no triples and greedySelect returns []; assemblePostPass over that empty result equals its null-defaulted output.
  if (deletes.length === 0 && copySources.length === 0) return null;

  const allSrcIds = [...deletes.map((d) => d.oldId), ...copySources.map((s) => s.oldId)];
  const dstIds = adds.map((a) => a.newId);
  const neededIds = await selectHydrationIds(ctx, allSrcIds, dstIds, threshold);
  const fingerprints = await hydrateFingerprints(ctx, neededIds, new Map());
  const allTriples = buildAllTriples(deletes, adds, copySources, copies, threshold, fingerprints);

  const matches = greedySelect(allTriples);
  const renameMatches = matches.filter((m): m is RenameMatch => m.kind === 'rename');
  const copyMatches = matches.filter((m): m is CopyMatch => m.kind === 'copy');
  return {
    renames: renameMatches.map((m) => m.change),
    copyChanges: copyMatches.map((m) => m.change),
    consumedDeletes: new Set<DeleteChange>(renameMatches.map((m) => m.del)),
    consumedAdds: new Set<AddChange>(matches.map((m) => m.add)),
  };
}

/** Tracking record for a modify that was split into synthetic delete+add halves. */
interface BrokenRecord {
  readonly original: ModifyChange;
  readonly del: DeleteChange;
  readonly add: AddChange;
  readonly dissimilarity: number;
}

/**
 * Resolve the effective break-attempt and keep-broken gates.
 * A merge value of 0 maps to DEFAULT_MERGE_SCORE (matrix B4b).
 */
function resolveBreakGates(breakRewrites: { readonly score: number; readonly merge: number }): {
  readonly breakScore: number;
  readonly mergeScore: number;
} {
  return {
    breakScore: breakRewrites.score,
    mergeScore: breakRewrites.merge === 0 ? DEFAULT_MERGE_SCORE : breakRewrites.merge,
  };
}

interface BreakScores {
  readonly computedBreakScore: number;
  readonly dissimilarity: number;
}

/**
 * Compute git's break-attempt gate score and merge-score for a (src, dst) blob pair.
 *
 * break_score  = min(srcRemoved + literalAdded, maxSize) * MAX_SCORE / maxSize
 * merge_score  = (srcSize - srcCopied) * MAX_SCORE / srcSize   (printed as M<n>)
 *
 * Both mirror `diffcore-break.c::score_diff` and `diffcore-break.c::merge_score`.
 */
function computeBreakScores(src: Uint8Array, dst: Uint8Array): BreakScores {
  const srcSize = src.length;
  const dstSize = dst.length;
  const maxSize = Math.max(srcSize, dstSize);
  const { srcCopied, literalAdded } = countSpanhashChanges(src, dst);
  const srcRemoved = srcSize - srcCopied;
  const rawBreakNum = Math.min(srcRemoved + literalAdded, maxSize);
  const computedBreakScore = maxSize > 0 ? Math.trunc((rawBreakNum * MAX_SCORE) / maxSize) : 0;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — differs only at srcSize===0, where srcRemoved===0 makes the branch NaN vs 0; dissimilarity only feeds the >= mergeScore gate (mergeScore is always >= 1 since merge:0 maps to DEFAULT_MERGE_SCORE), which both NaN and 0 fail, so the output is unchanged.
  const dissimilarity = srcSize > 0 ? Math.trunc((srcRemoved * MAX_SCORE) / srcSize) : 0;
  return { computedBreakScore, dissimilarity };
}

interface ModifyScore {
  readonly mod: ModifyChange;
  readonly computedBreakScore: number;
  readonly dissimilarity: number;
}

/**
 * Reads a modify's old and new blobs SEQUENTIALLY (never `Promise.all`) so
 * one worker never occupies two ioBound slots at once — `boundedMapFor`
 * below already caps concurrent MODIFIES at the ioBound limit; a worker that
 * fired both reads in parallel would let 2× that many object reads run in
 * flight, the same doubled-ceiling shape `hydrateFingerprints` avoids by
 * sharing one pool across its own src/dst arms.
 */
async function scoreOneModify(ctx: Context, mod: ModifyChange): Promise<ModifyScore> {
  const { content: oldBytes } = await readBlob(ctx, mod.oldId);
  const { content: newBytes } = await readBlob(ctx, mod.newId);
  const { computedBreakScore, dissimilarity } = computeBreakScores(oldBytes, newBytes);
  return { mod, computedBreakScore, dissimilarity };
}

function toSyntheticDelete(mod: ModifyChange): DeleteChange {
  return { type: 'delete', oldPath: mod.path, oldId: mod.oldId, oldMode: mod.oldMode };
}

function toSyntheticAdd(mod: ModifyChange): AddChange {
  return { type: 'add', newPath: mod.path, newId: mod.newId, newMode: mod.newMode };
}

/**
 * Score all modifies and return those that exceed breakScore as broken
 * records. git's `should_break` reads both blobs fully for every modify —
 * no size gate here — so each modify streams its own pair through the
 * bounded pool rather than hydrating the whole batch up front.
 */
async function scoreModifies(
  ctx: Context,
  modifies: ReadonlyArray<ModifyChange>,
  breakScore: number,
): Promise<{
  readonly records: ReadonlyArray<BrokenRecord>;
  readonly paths: ReadonlySet<FilePath>;
}> {
  const scores = await boundedMapFor(ctx, 'ioBound', modifies, (mod) => scoreOneModify(ctx, mod));

  const records: BrokenRecord[] = [];
  const paths = new Set<FilePath>();
  for (const { mod, computedBreakScore, dissimilarity } of scores) {
    if (computedBreakScore < breakScore) continue;
    records.push({
      original: mod,
      del: toSyntheticDelete(mod),
      add: toSyntheticAdd(mod),
      dissimilarity,
    });
    paths.add(mod.path);
  }
  return { records, paths };
}

/** Replace broken modifies in the change list with their synthetic delete+add halves. */
function patchDiffWithBroken(
  diff: TreeDiff,
  records: ReadonlyArray<BrokenRecord>,
  brokenPaths: ReadonlySet<FilePath>,
): TreeDiff {
  const byPath = new Map<FilePath, BrokenRecord>(records.map((r) => [r.original.path, r]));
  const patchedChanges: DiffChange[] = [];
  for (const change of diff.changes) {
    const record =
      change.type === 'modify' && brokenPaths.has(change.path)
        ? byPath.get(change.path)
        : undefined;
    if (record !== undefined) {
      patchedChanges.push(record.del, record.add);
    } else {
      patchedChanges.push(change);
    }
  }
  return { changes: patchedChanges };
}

/**
 * Attempt to break dissimilar modifies into synthetic delete+add pairs.
 * Returns the broken records and a new diff with those modifies replaced.
 *
 * Break-attempt runs BEFORE exact/inexact rename passes so the synthetic halves
 * feed the rename/copy matrix.
 */
async function attemptBreaks(
  ctx: Context,
  diff: TreeDiff,
  breakScore: number,
): Promise<{ readonly broken: ReadonlyArray<BrokenRecord>; readonly patchedDiff: TreeDiff }> {
  const modifies = diff.changes.filter(
    (c): c is ModifyChange => c.type === 'modify' && !isGitlink(c.oldMode),
  );
  // Stryker disable next-line ConditionalExpression: equivalent — an empty modifies list produces empty records, so the downstream records.length===0 guard returns the identical { broken: [], patchedDiff: diff }.
  if (modifies.length === 0) return { broken: [], patchedDiff: diff };

  const { records, paths } = await scoreModifies(ctx, modifies, breakScore);
  // Stryker disable next-line ConditionalExpression: equivalent — empty records means empty paths, so patchDiffWithBroken copies changes unchanged and broken is [], matching the early return.
  if (records.length === 0) return { broken: [], patchedDiff: diff };

  return { broken: records, patchedDiff: patchDiffWithBroken(diff, records, paths) };
}

/**
 * After rename+copy detection, re-merge unresolved broken pairs.
 *
 * Checks the PRESENCE of synthetic halves in `changes` by object identity —
 * if `record.del` is absent from `changes`, the delete half was consumed
 * (exact or inexact pass); likewise for `record.add`.
 *
 * Cases per broken pair:
 * - Both halves present (neither consumed): decide keep-broken or re-merge.
 *   Strip both halves and emit a modify (plain or broken) in their place.
 * - One half consumed: the surviving half stays as-is (delete or add).
 * - Both consumed: expressed by rename/copy elsewhere; nothing extra to emit.
 */

/** Scan `changes` and return the subset of synthetic halves that are still present. */
function findPresentHalves(
  changes: ReadonlyArray<DiffChange>,
  broken: ReadonlyArray<BrokenRecord>,
): {
  readonly presentDels: ReadonlySet<DeleteChange>;
  readonly presentAdds: ReadonlySet<AddChange>;
} {
  const syntheticDels = new Set(broken.map((r) => r.del));
  const syntheticAdds = new Set(broken.map((r) => r.add));
  const presentDels = new Set<DeleteChange>();
  const presentAdds = new Set<AddChange>();
  for (const c of changes) {
    if (c.type === 'delete' && syntheticDels.has(c as DeleteChange))
      presentDels.add(c as DeleteChange);
    else if (c.type === 'add' && syntheticAdds.has(c as AddChange)) presentAdds.add(c as AddChange);
  }
  return { presentDels, presentAdds };
}

/** Emit the re-merged or kept-broken modify for a pair where both halves survived. */
function emitMergedModify(record: BrokenRecord, mergeScore: number): DiffChange {
  if (record.dissimilarity >= mergeScore) {
    return { ...record.original, broken: { score: record.dissimilarity, maxScore: MAX_SCORE } };
  }
  return record.original;
}

function remergeOrKeepBroken(
  changes: ReadonlyArray<DiffChange>,
  broken: ReadonlyArray<BrokenRecord>,
  mergeScore: number,
): ReadonlyArray<DiffChange> {
  // Stryker disable next-line ConditionalExpression: equivalent — the sole caller finalizeWithBroken invokes remergeOrKeepBroken only when broken.length > 0, so this guard is never true.
  if (broken.length === 0) return changes;

  const { presentDels, presentAdds } = findPresentHalves(changes, broken);
  const toStrip = new Set<DiffChange>();
  const reinsert: DiffChange[] = [];

  for (const record of broken) {
    const delPresent = presentDels.has(record.del);
    const addPresent = presentAdds.has(record.add);
    // Stryker disable next-line LogicalOperator,BooleanLiteral: equivalent — this continue only short-circuits the disjoint delPresent&&addPresent strip/emit branch; each variant here still lets that branch fire iff both halves are present, so output is unchanged (ConditionalExpression left unsuppressed: its true variant is killable).
    if (!delPresent && !addPresent) continue; // both consumed; nothing to strip or emit
    if (delPresent && addPresent) {
      // Both unconsumed: strip both halves; emit a modify (plain or broken).
      toStrip.add(record.del);
      toStrip.add(record.add);
      reinsert.push(emitMergedModify(record, mergeScore));
    }
    // Exactly one half present: the surviving half stays; no modify to emit.
  }

  // Stryker disable next-line ConditionalExpression: equivalent — toStrip and reinsert are populated together, so an empty toStrip means an empty reinsert and the fallthrough returns [...changes, ...[]], the same content as returning changes.
  if (toStrip.size === 0) return changes;
  const stripped = changes.filter((c) => !toStrip.has(c));
  return [...stripped, ...reinsert];
}

/**
 * Resolve effective copy sources for the inexact pass.
 *
 * For copies:'harder', the full preimage set is used unless num_create * num_src_harder
 * exceeds the limit^2 — in that case git falls back to the 'on' source set (only
 * modified-file preimages) and warns "only found copies from modified paths due to
 * too many files". We replicate the fallback without the warning.
 */
function resolveCopySources(
  copies: 'off' | 'on' | 'harder',
  adds: ReadonlyArray<AddChange>,
  deletes: ReadonlyArray<DeleteChange>,
  other: ReadonlyArray<DiffChange>,
  preimage: ReadonlyMap<FilePath, FlatTreeEntry> | undefined,
  limit: number,
): ReadonlyArray<CopySource> {
  if (copies === 'off') return [];
  if (copies === 'on') return buildCopySourcesForOn(deletes, other);

  // copies === 'harder'
  const harderSources =
    preimage !== undefined
      ? buildCopySourcesForHarder(preimage)
      : buildCopySourcesForOn(deletes, other);

  // When harder source count causes limit breach, fall back to 'on' sources (git's fallback).
  const isHarderOverLimit = limit !== 0 && adds.length * harderSources.length > limit * limit;
  return isHarderOverLimit ? buildCopySourcesForOn(deletes, other) : harderSources;
}

/**
 * Detect inexact (content-similarity) renames and optionally copies,
 * with optional -B break-rewrite detection.
 *
 * Fixed order when breakRewrites is set:
 * 1. Break-attempt: split dissimilar modifies into synthetic delete+add halves so
 *    they feed the rename/copy matrix. This runs BEFORE exact/inexact passes.
 * 2. Run the pure exact `detectRenames` first (R100, never limited).
 * 3. Partition leftovers into unpaired adds (destinations) and unpaired deletes (sources).
 * 4. Apply the rename-limit guard: if num_create * num_src > limit^2, skip inexact pass.
 *    For copies:'harder', num_src includes ALL preimage paths; if this causes the limit
 *    to be exceeded, fall back to copies:'on' sources (git's fallback).
 * 5. Size-gate the candidate pool above SIZE_GATE_MIN_IDS unique ids, then
 *    fingerprint-and-drop each needed blob via a bounded concurrency pool —
 *    only the fingerprint escapes the worker, never the blob's own bytes.
 * 6. Build scored triples for renames (deletes vs adds) and optionally copies.
 *    At equal score, rename sorts AHEAD of copy (tiebreak).
 * 7. Greedy score-descending selection: pair when add is free AND score >= threshold.
 *    Rename also requires the delete to be free; copy retains its source.
 * 8. Emit winners; unconsumed adds/deletes remain as-is. Copy sources are never consumed.
 * 9. Keep-broken/re-merge: for broken pairs with neither half consumed, emit a single
 *    modify with a broken datum (if dissimilarity >= mergeScore) or a plain modify.
 */

/** Resolve the effective merge score from the breakRewrites option (or defaults). */
function resolveEffectiveMergeScore(breakRewrites: RenameDetectOptions['breakRewrites']): number {
  const opts =
    breakRewrites !== false && breakRewrites !== undefined
      ? breakRewrites
      : { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE };
  return resolveBreakGates(opts).mergeScore;
}

/** Apply re-merge/keep-broken and sort; returns the final TreeDiff. */
function finalizeWithBroken(
  changes: ReadonlyArray<DiffChange>,
  broken: ReadonlyArray<BrokenRecord>,
  mergeScore: number,
): TreeDiff {
  // Stryker disable next-line ConditionalExpression: equivalent — forcing this guard false routes the empty-broken case through remergeOrKeepBroken, whose own empty-broken guard returns changes unchanged, so sortByPath yields the identical TreeDiff as this early return.
  if (broken.length === 0) return { changes: sortByPath(changes, primaryPath) };
  const remerged = remergeOrKeepBroken(changes, broken, mergeScore);
  return { changes: sortByPath(remerged, primaryPath) };
}

/** Run the break-attempt pass if enabled; returns broken records and patched diff. */
async function runBreakPass(
  ctx: Context,
  diff: TreeDiff,
  breakRewrites: RenameDetectOptions['breakRewrites'],
): Promise<{ readonly broken: ReadonlyArray<BrokenRecord>; readonly workingDiff: TreeDiff }> {
  if (breakRewrites === false || breakRewrites === undefined) {
    return { broken: [], workingDiff: diff };
  }
  const breakScore = breakRewrites.score !== 0 ? breakRewrites.score : DEFAULT_BREAK_SCORE;
  const attempt = await attemptBreaks(ctx, diff, breakScore);
  return { broken: attempt.broken, workingDiff: attempt.patchedDiff };
}

interface DetectOptions {
  readonly threshold: number;
  readonly limit: number;
  readonly copies: 'off' | 'on' | 'harder';
  readonly breakRewrites: RenameDetectOptions['breakRewrites'];
}

/** Resolve all detection options from the public RenameDetectOptions with defaults. */
function resolveDetectOptions(options: RenameDetectOptions | undefined): DetectOptions {
  return {
    threshold: options?.threshold ?? DEFAULT_RENAME_THRESHOLD,
    limit: options?.limit ?? DEFAULT_LIMIT,
    copies: options?.copies ?? 'off',
    breakRewrites: options?.breakRewrites ?? false,
  };
}

/** Assemble the change list from inexact-pass results and unconsumed leftovers. */
function assemblePostPass(
  adds: ReadonlyArray<AddChange>,
  deletes: ReadonlyArray<DeleteChange>,
  other: ReadonlyArray<DiffChange>,
  passResult: InexactPassResult | null,
): ReadonlyArray<DiffChange> {
  const consumedDeletes = passResult?.consumedDeletes ?? new Set<DeleteChange>();
  const consumedAdds = passResult?.consumedAdds ?? new Set<AddChange>();
  const renames = passResult?.renames ?? [];
  const copyChanges = passResult?.copyChanges ?? [];
  return [
    ...adds.filter((a) => !consumedAdds.has(a)),
    ...deletes.filter((d) => !consumedDeletes.has(d)),
    ...renames,
    ...copyChanges,
    ...other,
  ];
}

export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
  preimage?: ReadonlyMap<FilePath, FlatTreeEntry>,
): Promise<TreeDiff> {
  const { threshold, limit, copies, breakRewrites } = resolveDetectOptions(options);
  const mergeScore = resolveEffectiveMergeScore(breakRewrites);

  // Break-attempt pass: runs BEFORE exact/inexact so halves feed the matrix.
  const { broken, workingDiff } = await runBreakPass(ctx, diff, breakRewrites);

  // The exact pass is never limited; the rename-limit guard below is inexact-only.
  const exactResult = detectRenames(workingDiff);
  const { adds, deletes, other } = partitionLeftovers(exactResult.changes);

  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent — hasRenameWork only gates the pure-optimisation early return below; every listed variant merely forces it true in more no-work cases (adds===0 or deletes===0), and falling through then builds no triples (no destinations or no sources), leaving the result unchanged.
  const hasRenameWork = adds.length > 0 && deletes.length > 0;
  // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: equivalent — hasCopyWork only gates the pure-optimisation early return below; every listed variant merely forces it true in more no-work cases (copies==='off' or adds===0), and falling through then builds no triples, leaving the result unchanged.
  const hasCopyWork = copies !== 'off' && adds.length > 0;
  // Stryker disable next-line BlockStatement,ConditionalExpression: equivalent — this early return is a pure optimisation: when it fires (no rename and no copy work) the inexact pass would build no triples and consume nothing, so skipping the return and falling through yields the identical sorted TreeDiff.
  if (!hasRenameWork && !hasCopyWork) {
    return finalizeWithBroken(exactResult.changes, broken, mergeScore);
  }

  // Resolve copy sources first so their count feeds the combined limit gate.
  // Under copies:'harder', applies the harder→on fallback when harder sources alone exceed the limit.
  const copySources = resolveCopySources(copies, adds, deletes, other, preimage, limit);

  // Git's combined limit: skip the whole inexact pass when num_create * num_src > limit².
  const numSrc = deletes.length + copySources.length;
  const isOverLimit = limit !== 0 && adds.length * numSrc > limit * limit;
  if (isOverLimit) {
    return finalizeWithBroken(exactResult.changes, broken, mergeScore);
  }

  const passResult = await runInexactPass(ctx, {
    adds,
    deletes,
    other,
    threshold,
    copies,
    copySources,
  });

  return finalizeWithBroken(assemblePostPass(adds, deletes, other, passResult), broken, mergeScore);
}
