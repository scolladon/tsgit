import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
  CopyChange,
  DeleteChange,
  DiffChange,
  ModifyChange,
  RenameChange,
  TreeDiff,
  TypeChangeChange,
} from '../../domain/diff/diff-change.js';
import type { FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { kindOf } from '../../domain/diff/index.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import type { RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  compareCandidates,
  type ExactPairing,
  hasSameBasename,
  type LabelledPair,
  labelRenameCopy,
  type MatrixCandidate,
  pairIdenticalFiles,
  type RenameSource,
  type SourcePair,
  selectPairs,
} from '../../domain/diff/rename-pairing.js';
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
export function recordIfBetter(slots: MatrixCandidate[], candidate: MatrixCandidate): void {
  if (slots.length < NUM_CANDIDATE_PER_DST) {
    slots.push(candidate);
    return;
  }
  // slots is always full (length === NUM_CANDIDATE_PER_DST) here; each element is defined.
  let worst = 0;
  for (let i = 1; i < slots.length; i++) {
    if (compareCandidates(slots[i] as MatrixCandidate, slots[worst] as MatrixCandidate) > 0)
      worst = i;
  }
  if (compareCandidates(slots[worst] as MatrixCandidate, candidate) > 0) {
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
  candidate: MatrixCandidate,
  slots: MatrixCandidate[],
): void {
  // Stryker disable next-line ConditionalExpression: equivalent — a conservative necessary condition for `score >= threshold`; every pair it rejects also scores below threshold, so skipping the early return still records nothing at the gate below. Distinct from the id-level size gate upstream (`sizeCompatibleIds`, `selectHydrationIds`), whose own rejections ARE independently observable — a rejected id is never fingerprinted, never passed to `readBlob` at all — and which has its own dedicated tests; this per-PAIR check runs only on ids that already cleared that coarser gate.
  if (isSizeRejected(sf.size, df.size, threshold)) return;
  const score = estimateSimilarityFromMaps(sf.chunkMap, sf.size, df.chunkMap, df.size);
  if (score >= threshold) recordIfBetter(slots, { ...candidate, score });
}

/** Final emitted change for a labelled pair, generalised over the registry's
 *  `RenameSource` — used after `labelRenameCopy` decides rename vs copy. */
function buildRenameChange(
  source: RenameSource,
  destination: AddChange,
  score: number,
): RenameChange {
  return {
    type: 'rename',
    oldPath: source.path,
    newPath: destination.newPath,
    oldId: source.id,
    newId: destination.newId,
    oldMode: source.mode,
    newMode: destination.newMode,
    similarity: { score, maxScore: MAX_SCORE },
  };
}

function buildCopyChange(source: RenameSource, destination: AddChange, score: number): CopyChange {
  return {
    type: 'copy',
    oldPath: source.path,
    newPath: destination.newPath,
    oldId: source.id,
    newId: destination.newId,
    oldMode: source.mode,
    newMode: destination.newMode,
    similarity: { score, maxScore: MAX_SCORE },
  };
}

/** git's `find_identical_files` seeding for a delete: a plain delete seeds 0
 *  (`deleted`); a broken record's own delete half seeds per its dissimilarity
 *  against `mergeScore` — low dissimilarity means the pair is headed for a
 *  re-merge, so the delete already has an implicit user (`broken-delete`). */
function toDeletedSource(
  del: DeleteChange,
  brokenByDel: ReadonlyMap<DeleteChange, BrokenRecord>,
  mergeScore: number,
): RenameSource {
  const record = brokenByDel.get(del);
  if (record === undefined) {
    return { path: del.oldPath, id: del.oldId, mode: del.oldMode, origin: 'deleted', seedUses: 0 };
  }
  return {
    path: del.oldPath,
    id: del.oldId,
    mode: del.oldMode,
    origin: 'broken-delete',
    seedUses: record.dissimilarity < mergeScore ? 1 : 0,
  };
}

/** A modify/type-change's preimage lends its old blob as a copy source (seed 1
 *  — the file itself is its first, implicit user). */
function toModifiedSource(change: ModifyChange | TypeChangeChange): RenameSource {
  return {
    path: change.path,
    id: change.oldId,
    mode: change.oldMode,
    origin: 'modified',
    seedUses: 1,
  };
}

function toUnchangedSource(path: FilePath, entry: FlatTreeEntry): RenameSource {
  return { path, id: entry.id, mode: entry.mode, origin: 'unchanged', seedUses: 1 };
}

/** Every preimage path the diff itself does not touch (`copies: 'harder'` only). */
function collectUnchangedSources(
  preimage: ReadonlyMap<FilePath, FlatTreeEntry> | undefined,
  touchedPaths: ReadonlySet<FilePath>,
): RenameSource[] {
  if (preimage === undefined) return [];
  const sources: RenameSource[] = [];
  for (const [path, entry] of preimage) {
    if (!touchedPaths.has(path)) sources.push(toUnchangedSource(path, entry));
  }
  return sources;
}

/** A `RenameSource` paired with the original delete object it was built from
 *  (object identity `writeBackBroken` keys a broken-delete's source index on)
 *  — `undefined` for a `modified`/`unchanged` source, which has no delete. */
interface RegisteredSource {
  readonly source: RenameSource;
  readonly originalDelete?: DeleteChange;
}

interface CandidateRegistry {
  readonly sources: ReadonlyArray<RenameSource>;
  /** Aligned with `sources`; defined for `deleted`/`broken-delete` origins only. */
  readonly originalDeletes: ReadonlyArray<DeleteChange | undefined>;
  readonly destinations: ReadonlyArray<AddChange>;
  readonly other: ReadonlyArray<DiffChange>;
}

/** Classify one non-add, non-delete change: registers a copy source when
 *  `copies` is on, always keeps the change itself in `other`, and records
 *  its path as preimage-touched so a `harder` scan does not re-register it. */
function registerOtherChange(
  change: DiffChange,
  copies: 'off' | 'on' | 'harder',
  other: DiffChange[],
  registered: RegisteredSource[],
  touchedPaths: Set<FilePath>,
): void {
  other.push(change);
  if (change.type !== 'modify' && change.type !== 'type-change') return;
  touchedPaths.add(change.path);
  if (copies !== 'off') registered.push({ source: toModifiedSource(change) });
}

/**
 * git's source registration (`diffcore_rename_extended`'s setup loop),
 * generalised over every origin: a delete always registers; a modify/type-change
 * preimage registers only under copies; an untouched preimage path registers
 * only under `copies: 'harder'`. Every mode registers — exact pairing and the
 * rename-limit count need non-regular sources too (symlinks, gitlinks); the
 * inexact matrix drops them again (git's estimate_similarity scores regular
 * files only).
 */
function registerCandidates(
  workingDiff: TreeDiff,
  broken: ReadonlyArray<BrokenRecord>,
  copies: 'off' | 'on' | 'harder',
  preimage: ReadonlyMap<FilePath, FlatTreeEntry> | undefined,
  mergeScore: number,
): CandidateRegistry {
  const brokenByDel = new Map(broken.map((record) => [record.del, record] as const));
  const destinations: AddChange[] = [];
  const other: DiffChange[] = [];
  const registered: RegisteredSource[] = [];
  const touchedPaths = new Set<FilePath>();

  for (const change of workingDiff.changes) {
    if (change.type === 'add') destinations.push(change);
    else if (change.type === 'delete') {
      registered.push({
        source: toDeletedSource(change, brokenByDel, mergeScore),
        originalDelete: change,
      });
      touchedPaths.add(change.oldPath);
    } else registerOtherChange(change, copies, other, registered, touchedPaths);
  }

  if (copies === 'harder') {
    for (const source of collectUnchangedSources(preimage, touchedPaths))
      registered.push({ source });
  }

  const ordered = sortByPath(registered, (entry) => entry.source.path);
  return {
    sources: ordered.map((entry) => entry.source),
    originalDeletes: ordered.map((entry) => entry.originalDelete),
    destinations,
    other,
  };
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

/** One (index, source) pair from the registry — `buildMatrix` scores every
 *  matrix-eligible source against every destination, regardless of use
 *  count; `selectPairs` alone decides which candidates each pass may take. */
interface IndexedSource {
  readonly index: number;
  readonly source: RenameSource;
}

/**
 * git's matrix construction (`diffcore-rename.c:1380` step 6): destination-major,
 * source-inner, ONE shared `NUM_CANDIDATE_PER_DST` slot array per destination over
 * ALL matrix sources — no separate rename/copy pools. Which pass a source may fill
 * a slot for is `selectPairs`'s job, not this one: a used source still competes for
 * (and can win, or evict a fresher one from) a destination's shared cap.
 */
function buildMatrix(
  sources: ReadonlyArray<IndexedSource>,
  destinations: ReadonlyArray<AddChange>,
  fingerprints: ReadonlyMap<ObjectId, BlobFingerprint>,
  threshold: number,
): MatrixCandidate[] {
  const candidates: MatrixCandidate[] = [];
  for (const destination of destinations) {
    const df = fingerprints.get(destination.newId);
    if (df === undefined) continue;
    const slots: MatrixCandidate[] = [];
    for (const { index, source } of sources) {
      const sf = fingerprints.get(source.id);
      if (sf === undefined) continue;
      const nameScore = hasSameBasename(source.path, destination.newPath) ? 1 : 0;
      scoreAndRecord(sf, df, threshold, { source: index, destination, score: 0, nameScore }, slots);
    }
    for (const candidate of slots) candidates.push(candidate);
  }
  return candidates;
}

interface InexactMatrixResult {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly consumedAdds: ReadonlySet<AddChange>;
  readonly uses: ReadonlyArray<number>;
}

/**
 * Runs one inexact pass over `matrixIndices` (the registry sources the cull
 * step, `resolveMatrixPlan`, kept — used sources included when `keepEverySource`
 * held): hydrates fingerprints, builds the shared-cap matrix, sorts it, and
 * lets `selectPairs` run rename-then-copy selection over the whole thing.
 */
async function runInexactMatrix(
  ctx: Context,
  registrySources: ReadonlyArray<RenameSource>,
  matrixIndices: ReadonlyArray<number>,
  destinations: ReadonlyArray<AddChange>,
  uses: ReadonlyArray<number>,
  threshold: number,
  copies: 'off' | 'on' | 'harder',
): Promise<InexactMatrixResult | null> {
  if (matrixIndices.length === 0) return null;

  const matrixSources: IndexedSource[] = matrixIndices.map((index) => ({
    index,
    source: registrySources[index] as RenameSource,
  }));
  const srcIds = matrixSources.map(({ source }) => source.id);
  const dstIds = destinations.map((d) => d.newId);
  const neededIds = await selectHydrationIds(ctx, srcIds, dstIds, threshold);
  const fingerprints = await hydrateFingerprints(ctx, neededIds, new Map());

  const candidates = buildMatrix(matrixSources, destinations, fingerprints, threshold);
  candidates.sort(compareCandidates);

  const selected = selectPairs(candidates, uses, { copies: copies !== 'off', threshold });
  return {
    pairs: selected.pairs,
    consumedAdds: new Set<AddChange>(selected.pairs.map((pair) => pair.destination)),
    uses: selected.uses,
  };
}

/** Tracking record for a modify or type change that was split into synthetic
 *  delete+add halves. A type change's record is always built at `MAX_SCORE`
 *  (git breaks every file↔symlink type change unconditionally, no blob read). */
interface BrokenRecord {
  readonly original: ModifyChange | TypeChangeChange;
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

/** git's `should_break` never attempts a break below this size (`diffcore-break.c:13`). */
const MINIMUM_BREAK_SIZE = 400;

/**
 * git's `should_break` size guards, checked against sizes the caller already
 * hydrated (no new read): a pair under MINIMUM_BREAK_SIZE never breaks (S1),
 * and neither does an empty source (S0) — both are evaluated before any
 * scoring, in `should_break`'s own order (`diffcore-break.c:13`).
 */
function isBreakSizeGuarded(srcSize: number, dstSize: number): boolean {
  if (Math.max(srcSize, dstSize) < MINIMUM_BREAK_SIZE) return true;
  return srcSize === 0;
}

/**
 * Compute git's break-attempt gate score and merge-score for a (src, dst) blob pair.
 * Callers only reach this once `isBreakSizeGuarded` has cleared the pair, so
 * maxSize and srcSize are both guaranteed positive here.
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
  const computedBreakScore = Math.trunc((rawBreakNum * MAX_SCORE) / maxSize);
  const dissimilarity = Math.trunc((srcRemoved * MAX_SCORE) / srcSize);
  return { computedBreakScore, dissimilarity };
}

interface ModifyScore {
  readonly mod: ModifyChange;
  readonly computedBreakScore: number;
  readonly dissimilarity: number;
}

/** A guarded pair never attempts a break: score 0 always sits below any
 *  effective breakScore (0 maps to DEFAULT_BREAK_SCORE, never 0 itself). */
const GUARDED_SCORES: BreakScores = { computedBreakScore: 0, dissimilarity: 0 };

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
  const { computedBreakScore, dissimilarity } = isBreakSizeGuarded(oldBytes.length, newBytes.length)
    ? GUARDED_SCORES
    : computeBreakScores(oldBytes, newBytes);
  return { mod, computedBreakScore, dissimilarity };
}

function toSyntheticDelete(change: ModifyChange | TypeChangeChange): DeleteChange {
  return { type: 'delete', oldPath: change.path, oldId: change.oldId, oldMode: change.oldMode };
}

function toSyntheticAdd(change: ModifyChange | TypeChangeChange): AddChange {
  return { type: 'add', newPath: change.path, newId: change.newId, newMode: change.newMode };
}

/** git's OBJ_BLOB check: a breakable side is a regular file or a symlink —
 *  a gitlink or a directory-mode entry never enters the break-attempt pass. */
function isBreakableKind(mode: FileMode): boolean {
  const kind = kindOf(mode);
  return kind === 'file' || kind === 'symlink';
}

function isBreakableTypeChange(change: TypeChangeChange): boolean {
  return isBreakableKind(change.oldMode) && isBreakableKind(change.newMode);
}

/** A file↔symlink type change breaks unconditionally at MAX_SCORE, before any
 *  oid, size or empty check — no blob is ever read (git's diffcore-break.c,
 *  the type-change branch runs ahead of `should_break`'s own guards). */
function toTypeChangeRecord(change: TypeChangeChange): BrokenRecord {
  return {
    original: change,
    del: toSyntheticDelete(change),
    add: toSyntheticAdd(change),
    dissimilarity: MAX_SCORE,
  };
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

/** Replace broken modifies and type changes in the change list with their
 *  synthetic delete+add halves. */
function patchDiffWithBroken(
  diff: TreeDiff,
  records: ReadonlyArray<BrokenRecord>,
  brokenPaths: ReadonlySet<FilePath>,
): TreeDiff {
  const byPath = new Map<FilePath, BrokenRecord>(records.map((r) => [r.original.path, r]));
  const patchedChanges: DiffChange[] = [];
  for (const change of diff.changes) {
    const isBreakableChange = change.type === 'modify' || change.type === 'type-change';
    const record =
      isBreakableChange && brokenPaths.has(change.path) ? byPath.get(change.path) : undefined;
    if (record !== undefined) {
      patchedChanges.push(record.del, record.add);
    } else {
      patchedChanges.push(change);
    }
  }
  return { changes: patchedChanges };
}

/** Every type change whose both sides are breakable (file↔symlink) breaks
 *  unconditionally — a gitlink or directory side never does (G3). */
function collectBreakableTypeChanges(diff: TreeDiff): TypeChangeChange[] {
  return diff.changes.filter(
    (c): c is TypeChangeChange => c.type === 'type-change' && isBreakableTypeChange(c),
  );
}

/**
 * Attempt to break dissimilar modifies and file↔symlink type changes into
 * synthetic delete+add pairs. A type change never enters `scoreModifies` — it
 * is unconditionally broken (`toTypeChangeRecord`), no blob ever read.
 * Returns the broken records and a new diff with those changes replaced.
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
    (c): c is ModifyChange => c.type === 'modify' && isBreakableKind(c.oldMode),
  );
  const typeChanges = collectBreakableTypeChanges(diff);
  // Stryker disable next-line ConditionalExpression: equivalent — no breakable modify or type change produces empty records, matching the identical { broken: [], patchedDiff: diff } the records.length===0 guard below returns.
  if (modifies.length === 0 && typeChanges.length === 0) return { broken: [], patchedDiff: diff };

  const scored = await scoreModifies(ctx, modifies, breakScore);
  const records = [...scored.records, ...typeChanges.map(toTypeChangeRecord)];
  // Stryker disable next-line ConditionalExpression: equivalent — empty records means every source path set stays empty too, so patchDiffWithBroken copies changes unchanged, matching the early return.
  if (records.length === 0) return { broken: [], patchedDiff: diff };

  const paths = new Set<FilePath>([...scored.paths, ...typeChanges.map((c) => c.path)]);
  return { broken: records, patchedDiff: patchDiffWithBroken(diff, records, paths) };
}

/** Rejoin a broken pair's synthetic halves into one modify: `broken` set when
 *  the pair's dissimilarity still clears the merge gate, plain otherwise
 *  (git's `merge_broken`, `diffcore-break.c:239`). */
function rejoinBroken(record: BrokenRecord, mergeScore: number): DiffChange {
  if (record.dissimilarity >= mergeScore) {
    return { ...record.original, broken: { score: record.dissimilarity, maxScore: MAX_SCORE } };
  }
  return record.original;
}

/** Maps each broken record's synthetic delete to its registry source index —
 *  `originalDeletes` is aligned with the registry's sources, and a
 *  broken-delete's own synthetic delete is the object identity write back
 *  keys on to find which source's use count to bump on a rejoin. */
function indexBrokenSources(
  originalDeletes: ReadonlyArray<DeleteChange | undefined>,
): ReadonlyMap<DeleteChange, number> {
  const bySourceDelete = new Map<DeleteChange, number>();
  originalDeletes.forEach((del, index) => {
    if (del !== undefined) bySourceDelete.set(del, index);
  });
  return bySourceDelete;
}

interface WriteBackOutcome {
  readonly unpaired: ReadonlyArray<AddChange>;
  readonly uses: ReadonlyArray<number>;
  readonly rejoined: ReadonlyArray<DiffChange>;
}

/**
 * git's write back (`diffcore-rename.c:1669`): a broken delete's add half
 * paired elsewhere means the pairing stands in for the broken change, so the
 * delete drops whatever its own use count (S2). Otherwise the halves rejoin
 * (`rejoinBroken`) and the rejoin itself counts as one more use of the
 * delete-half's source (K1, K2) — this runs BEFORE `labelRenameCopy`, so a
 * rejoined source's other pairs count it as a copy, not a rename.
 */
function writeBackBroken(
  broken: ReadonlyArray<BrokenRecord>,
  originalDeletes: ReadonlyArray<DeleteChange | undefined>,
  unpaired: ReadonlyArray<AddChange>,
  uses: ReadonlyArray<number>,
  mergeScore: number,
): WriteBackOutcome {
  const sourceIndexByDelete = indexBrokenSources(originalDeletes);
  const unpairedSet = new Set(unpaired);
  const workingUses = [...uses];
  const rejoined: DiffChange[] = [];
  const absorbedAdds = new Set<AddChange>();

  for (const record of broken) {
    if (!unpairedSet.has(record.add)) continue; // add half paired: drop the delete, whatever its uses

    rejoined.push(rejoinBroken(record, mergeScore));
    absorbedAdds.add(record.add);
    const sourceIndex = sourceIndexByDelete.get(record.del) as number;
    workingUses[sourceIndex] = (workingUses[sourceIndex] as number) + 1;
  }

  return {
    unpaired: unpaired.filter((add) => !absorbedAdds.has(add)),
    uses: workingUses,
    rejoined,
  };
}

/**
 * Detect exact and inexact (content-similarity) renames, and optionally
 * copies, with optional -B break-rewrite detection.
 *
 * Fixed order when breakRewrites is set:
 * 1. Break-attempt: split dissimilar modifies into synthetic delete+add halves so
 *    they feed the registry. This runs BEFORE registration.
 * 2. registerCandidates: one path-ordered RenameSource registry (deletes,
 *    broken-delete halves, and — under copies — modify/type-change preimages
 *    and, under `harder`, every untouched preimage path).
 * 3. pairIdenticalFiles: the copy-aware exact pass, never limited — 'rename'
 *    mode when copies is off, 'copy' mode otherwise.
 * 4. Cull: copies on or any broken pair keeps every source; otherwise only
 *    unused sources feed the matrix.
 * 5. Rename-limit gate on the leftovers: num_dst times num_src over limit
 *    squared skips the inexact pass; under `harder` a retry drops `unchanged`
 *    sources first.
 * 6. Size-gate the candidate pool above SIZE_GATE_MIN_IDS unique ids, then
 *    fingerprint-and-drop each needed blob via a bounded concurrency pool —
 *    only the fingerprint escapes the worker, never the blob's own bytes.
 * 7. buildMatrix: one shared NUM_CANDIDATE_PER_DST-slot candidate matrix per
 *    destination over every matrix source (used ones included) — gitlinks
 *    drop out on both sides, since content scoring cannot read a gitlink's
 *    commit object as bytes.
 * 8. selectPairs: pass 1 pairs only zero-use sources; pass 2 (copies on)
 *    pairs any remaining source against any remaining destination.
 * 9. writeBack: a broken-delete's add half paired elsewhere drops its delete
 *    (whatever its own use count, S2); otherwise the halves rejoin into a
 *    modify (plain or broken) and the rejoin counts as one more use of the
 *    delete-half's source (K1, K2) — this runs BEFORE labelRenameCopy.
 * 10. labelRenameCopy: every exact+inexact pair becomes a rename or copy by
 *     final use count (post write back) in destination-path order; unpaired
 *     destinations stay adds; a deleted source's delete survives iff nothing
 *     beyond its seed used it.
 */

/** Resolve the effective merge score from the breakRewrites option (or defaults). */
function resolveEffectiveMergeScore(breakRewrites: RenameDetectOptions['breakRewrites']): number {
  const opts =
    breakRewrites !== false && breakRewrites !== undefined
      ? breakRewrites
      : { score: DEFAULT_BREAK_SCORE, merge: DEFAULT_MERGE_SCORE };
  return resolveBreakGates(opts).mergeScore;
}

/** Sort the assembled changes into git's queue order — every broken pair has
 *  already been written back (dropped, rejoined, or replaced by its pairing)
 *  earlier in the pipeline, so this step is a plain sort. */
function finalizeWithBroken(changes: ReadonlyArray<DiffChange>): TreeDiff {
  return { changes: sortByPath(changes, primaryPath) };
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

function cullMatrixSourceIndices(
  sourceCount: number,
  uses: ReadonlyArray<number>,
  keepEverySource: boolean,
): number[] {
  const indices = Array.from({ length: sourceCount }, (_, index) => index);
  return keepEverySource ? indices : indices.filter((index) => uses[index] === 0);
}

function isOverLimit(numDst: number, numSrc: number, limit: number): boolean {
  return limit !== 0 && numDst * numSrc > limit * limit;
}

interface MatrixPlan {
  readonly indices: ReadonlyArray<number>;
}

/**
 * git's rename-limit gate: num_dst is every destination the exact pass left
 * unpaired, num_src is every matrix source after the cull step, each counted
 * once regardless of mode — symlinks and gitlinks included, the inexact pass
 * drops them again only when actually scoring. Under `copies: 'harder'`, an over-limit
 * retries once with `unchanged` sources dropped.
 */
function resolveMatrixPlan(
  sources: ReadonlyArray<RenameSource>,
  numDst: number,
  uses: ReadonlyArray<number>,
  keepEverySource: boolean,
  copies: 'off' | 'on' | 'harder',
  limit: number,
): MatrixPlan | null {
  if (numDst === 0) return null;
  const indices = cullMatrixSourceIndices(sources.length, uses, keepEverySource);
  if (indices.length === 0) return null;
  if (!isOverLimit(numDst, indices.length, limit)) return { indices };
  if (copies !== 'harder') return null;

  const retryIndices = indices.filter(
    (index) => (sources[index] as RenameSource).origin !== 'unchanged',
  );
  if (retryIndices.length === 0 || isOverLimit(numDst, retryIndices.length, limit)) return null;
  return { indices: retryIndices };
}

/**
 * A `deleted` source's delete survives iff nothing beyond its seed (always 0)
 * used it — i.e. zero real pairs named it. A `broken-delete` source's delete
 * is decided entirely by `writeBackBroken` (S2): it is dropped or rejoined
 * there, and never survives standalone, so it is excluded here.
 */
function isSourceDeletePresent(source: RenameSource, finalUses: number): boolean {
  return source.origin === 'deleted' && finalUses === source.seedUses;
}

function survivingDeletes(
  sources: ReadonlyArray<RenameSource>,
  originalDeletes: ReadonlyArray<DeleteChange | undefined>,
  finalUses: ReadonlyArray<number>,
): DeleteChange[] {
  const deletes: DeleteChange[] = [];
  sources.forEach((source, index) => {
    if (isSourceDeletePresent(source, finalUses[index] as number)) {
      deletes.push(originalDeletes[index] as DeleteChange);
    }
  });
  return deletes;
}

function toLabelledChange(
  sources: ReadonlyArray<RenameSource>,
  labelled: LabelledPair,
): RenameChange | CopyChange {
  const source = sources[labelled.pair.source] as RenameSource;
  const { destination, score } = labelled.pair;
  return labelled.kind === 'rename'
    ? buildRenameChange(source, destination, score)
    : buildCopyChange(source, destination, score);
}

/**
 * Assemble the final change list from the registry: `labelRenameCopy` turns
 * every exact+inexact pair into a rename or copy (by use count AFTER write
 * back), unpaired destinations stay adds, and a deleted source's delete
 * survives iff nothing beyond its seed used it. `rejoined` carries the
 * modifies write back produced for broken pairs whose add half stayed
 * unpaired. Modified/unchanged sources emit nothing here — their change
 * already lives in `other`.
 */
function assembleFromRegistry(
  registry: CandidateRegistry,
  allPairs: ReadonlyArray<SourcePair>,
  unpaired: ReadonlyArray<AddChange>,
  finalUses: ReadonlyArray<number>,
  rejoined: ReadonlyArray<DiffChange>,
): DiffChange[] {
  const { sources, originalDeletes, other } = registry;
  const labelled = labelRenameCopy(allPairs, finalUses);
  const renamesAndCopies = labelled.map((entry) => toLabelledChange(sources, entry));
  return [
    ...unpaired,
    ...survivingDeletes(sources, originalDeletes, finalUses),
    ...renamesAndCopies,
    ...rejoined,
    ...other,
  ];
}

interface InexactPhaseOutcome {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly unpaired: ReadonlyArray<AddChange>;
  readonly uses: ReadonlyArray<number>;
}

/** git's estimate_similarity requires S_ISREG on both sides — a symlink or
 *  gitlink never gets an inexact score, and its blob is never hydrated. */
function isRegularFile(mode: FileMode): boolean {
  return kindOf(mode) === 'file';
}

/** Runs the inexact matrix only when the rename-limit gate allows it — git's
 *  estimate_similarity scores regular files only, so a non-regular (symlink,
 *  gitlink) source is dropped from the matrix, and so is a non-regular
 *  destination, matching the source-side drop. */
async function runInexactMatrixIfPlanned(
  ctx: Context,
  registry: CandidateRegistry,
  exact: ExactPairing,
  copies: 'off' | 'on' | 'harder',
  threshold: number,
  limit: number,
  keepEverySource: boolean,
): Promise<InexactMatrixResult | null> {
  const plan = resolveMatrixPlan(
    registry.sources,
    exact.unpaired.length,
    exact.uses,
    keepEverySource,
    copies,
    limit,
  );
  if (plan === null) return null;

  const matrixIndices = plan.indices.filter((index) =>
    isRegularFile((registry.sources[index] as RenameSource).mode),
  );
  const matrixDestinations = exact.unpaired.filter((add) => isRegularFile(add.newMode));
  return runInexactMatrix(
    ctx,
    registry.sources,
    matrixIndices,
    matrixDestinations,
    exact.uses,
    threshold,
    copies,
  );
}

/** Folds an inexact-matrix result into the exact pass's pairs/unpaired/uses;
 *  a pass-through of the exact pass alone when the matrix never ran. */
function mergeInexactOutcome(
  exact: ExactPairing,
  inexact: InexactMatrixResult | null,
): InexactPhaseOutcome {
  if (inexact === null) return { pairs: exact.pairs, unpaired: exact.unpaired, uses: exact.uses };
  return {
    pairs: [...exact.pairs, ...inexact.pairs],
    unpaired: exact.unpaired.filter((add) => !inexact.consumedAdds.has(add)),
    uses: inexact.uses,
  };
}

async function runInexactPhase(
  ctx: Context,
  registry: CandidateRegistry,
  exact: ExactPairing,
  broken: ReadonlyArray<BrokenRecord>,
  copies: 'off' | 'on' | 'harder',
  threshold: number,
  limit: number,
): Promise<InexactPhaseOutcome> {
  const keepEverySource = copies !== 'off' || broken.length > 0;
  const inexact = await runInexactMatrixIfPlanned(
    ctx,
    registry,
    exact,
    copies,
    threshold,
    limit,
    keepEverySource,
  );
  return mergeInexactOutcome(exact, inexact);
}

export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
  preimage?: ReadonlyMap<FilePath, FlatTreeEntry>,
): Promise<TreeDiff> {
  const { threshold, limit, copies, breakRewrites } = resolveDetectOptions(options);
  const mergeScore = resolveEffectiveMergeScore(breakRewrites);

  // Break-attempt pass: runs BEFORE registration so halves feed the registry.
  const { broken, workingDiff } = await runBreakPass(ctx, diff, breakRewrites);
  const registry = registerCandidates(workingDiff, broken, copies, preimage, mergeScore);

  // The exact pass is never limited; it always sees every registered source.
  const exactMode = copies === 'off' ? 'rename' : 'copy';
  const exact = pairIdenticalFiles(registry.sources, registry.destinations, exactMode);

  const outcome = await runInexactPhase(ctx, registry, exact, broken, copies, threshold, limit);
  const writeBack = writeBackBroken(
    broken,
    registry.originalDeletes,
    outcome.unpaired,
    outcome.uses,
    mergeScore,
  );
  const changes = assembleFromRegistry(
    registry,
    outcome.pairs,
    writeBack.unpaired,
    writeBack.uses,
    writeBack.rejoined,
  );
  return finalizeWithBroken(changes);
}
