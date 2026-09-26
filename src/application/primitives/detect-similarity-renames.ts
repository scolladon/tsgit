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
import { isGitlink } from '../../domain/diff/index.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import type { RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  compareCandidates,
  type ExactPairing,
  hasSameBasename,
  type LabelledPair,
  labelRenameCopy,
  pairIdenticalFiles,
  type RenameSource,
  type SourcePair,
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
 * Interim shape for the matrix triple-builders below (`buildRenameTriples`,
 * `buildCopyTriples`), unchanged since before the registry existed. `registerCandidates`
 * and its adapters (`toDeleteChangeShape`, `toCopySourceShape`) are the sole producers
 * now — Part 8 removes both this shape and the builders that consume it.
 */
interface CopySource {
  readonly oldPath: FilePath;
  readonly oldId: ObjectId;
  readonly oldMode: FileMode;
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

/** Builds the candidate change `greedySelect` carries a matched triple's score in
 *  (interim — Part 8 removes this alongside `ScoredTriple`); the FINAL emitted
 *  change is `buildRenameChange`/`buildCopyChange` below, generalised over the
 *  registry's `RenameSource`. */
function buildCandidateRenameChange(
  del: DeleteChange,
  add: AddChange,
  score: number,
): RenameChange {
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

function buildCandidateCopyChange(src: CopySource, add: AddChange, score: number): CopyChange {
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
        change: buildCandidateRenameChange(triple.src, triple.add, triple.score),
        del: triple.src,
        add: triple.add,
      });
    } else {
      // Copy: only the add is consumed; the copy source is NOT consumed (retained in result set).
      // Discriminated union: triple.src is CopySource here — no cast needed.
      usedAdds.add(triple.add);
      matches.push({
        kind: 'copy',
        change: buildCandidateCopyChange(triple.src, triple.add, triple.score),
        add: triple.add,
      });
    }
  }

  return matches;
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
 *  (object identity `findPresentHalves` still keys a broken-delete's presence
 *  on) — `undefined` for a `modified`/`unchanged` source, which has no delete. */
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
 * rename-limit count need gitlinks too; the inexact matrix drops them again
 * (blob-only content scoring cannot read a gitlink's commit object as bytes).
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
    // Stryker disable next-line ConditionalExpression: equivalent — buildMatrixSourceSets already returns an empty copySources whenever copies==='off', so buildCopyTriples over it yields [], identical to the : [] arm.
    copies !== 'off' ? buildCopyTriples(copySources, adds, fingerprints, threshold) : [];
  const allTriples: ScoredTriple[] = [...renameTriples, ...copyTriples];
  sortTriples(allTriples);
  return allTriples;
}

/** Adapts one matrix source into the shape `buildRenameTriples` expects. */
function toDeleteChangeShape(source: RenameSource): DeleteChange {
  return { type: 'delete', oldPath: source.path, oldId: source.id, oldMode: source.mode };
}

/** Adapts one matrix source into the shape `buildCopyTriples` expects. */
function toCopySourceShape(source: RenameSource): CopySource {
  return { oldPath: source.path, oldId: source.id, oldMode: source.mode };
}

function isRenameEligible(source: RenameSource, uses: number): boolean {
  return (source.origin === 'deleted' || source.origin === 'broken-delete') && uses === 0;
}

interface IndexedSource {
  readonly index: number;
  readonly source: RenameSource;
}

interface MatrixSourceSets {
  readonly renameDeletes: ReadonlyArray<DeleteChange>;
  readonly copySources: ReadonlyArray<CopySource>;
}

/**
 * Interim matrix adapter (Part 8 replaces): feeds the still-unchanged triple
 * builders from the registry. Rename candidates are matrix sources with a
 * deleted/broken-delete origin still at zero uses; copy candidates (copies
 * on) are every matrix source — a used one stays eligible. Both drop
 * gitlinks: content scoring cannot read a gitlink's commit object as bytes.
 */
function buildMatrixSourceSets(
  sources: ReadonlyArray<RenameSource>,
  indices: ReadonlyArray<number>,
  uses: ReadonlyArray<number>,
  copies: 'off' | 'on' | 'harder',
): MatrixSourceSets {
  const eligible: IndexedSource[] = indices
    .map((index) => ({ index, source: sources[index] as RenameSource }))
    .filter(({ source }) => !isGitlink(source.mode));
  const renameDeletes = eligible
    .filter(({ index, source }) => isRenameEligible(source, uses[index] as number))
    .map(({ source }) => toDeleteChangeShape(source));
  const copySources =
    copies !== 'off' ? eligible.map(({ source }) => toCopySourceShape(source)) : [];
  return { renameDeletes, copySources };
}

interface InexactMatrixResult {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly consumedAdds: ReadonlySet<AddChange>;
}

function buildPathIndex(sources: ReadonlyArray<RenameSource>): ReadonlyMap<FilePath, number> {
  return new Map(sources.map((source, index) => [source.path, index]));
}

/**
 * Recovers which registry source a `greedySelect` match actually paired: every
 * registered source has a unique path, and the adapter above set the
 * candidate change's `oldPath` from that same source, so the match's own
 * `oldPath` is enough — rename and copy matches resolve identically.
 */
function toRegistryPair(match: GreedyMatch, pathIndex: ReadonlyMap<FilePath, number>): SourcePair {
  return {
    source: pathIndex.get(match.change.oldPath) as number,
    destination: match.add,
    score: match.change.similarity.score,
  };
}

async function runInexactMatrix(
  ctx: Context,
  sources: ReadonlyArray<RenameSource>,
  matrixSourceSets: MatrixSourceSets,
  destinations: ReadonlyArray<AddChange>,
  threshold: number,
  copies: 'off' | 'on' | 'harder',
): Promise<InexactMatrixResult | null> {
  const { renameDeletes, copySources } = matrixSourceSets;
  // Stryker disable next-line ConditionalExpression: equivalent — with both empty the pass builds no triples and greedySelect returns [], the same as the null-defaulted caller path.
  if (renameDeletes.length === 0 && copySources.length === 0) return null;

  const allSrcIds = [...renameDeletes.map((d) => d.oldId), ...copySources.map((s) => s.oldId)];
  const dstIds = destinations.map((d) => d.newId);
  const neededIds = await selectHydrationIds(ctx, allSrcIds, dstIds, threshold);
  const fingerprints = await hydrateFingerprints(ctx, neededIds, new Map());
  const allTriples = buildAllTriples(
    renameDeletes,
    destinations,
    copySources,
    copies,
    threshold,
    fingerprints,
  );

  const matches = greedySelect(allTriples);
  const pathIndex = buildPathIndex(sources);
  return {
    pairs: matches.map((match) => toRegistryPair(match, pathIndex)),
    consumedAdds: new Set<AddChange>(matches.map((match) => match.add)),
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
 * 7. Build scored triples: rename candidates are zero-use deleted/broken-delete
 *    sources, copy candidates (copies on) are every matrix source (used ones
 *    stay eligible). Both drop gitlinks — content scoring cannot read a
 *    gitlink's commit object as bytes.
 * 8. Greedy score-descending selection (`greedySelect`, unchanged).
 * 9. labelRenameCopy: every exact+inexact pair becomes a rename or copy by
 *    final use count in destination-path order; unpaired destinations stay
 *    adds; a deleted/broken-delete source's delete survives iff nothing
 *    beyond its seed used it.
 * 10. Keep-broken/re-merge: for broken pairs with neither half consumed, emit
 *     a single modify with a broken datum (if dissimilarity >= mergeScore) or
 *     a plain modify.
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
 * once regardless of mode — gitlinks included, the inexact pass drops them
 * again only when actually scoring. Under `copies: 'harder'`, an over-limit
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

function applyMatchUses(
  pairs: ReadonlyArray<SourcePair>,
  baseUses: ReadonlyArray<number>,
): number[] {
  const uses = [...baseUses];
  for (const pair of pairs) uses[pair.source] = (uses[pair.source] as number) + 1;
  return uses;
}

/**
 * A `deleted`/`broken-delete` source's delete survives iff nothing beyond its
 * seed used it — for a plain delete (seed 0) that means zero real pairs; for
 * a broken-delete (seed 0 or 1) this restates git's rule: the delete drops
 * once usage exceeds the one implicit use its own seed already accounts for.
 */
function isSourceDeletePresent(source: RenameSource, finalUses: number): boolean {
  return (
    (source.origin === 'deleted' || source.origin === 'broken-delete') &&
    finalUses === source.seedUses
  );
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
 * every exact+inexact pair into a rename or copy, unpaired destinations stay
 * adds, and a deleted/broken-delete source's delete survives iff nothing
 * beyond its seed used it. Modified/unchanged sources emit nothing here —
 * their change already lives in `other`.
 */
function assembleFromRegistry(
  registry: CandidateRegistry,
  allPairs: ReadonlyArray<SourcePair>,
  unpaired: ReadonlyArray<AddChange>,
  finalUses: ReadonlyArray<number>,
): DiffChange[] {
  const { sources, originalDeletes, other } = registry;
  const labelled = labelRenameCopy(allPairs, finalUses);
  const renamesAndCopies = labelled.map((entry) => toLabelledChange(sources, entry));
  return [
    ...unpaired,
    ...survivingDeletes(sources, originalDeletes, finalUses),
    ...renamesAndCopies,
    ...other,
  ];
}

interface InexactPhaseOutcome {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly unpaired: ReadonlyArray<AddChange>;
  readonly uses: ReadonlyArray<number>;
}

/** Runs the inexact matrix only when the rename-limit gate allows it — content
 *  scoring cannot read a gitlink's commit object as bytes, so gitlink
 *  destinations never reach it either, matching the source-side drop. */
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

  const matrixSourceSets = buildMatrixSourceSets(
    registry.sources,
    plan.indices,
    exact.uses,
    copies,
  );
  const matrixDestinations = exact.unpaired.filter((add) => !isGitlink(add.newMode));
  return runInexactMatrix(
    ctx,
    registry.sources,
    matrixSourceSets,
    matrixDestinations,
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
    uses: applyMatchUses(inexact.pairs, exact.uses),
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
  const changes = assembleFromRegistry(registry, outcome.pairs, outcome.unpaired, outcome.uses);
  return finalizeWithBroken(changes, broken, mergeScore);
}
