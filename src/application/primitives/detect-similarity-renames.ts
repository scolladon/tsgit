import type { BinaryOverride } from '../../domain/diff/binary-decision.js';
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
  basenameOf,
  compareCandidates,
  type ExactPairing,
  type LabelledPair,
  labelRenameCopy,
  type MatrixCandidate,
  pairIdenticalFiles,
  type RenameSource,
  type SourcePair,
  selectPairs,
  uniqueBasenamePairs,
} from '../../domain/diff/rename-pairing.js';
import {
  buildFingerprint,
  type ContentKind,
  contentKindOf,
  countSpanhashChanges,
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarityFromFingerprints,
  MAX_SCORE,
  type SpanFingerprint,
} from '../../domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { boundedMapFor } from './internal/concurrency.js';
import {
  buildSimilarityContentKindResolver,
  type SimilarityContentKindResolver,
} from './internal/resolve-similarity-content-kind.js';
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
  readonly fingerprint: SpanFingerprint;
  readonly size: number;
}

/**
 * Cache bucket a fingerprint is built for: an explicit `ContentKind` when a
 * path's `diff` attribute forces one, or `'sniff'` when it defers to the
 * blob's own content sniff. git's `diff_filespec_is_binary` decides per
 * filespec (path), never by object id — the SAME blob can need a `'sniff'`
 * fingerprint at one path and an explicit-kind one at another, so the cache
 * must hold both for one id at once.
 */
export type CacheBucket = ContentKind | 'sniff';

function bucketFor(override: BinaryOverride | undefined): CacheBucket {
  return override ?? 'sniff';
}

/**
 * Composite fingerprint-cache key: at most one entry per distinct (id,
 * bucket) pair — never more than the 3 possible buckets per id. A `'sniff'`
 * entry always ALIASES whichever explicit-kind fingerprint it resolves to
 * rather than duplicating the build (`buildEntriesForId`), so a blob still
 * fingerprints once per distinct CONTENT KIND — the third bucket only adds
 * an extra index onto an already-built fingerprint, never an extra build.
 */
export type FingerprintKey = `${ObjectId}\u0000${CacheBucket}`;

/** @internal — exported for direct unit testing. */
export function fingerprintKey(id: ObjectId, bucket: CacheBucket): FingerprintKey {
  return `${id}\u0000${bucket}`;
}

function idOfFingerprintKey(key: FingerprintKey): ObjectId {
  return key.slice(0, key.indexOf('\u0000')) as ObjectId;
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

/**
 * git's `estimate_similarity`: a non-regular side (missing fingerprint, never
 * hydrated) or a size-incompatible pair scores 0 rather than being skipped —
 * the caller still needs a score to feed `record_if_better`.
 */
function estimatePairSimilarity(
  sf: BlobFingerprint | undefined,
  df: BlobFingerprint | undefined,
  threshold: number,
): number {
  if (sf === undefined || df === undefined) return 0;
  if (isSizeRejected(sf.size, df.size, threshold)) return 0;
  return estimateSimilarityFromFingerprints(sf.fingerprint, sf.size, df.fingerprint, df.size);
}

/**
 * git's `record_if_better` is called for EVERY (src, dst) pair the matrix
 * loop visits, never only the ones clearing the threshold — a size-rejected,
 * non-regular, or below-threshold candidate still occupies a slot at score 0,
 * and that slot's position decides the stable sort's tie-break among
 * equal-ranked candidates later. `selectPairs` is where the threshold gate
 * actually applies, not here.
 *
 * git itself computes `name_score` for EVERY visited pair, unconditionally —
 * the two basenames are compared here only when `score >= threshold`, an
 * equivalent simplification: a below-threshold candidate's nameScore can
 * never change `selectPairs`'s outcome (it's never selected) and can never
 * displace a higher-scoring slot occupant either (`compareCandidates` ranks
 * by score first), so the two candidates it actually decides among always
 * already share the winning score.
 */
function scoreAndRecord(
  sf: BlobFingerprint | undefined,
  df: BlobFingerprint | undefined,
  threshold: number,
  candidate: { readonly source: number; readonly destination: AddChange },
  sourceBasename: string,
  destinationBasename: string,
  slots: MatrixCandidate[],
): void {
  const score = estimatePairSimilarity(sf, df, threshold);
  const nameScore = score >= threshold && sourceBasename === destinationBasename ? 1 : 0;
  recordIfBetter(slots, { ...candidate, score, nameScore });
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

/** The setup loop's own working state, before any `copies: 'harder'`
 *  unchanged-source registration runs. */
interface ClassifiedChanges {
  readonly destinations: ReadonlyArray<AddChange>;
  readonly other: ReadonlyArray<DiffChange>;
  readonly registered: ReadonlyArray<RegisteredSource>;
  readonly touchedPaths: ReadonlySet<FilePath>;
}

/** Visits every change once: an add becomes a destination, a delete always
 *  registers (seeding its origin from any matching broken record), and
 *  everything else defers to `registerOtherChange`. */
function classifyChanges(
  workingDiff: TreeDiff,
  brokenByDel: ReadonlyMap<DeleteChange, BrokenRecord>,
  copies: 'off' | 'on' | 'harder',
  mergeScore: number,
): ClassifiedChanges {
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

  return { destinations, other, registered, touchedPaths };
}

/** Path-orders every registered source (the setup loop's own, plus any
 *  `copies: 'harder'` unchanged sources) and assembles the registry. */
function buildRegistry(
  classified: ClassifiedChanges,
  unchangedSources: ReadonlyArray<RenameSource>,
): CandidateRegistry {
  const registered: RegisteredSource[] = [
    ...classified.registered,
    ...unchangedSources.map((source) => ({ source })),
  ];
  const ordered = sortByPath(registered, (entry) => entry.source.path);
  return {
    sources: ordered.map((entry) => entry.source),
    originalDeletes: ordered.map((entry) => entry.originalDelete),
    destinations: classified.destinations,
    other: classified.other,
  };
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
  const classified = classifyChanges(workingDiff, brokenByDel, copies, mergeScore);
  const unchangedSources =
    copies === 'harder' ? collectUnchangedSources(preimage, classified.touchedPaths) : [];
  return buildRegistry(classified, unchangedSources);
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
 * git's rename-limit size prefilter at the ID level: an id is
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
 * Declared sizes for `ids`, reusing an already-known size (`knownSizes`)
 * instead of paying for a redundant size-only read — a size is
 * kind-invariant, so ANY already-hydrated bucket for that id carries the
 * same byte length a size read would return.
 */
async function declaredSizesReusingFingerprints(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
  knownSizes: ReadonlyMap<ObjectId, number>,
): Promise<ReadonlyMap<ObjectId, number>> {
  const unknownIds = ids.filter((id) => !knownSizes.has(id));
  const sizes = new Map(await readDeclaredSizes(ctx, unknownIds));
  for (const id of ids) {
    const size = knownSizes.get(id);
    if (size !== undefined) sizes.set(id, size);
  }
  return sizes;
}

/**
 * Which ids actually need fingerprinting for one inexact pass:
 * at or below `SIZE_GATE_MIN_IDS` unique ids, every one of them (no size
 * read pays for itself below the gate — the common small-diff path never
 * touches it); above it, only the ids `sizeCompatibleIds` keeps. `knownSizes`
 * (sizes already known from an earlier pass, e.g. the basename pass or a
 * broken modify's break-attempt read) seeds the size map for free.
 */
async function selectHydrationIds(
  ctx: Context,
  srcIds: ReadonlyArray<ObjectId>,
  dstIds: ReadonlyArray<ObjectId>,
  threshold: number,
  knownSizes: ReadonlyMap<ObjectId, number>,
): Promise<ReadonlyArray<ObjectId>> {
  const unique = Array.from(new Set([...srcIds, ...dstIds]));
  if (unique.length <= SIZE_GATE_MIN_IDS) return unique;
  const sizes = await declaredSizesReusingFingerprints(ctx, unique, knownSizes);
  return Array.from(sizeCompatibleIds(sizes, srcIds, dstIds, threshold));
}

/** One (id, path) pair a hydration call needs — the path is what
 *  `resolveOverridesFor` resolves a similarity content-kind override from;
 *  the id is what the fingerprint ends up keyed by. */
export interface PathedId {
  readonly id: ObjectId;
  readonly path: FilePath;
}

/**
 * Resolve `resolver.overrideFor` for every DISTINCT path in `entries`. git's
 * `diff_filespec_is_binary` decides per filespec (PATH), never by object id,
 * so two paths sharing one id are resolved INDEPENDENTLY here — a path asked
 * about again by a later pass hits the resolver's own per-path cache, so
 * repeating the call across passes costs nothing.
 */
async function resolveOverridesFor(
  resolver: SimilarityContentKindResolver,
  entries: ReadonlyArray<PathedId>,
): Promise<ReadonlyMap<FilePath, BinaryOverride | undefined>> {
  const overrides = new Map<FilePath, BinaryOverride | undefined>();
  for (const { path } of entries) {
    if (overrides.has(path)) continue;
    overrides.set(path, await resolver.overrideFor(path));
  }
  return overrides;
}

/** Every distinct cache bucket `paths` resolves to, via `overridesByPath`. */
function bucketsOf(
  paths: ReadonlyArray<FilePath>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>,
): Set<CacheBucket> {
  return new Set(paths.map((path) => bucketFor(overridesByPath.get(path))));
}

/** Groups `entries` by id, resolving each id's required cache buckets — an
 *  id whose entries all share one path's attribute needs exactly one; an id
 *  split across two differently-attributed paths needs two. */
function requiredBucketsById(
  entries: ReadonlyArray<PathedId>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>,
): ReadonlyMap<ObjectId, ReadonlySet<CacheBucket>> {
  const pathsById = new Map<ObjectId, FilePath[]>();
  for (const { id, path } of entries) {
    const paths = pathsById.get(id) ?? [];
    paths.push(path);
    pathsById.set(id, paths);
  }
  return new Map(
    Array.from(pathsById, ([id, paths]) => [id, bucketsOf(paths, overridesByPath)] as const),
  );
}

function isFullyKnown(
  id: ObjectId,
  buckets: ReadonlySet<CacheBucket>,
  known: ReadonlyMap<FingerprintKey, BlobFingerprint>,
): boolean {
  for (const bucket of buckets) {
    if (!known.has(fingerprintKey(id, bucket))) return false;
  }
  return true;
}

function missingIds(
  requiredBuckets: ReadonlyMap<ObjectId, ReadonlySet<CacheBucket>>,
  known: ReadonlyMap<FingerprintKey, BlobFingerprint>,
): ObjectId[] {
  const missing: ObjectId[] = [];
  for (const [id, buckets] of requiredBuckets) {
    if (!isFullyKnown(id, buckets, known)) missing.push(id);
  }
  return missing;
}

/** Builds every bucket `id` needs from ONE already-read blob: a `'sniff'`
 *  bucket reuses whichever explicit-kind fingerprint it resolves to instead
 *  of rebuilding it, so a blob fingerprints once per distinct CONTENT KIND
 *  however many of its (up to 3) buckets a call actually needs. */
function buildEntriesForId(
  id: ObjectId,
  buckets: ReadonlySet<CacheBucket>,
  content: Uint8Array,
): ReadonlyArray<readonly [FingerprintKey, BlobFingerprint]> {
  const byKind = new Map<ContentKind, BlobFingerprint>();
  const entries: Array<readonly [FingerprintKey, BlobFingerprint]> = [];
  for (const bucket of buckets) {
    const kind = bucket === 'sniff' ? contentKindOf(content) : bucket;
    const fingerprint = byKind.get(kind) ?? buildFingerprintFor(content, kind);
    byKind.set(kind, fingerprint);
    entries.push([fingerprintKey(id, bucket), fingerprint]);
  }
  return entries;
}

async function hydrateOneId(
  ctx: Context,
  id: ObjectId,
  buckets: ReadonlySet<CacheBucket>,
): Promise<ReadonlyArray<readonly [FingerprintKey, BlobFingerprint]>> {
  const { content } = await readBlob(ctx, id);
  return buildEntriesForId(id, buckets, content);
}

/**
 * Fingerprint-and-drop hydration: reads each missing blob just
 * long enough to build the fingerprints it needs, then lets the bytes go —
 * only the fingerprint (and its size) escapes the bounded worker, so a
 * blob's content never outlives the read that produced it. `entries` already
 * merges src and dst candidates into ONE array, so the single
 * `boundedMapFor` call below is the one shared pool for both arms — no
 * per-arm pool to double the true ioBound ceiling.
 *
 * Skips every (id, bucket) pair already in `known` and returns a NEW map
 * (`known` plus the newly hydrated entries) — `known` itself is never
 * mutated, so a caller accumulating fingerprints across phased hydration
 * passes keeps its own map intact. `overridesByPath` decides each entry's
 * own bucket — a path with no entry defers to the blob's own content sniff.
 */
export async function hydrateFingerprints(
  ctx: Context,
  entries: ReadonlyArray<PathedId>,
  known: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined> = new Map(),
): Promise<ReadonlyMap<FingerprintKey, BlobFingerprint>> {
  const requiredBuckets = requiredBucketsById(entries, overridesByPath);
  const missing = missingIds(requiredBuckets, known);
  const fetched = await boundedMapFor(ctx, 'ioBound', missing, (id) =>
    hydrateOneId(ctx, id, requiredBuckets.get(id) as ReadonlySet<CacheBucket>),
  );
  const merged = new Map(known);
  for (const group of fetched) {
    for (const [key, fingerprint] of group) merged.set(key, fingerprint);
  }
  return merged;
}

/** Combines two fingerprint maps — used to fold the break-attempt pass's
 *  already-read bytes (`scoreOneModify`) together with the basename pass's
 *  own hydration before either feeds the inexact matrix as `knownFingerprints`. */
function mergeFingerprintMaps(
  base: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  extra: ReadonlyMap<FingerprintKey, BlobFingerprint>,
): ReadonlyMap<FingerprintKey, BlobFingerprint> {
  if (extra.size === 0) return base;
  if (base.size === 0) return extra;
  return new Map([...base, ...extra]);
}

/** Per-id summary of an accumulated fingerprint cache: `sizeById` reuses ANY
 *  bucket's size (kind-invariant) to skip a redundant size-only read;
 *  `ids` lets a caller exempt an already-known id from the size gate that
 *  decides which ids `resolveOverridesFor` even looks up — preserving
 *  today's guarantee that an already-hydrated id's fingerprint is always
 *  findable later, regardless of the size gate's verdict THIS pass. */
interface KnownSummary {
  readonly sizeById: ReadonlyMap<ObjectId, number>;
  readonly ids: ReadonlySet<ObjectId>;
}

function summarizeKnown(known: ReadonlyMap<FingerprintKey, BlobFingerprint>): KnownSummary {
  const sizeById = new Map<ObjectId, number>();
  const ids = new Set<ObjectId>();
  for (const [key, fingerprint] of known) {
    const id = idOfFingerprintKey(key);
    sizeById.set(id, fingerprint.size);
    ids.add(id);
  }
  return { sizeById, ids };
}

/** One (index, source) pair from the registry — `buildMatrix` scores every
 *  matrix-eligible source against every destination, regardless of use
 *  count; `selectPairs` alone decides which candidates each pass may take. */
interface IndexedSource {
  readonly index: number;
  readonly source: RenameSource;
}

/** The fingerprint `id` resolves to at `path` — `overridesByPath` decides
 *  the bucket, `path` never needing an entry means the sniff bucket. */
function fingerprintAt(
  id: ObjectId,
  path: FilePath,
  fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>,
): BlobFingerprint | undefined {
  return fingerprints.get(fingerprintKey(id, bucketFor(overridesByPath.get(path))));
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
  fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>,
  threshold: number,
): MatrixCandidate[] {
  const candidates: MatrixCandidate[] = [];
  // Each source's basename and regularity computed once here, not once per
  // destination the inner loop below visits — the destination's own
  // basename is computed once per destination for the same reason. A
  // non-regular source's fingerprint is never looked up: git's
  // estimate_similarity checks S_ISREG on the source before ever touching
  // either side's data, so a symlink sharing its id with a hydrated regular
  // blob (content-addressed storage) or carrying a fingerprint seeded by an
  // unrelated pass (the break pass fingerprints a broken record's bytes
  // regardless of kind) must never inherit that fingerprint's score.
  const sourceBasenames = sources.map(({ source }) => basenameOf(source.path));
  const sourceIsRegular = sources.map(({ source }) => isRegularFile(source.mode));
  for (const destination of destinations) {
    const df = fingerprintAt(destination.newId, destination.newPath, fingerprints, overridesByPath);
    if (df === undefined) continue;
    const destinationBasename = basenameOf(destination.newPath);
    const slots: MatrixCandidate[] = [];
    sources.forEach(({ index, source }, position) => {
      const sf = sourceIsRegular[position]
        ? fingerprintAt(source.id, source.path, fingerprints, overridesByPath)
        : undefined;
      scoreAndRecord(
        sf,
        df,
        threshold,
        { source: index, destination },
        sourceBasenames[position] as string,
        destinationBasename,
        slots,
      );
    });
    for (const candidate of slots) candidates.push(candidate);
  }
  return candidates;
}

interface InexactMatrixResult {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly consumedAdds: ReadonlySet<AddChange>;
  readonly uses: ReadonlyArray<number>;
}

/** git's estimate_similarity checks S_ISREG on the SOURCE before ever
 *  touching a byte on either side — a non-regular source still stays in the
 *  matrix for slot semantics (buildMatrix never looks its fingerprint up,
 *  always scoring it 0), but with no regular source at all, every pair is
 *  guaranteed 0 and no destination is worth hydrating. Keeps each source's
 *  own path alongside its id — `hydrateMatrixFingerprints` resolves a
 *  similarity content-kind override from the path, not the id. */
function regularSourceEntries(matrixSources: ReadonlyArray<IndexedSource>): PathedId[] {
  return matrixSources
    .filter(({ source }) => isRegularFile(source.mode))
    .map(({ source }) => ({ id: source.id, path: source.path }));
}

interface HydratedMatrixFingerprints {
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
  readonly overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>;
}

/** Hydrates exactly the fingerprints the matrix needs: `selectHydrationIds`'s
 *  own size gate over the regular sources and every destination's id.
 *  Overrides are resolved for the ids `selectHydrationIds` actually kept,
 *  PLUS every id already in `knownFingerprints` (an already-hydrated id must
 *  stay findable by `buildMatrix` regardless of THIS pass's size-gate
 *  verdict) — a size-rejected, never-before-seen path's attribute is still
 *  never looked up. */
async function hydrateMatrixFingerprints(
  ctx: Context,
  srcEntries: ReadonlyArray<PathedId>,
  destinations: ReadonlyArray<AddChange>,
  threshold: number,
  knownFingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  resolver: SimilarityContentKindResolver,
): Promise<HydratedMatrixFingerprints> {
  const allEntries = [
    ...srcEntries,
    ...destinations.map((d) => ({ id: d.newId, path: d.newPath })),
  ];
  const srcIds = srcEntries.map((entry) => entry.id);
  const dstIds = destinations.map((d) => d.newId);
  const known = summarizeKnown(knownFingerprints);
  const neededIds = await selectHydrationIds(ctx, srcIds, dstIds, threshold, known.sizeById);
  const neededSet = new Set(neededIds);
  const overrideEntries = allEntries.filter(
    (entry) => neededSet.has(entry.id) || known.ids.has(entry.id),
  );
  const overridesByPath = await resolveOverridesFor(resolver, overrideEntries);
  const neededEntries = allEntries.filter((entry) => neededSet.has(entry.id));
  const fingerprints = await hydrateFingerprints(
    ctx,
    neededEntries,
    knownFingerprints,
    overridesByPath,
  );
  return { fingerprints, overridesByPath };
}

/**
 * Runs one inexact pass over `matrixIndices` (the registry sources the cull
 * step, `resolveMatrixPlan`, kept — used sources included when the cull was
 * `'keep-all'`): hydrates fingerprints, builds the shared-cap matrix, sorts
 * it, and lets `selectPairs` run rename-then-copy selection over the whole
 * thing.
 */
async function runInexactMatrix(
  ctx: Context,
  registrySources: ReadonlyArray<RenameSource>,
  matrixIndices: ReadonlyArray<number>,
  destinations: ReadonlyArray<AddChange>,
  uses: ReadonlyArray<number>,
  options: InexactPassOptions,
  knownFingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  resolver: SimilarityContentKindResolver,
): Promise<InexactMatrixResult | null> {
  if (matrixIndices.length === 0) return null;

  const matrixSources: IndexedSource[] = matrixIndices.map((index) => ({
    index,
    source: registrySources[index] as RenameSource,
  }));
  const srcEntries = regularSourceEntries(matrixSources);
  if (srcEntries.length === 0) return null;
  const hydrated = await hydrateMatrixFingerprints(
    ctx,
    srcEntries,
    destinations,
    options.threshold,
    knownFingerprints,
    resolver,
  );

  const candidates = buildMatrix(
    matrixSources,
    destinations,
    hydrated.fingerprints,
    hydrated.overridesByPath,
    options.threshold,
  );
  candidates.sort(compareCandidates);

  const selected = selectPairs(candidates, uses, {
    copies: options.copies !== 'off',
    threshold: options.threshold,
  });
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
 * A break score of 0 maps to DEFAULT_BREAK_SCORE (git's default -B threshold);
 * a merge value of 0 maps to DEFAULT_MERGE_SCORE.
 */
function resolveBreakGates(breakRewrites: { readonly score: number; readonly merge: number }): {
  readonly breakScore: number;
  readonly mergeScore: number;
} {
  return {
    breakScore: breakRewrites.score !== 0 ? breakRewrites.score : DEFAULT_BREAK_SCORE,
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
 * hydrated (no new read): a pair under MINIMUM_BREAK_SIZE never breaks,
 * and neither does an empty source — both are evaluated before any
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
function computeBreakScores(
  src: Uint8Array,
  dst: Uint8Array,
  override: BinaryOverride | undefined,
): BreakScores {
  const srcSize = src.length;
  const dstSize = dst.length;
  const maxSize = Math.max(srcSize, dstSize);
  const { srcCopied, literalAdded } = countSpanhashChanges(src, dst, override);
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
  readonly oldBytes: Uint8Array;
  readonly newBytes: Uint8Array;
  /** The modify's own path resolved once here — `mod.path` covers both old
   *  and new content, so `scoreModifies` reuses it to fingerprint a broken
   *  record's bytes without resolving it a second time. */
  readonly override: BinaryOverride | undefined;
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
 *
 * Hands both blobs' bytes back alongside the scores — a record that goes on
 * to break needs them again to seed the rename matrix's fingerprints
 * (`scoreModifies`), and this is the only read of either blob. `mod`'s old
 * and new content are two states of ONE path, so one `resolver.overrideFor`
 * call decides the content kind for both.
 */
async function scoreOneModify(
  ctx: Context,
  mod: ModifyChange,
  resolver: SimilarityContentKindResolver,
): Promise<ModifyScore> {
  const override = await resolver.overrideFor(mod.path);
  const { content: oldBytes } = await readBlob(ctx, mod.oldId);
  const { content: newBytes } = await readBlob(ctx, mod.newId);
  const { computedBreakScore, dissimilarity } = isBreakSizeGuarded(oldBytes.length, newBytes.length)
    ? GUARDED_SCORES
    : computeBreakScores(oldBytes, newBytes, override);
  return { mod, computedBreakScore, dissimilarity, oldBytes, newBytes, override };
}

function buildFingerprintFor(bytes: Uint8Array, kind: ContentKind): BlobFingerprint {
  return { fingerprint: buildFingerprint(bytes, kind), size: bytes.length };
}

/** `override`, when given, decides the fingerprint's content kind outright;
 *  `undefined` falls back to the blob's own content sniff. */
function toFingerprint(bytes: Uint8Array, override?: BinaryOverride): BlobFingerprint {
  return buildFingerprintFor(bytes, override ?? contentKindOf(bytes));
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
 *
 * `fingerprints` seeds the rename matrix for exactly the ids that go on to
 * break — a record that stays a plain modify never enters the registry, so
 * its bytes would never be looked up again anyway.
 */
async function scoreModifies(
  ctx: Context,
  modifies: ReadonlyArray<ModifyChange>,
  breakScore: number,
  resolver: SimilarityContentKindResolver,
): Promise<{
  readonly records: ReadonlyArray<BrokenRecord>;
  readonly paths: ReadonlySet<FilePath>;
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
}> {
  const scores = await boundedMapFor(ctx, 'ioBound', modifies, (mod) =>
    scoreOneModify(ctx, mod, resolver),
  );

  const records: BrokenRecord[] = [];
  const paths = new Set<FilePath>();
  const fingerprints = new Map<FingerprintKey, BlobFingerprint>();
  for (const { mod, computedBreakScore, dissimilarity, oldBytes, newBytes, override } of scores) {
    if (computedBreakScore < breakScore) continue;
    records.push({
      original: mod,
      del: toSyntheticDelete(mod),
      add: toSyntheticAdd(mod),
      dissimilarity,
    });
    paths.add(mod.path);
    const bucket = bucketFor(override);
    fingerprints.set(fingerprintKey(mod.oldId, bucket), toFingerprint(oldBytes, override));
    fingerprints.set(fingerprintKey(mod.newId, bucket), toFingerprint(newBytes, override));
  }
  return { records, paths, fingerprints };
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
 *  unconditionally — a gitlink or directory side never does. */
function collectBreakableTypeChanges(diff: TreeDiff): TypeChangeChange[] {
  return diff.changes.filter(
    (c): c is TypeChangeChange => c.type === 'type-change' && isBreakableTypeChange(c),
  );
}

interface BreakAttemptOutcome {
  readonly broken: ReadonlyArray<BrokenRecord>;
  readonly patchedDiff: TreeDiff;
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
}

const NO_BREAK_FINGERPRINTS: ReadonlyMap<FingerprintKey, BlobFingerprint> = new Map();

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
  resolver: SimilarityContentKindResolver,
): Promise<BreakAttemptOutcome> {
  const modifies = diff.changes.filter(
    (c): c is ModifyChange => c.type === 'modify' && isBreakableKind(c.oldMode),
  );
  const typeChanges = collectBreakableTypeChanges(diff);
  // Stryker disable next-line ConditionalExpression: equivalent — no breakable modify or type change produces empty records, matching the identical { broken: [], patchedDiff: diff } the records.length===0 guard below returns.
  if (modifies.length === 0 && typeChanges.length === 0) {
    return { broken: [], patchedDiff: diff, fingerprints: NO_BREAK_FINGERPRINTS };
  }

  const scored = await scoreModifies(ctx, modifies, breakScore, resolver);
  const records = [...scored.records, ...typeChanges.map(toTypeChangeRecord)];
  // Stryker disable next-line ConditionalExpression: equivalent — empty records means every source path set stays empty too, so patchDiffWithBroken copies changes unchanged, matching the early return.
  if (records.length === 0) {
    return { broken: [], patchedDiff: diff, fingerprints: NO_BREAK_FINGERPRINTS };
  }

  const paths = new Set<FilePath>([...scored.paths, ...typeChanges.map((c) => c.path)]);
  return {
    broken: records,
    patchedDiff: patchDiffWithBroken(diff, records, paths),
    fingerprints: scored.fingerprints,
  };
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
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly unpaired: ReadonlyArray<AddChange>;
  readonly uses: ReadonlyArray<number>;
  readonly rejoined: ReadonlyArray<DiffChange>;
}

/** True when `pair` re-pairs a broken record's own add half with its own
 *  delete half — git's `diff_resolve_rename_copy` (`diff.c:6697`) catches this
 *  by comparing the winning source's path with the destination's, after the
 *  destination's `one` side has already been reassigned to that source. */
function isSelfPair(pair: SourcePair, add: AddChange, sourceIndex: number): boolean {
  return pair.destination === add && pair.source === sourceIndex;
}

type WriteBackVerdict =
  | { readonly kind: 'self-paired'; readonly rejoinedChange: DiffChange }
  | { readonly kind: 'claimed-elsewhere' }
  | { readonly kind: 'absorbed'; readonly rejoinedChange: DiffChange };

/**
 * One broken record's write-back verdict, decided by what claimed its add
 * half: its own delete half (a same-path self-pair) resolves back to a
 * modify at the delete's own break score, unlike a real rename or copy never
 * decrementing the source's use count; any other source drops the delete
 * (whatever its own use count); nothing (still unpaired) rejoins, counting
 * as one more use of the delete-half's source.
 */
function writeBackVerdict(
  record: BrokenRecord,
  sourceIndex: number,
  pairByDestination: ReadonlyMap<AddChange, SourcePair>,
  unpairedSet: ReadonlySet<AddChange>,
  mergeScore: number,
): WriteBackVerdict {
  const claim = pairByDestination.get(record.add);
  if (claim !== undefined && isSelfPair(claim, record.add, sourceIndex)) {
    return { kind: 'self-paired', rejoinedChange: rejoinBroken(record, mergeScore) };
  }
  if (!unpairedSet.has(record.add)) return { kind: 'claimed-elsewhere' };
  return { kind: 'absorbed', rejoinedChange: rejoinBroken(record, mergeScore) };
}

interface WriteBackLookups {
  readonly sourceIndexByDelete: ReadonlyMap<DeleteChange, number>;
  readonly pairByDestination: ReadonlyMap<AddChange, SourcePair>;
  readonly unpairedSet: ReadonlySet<AddChange>;
}

/** The write-back loop's own working accumulator — `uses`/`rejoined`/the two
 *  add-sets, folded one broken record at a time by `applyWriteBackVerdict`. */
interface WriteBackFold {
  readonly uses: number[];
  readonly rejoined: DiffChange[];
  readonly absorbedAdds: Set<AddChange>;
  readonly selfPairedAdds: Set<AddChange>;
}

/** Applies one broken record's `writeBackVerdict` to `fold`, in place. */
function applyWriteBackVerdict(
  fold: WriteBackFold,
  record: BrokenRecord,
  lookups: WriteBackLookups,
  mergeScore: number,
): void {
  const sourceIndex = lookups.sourceIndexByDelete.get(record.del) as number;
  const verdict = writeBackVerdict(
    record,
    sourceIndex,
    lookups.pairByDestination,
    lookups.unpairedSet,
    mergeScore,
  );
  if (verdict.kind === 'claimed-elsewhere') return;

  fold.rejoined.push(verdict.rejoinedChange);
  if (verdict.kind === 'self-paired') fold.selfPairedAdds.add(record.add);
  else {
    fold.absorbedAdds.add(record.add);
    fold.uses[sourceIndex] = (fold.uses[sourceIndex] as number) + 1;
  }
}

/** git's write back (`diffcore-rename.c:1669`, `diff.c:6697`): folds every
 *  broken record's `writeBackVerdict` into the working pairs/unpaired/uses. */
function writeBackBroken(
  broken: ReadonlyArray<BrokenRecord>,
  originalDeletes: ReadonlyArray<DeleteChange | undefined>,
  pairs: ReadonlyArray<SourcePair>,
  unpaired: ReadonlyArray<AddChange>,
  uses: ReadonlyArray<number>,
  mergeScore: number,
): WriteBackOutcome {
  const lookups: WriteBackLookups = {
    sourceIndexByDelete: indexBrokenSources(originalDeletes),
    pairByDestination: new Map(pairs.map((pair) => [pair.destination, pair] as const)),
    unpairedSet: new Set(unpaired),
  };
  const fold: WriteBackFold = {
    uses: [...uses],
    rejoined: [],
    absorbedAdds: new Set(),
    selfPairedAdds: new Set(),
  };
  for (const record of broken) applyWriteBackVerdict(fold, record, lookups, mergeScore);

  return {
    pairs: pairs.filter((pair) => !fold.selfPairedAdds.has(pair.destination)),
    unpaired: unpaired.filter((add) => !fold.absorbedAdds.has(add)),
    uses: fold.uses,
    rejoined: fold.rejoined,
  };
}

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

interface BreakPassOutcome {
  readonly broken: ReadonlyArray<BrokenRecord>;
  readonly workingDiff: TreeDiff;
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
}

/** Run the break-attempt pass if enabled; returns broken records and patched diff. */
async function runBreakPass(
  ctx: Context,
  diff: TreeDiff,
  breakRewrites: RenameDetectOptions['breakRewrites'],
  resolver: SimilarityContentKindResolver,
): Promise<BreakPassOutcome> {
  if (breakRewrites === false || breakRewrites === undefined) {
    return { broken: [], workingDiff: diff, fingerprints: NO_BREAK_FINGERPRINTS };
  }
  const { breakScore } = resolveBreakGates(breakRewrites);
  const attempt = await attemptBreaks(ctx, diff, breakScore, resolver);
  return {
    broken: attempt.broken,
    workingDiff: attempt.patchedDiff,
    fingerprints: attempt.fingerprints,
  };
}

interface DetectOptions {
  readonly threshold: number;
  readonly limit: number;
  readonly copies: 'off' | 'on' | 'harder';
  readonly breakRewrites: RenameDetectOptions['breakRewrites'];
}

/** The subset of `DetectOptions` the inexact-matrix pipeline needs, grouped
 *  into one value instead of three positional parameters threaded through
 *  `runInexactMatrix` / `runInexactMatrixIfPlanned` / `runInexactPhase`. */
type InexactPassOptions = Pick<DetectOptions, 'threshold' | 'limit' | 'copies'>;

/** Resolve all detection options from the public RenameDetectOptions with defaults. */
function resolveDetectOptions(options: RenameDetectOptions | undefined): DetectOptions {
  return {
    threshold: options?.threshold ?? DEFAULT_RENAME_THRESHOLD,
    limit: options?.limit ?? DEFAULT_LIMIT,
    copies: options?.copies ?? 'off',
    breakRewrites: options?.breakRewrites ?? false,
  };
}

/** Whether the matrix keeps every registry source (copies on, or any broken
 *  pair) or only the ones the exact pass left unused. */
type SourceCull = 'keep-all' | 'unused-only';

function cullMatrixSourceIndices(
  sourceCount: number,
  uses: ReadonlyArray<number>,
  cull: SourceCull,
): number[] {
  const indices = Array.from({ length: sourceCount }, (_, index) => index);
  return cull === 'keep-all' ? indices : indices.filter((index) => uses[index] === 0);
}

// git's rename_limit <= 0 means unlimited (diffcore-rename.c:1105) — a
// negative limit squares to a positive number, so `limit !== 0` alone would
// wrongly re-impose a cap here.
function isOverLimit(numDst: number, numSrc: number, limit: number): boolean {
  return limit > 0 && numDst * numSrc > limit * limit;
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
  cull: SourceCull,
  copies: 'off' | 'on' | 'harder',
  limit: number,
): MatrixPlan | null {
  if (numDst === 0) return null;
  const indices = cullMatrixSourceIndices(sources.length, uses, cull);
  if (indices.length === 0) return null;
  if (!isOverLimit(numDst, indices.length, limit)) return { indices };
  if (copies !== 'harder') return null;

  const retryIndices = indices.filter(
    (index) => (sources[index] as RenameSource).origin !== 'unchanged',
  );
  if (isOverLimit(numDst, retryIndices.length, limit)) return null;
  return { indices: retryIndices };
}

/**
 * A `deleted` source's delete survives iff nothing beyond its seed (always 0)
 * used it — i.e. zero real pairs named it. A `broken-delete` source's delete
 * is decided entirely by `writeBackBroken`: it is dropped or rejoined
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

/** Runs the inexact matrix only when the rename-limit gate allows it. A
 *  non-regular (symlink, gitlink) source is never hydrated, but it still
 *  enters the matrix — `buildMatrix` scores it 0, matching git's own
 *  `record_if_better` call for every visited source, non-regular included
 *  (`runInexactMatrix` filters hydration to the regular subset only). A
 *  non-regular destination is dropped up front: its own slot array can never
 *  select it (score 0 never clears a positive threshold), so pre-filtering
 *  it changes nothing observable and skips hydrating it for nothing. */
async function runInexactMatrixIfPlanned(
  ctx: Context,
  registry: CandidateRegistry,
  exact: ExactPairing,
  options: InexactPassOptions,
  cull: SourceCull,
  knownFingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  resolver: SimilarityContentKindResolver,
): Promise<InexactMatrixResult | null> {
  const plan = resolveMatrixPlan(
    registry.sources,
    exact.unpaired.length,
    exact.uses,
    cull,
    options.copies,
    options.limit,
  );
  if (plan === null) return null;

  const matrixDestinations = exact.unpaired.filter((add) => isRegularFile(add.newMode));
  return runInexactMatrix(
    ctx,
    registry.sources,
    plan.indices,
    matrixDestinations,
    exact.uses,
    options,
    knownFingerprints,
    resolver,
  );
}

/** One basename-pass candidate: a still-unused source paired by basename with
 *  an unpaired destination, both already confirmed regular files. */
interface BasenameCandidate {
  readonly sourceIndex: number;
  readonly destination: AddChange;
}

/** Every basename-pass candidate whose source is still unused after the exact
 *  pass, restricted to pairs where both sides are regular files —
 *  `estimate_similarity` scores regular files only, and a symlink/gitlink
 *  candidate is kept out of the score-and-hydrate loop below entirely. */
function regularBasenameCandidates(
  sources: ReadonlyArray<RenameSource>,
  uses: ReadonlyArray<number>,
  destinations: ReadonlyArray<AddChange>,
): BasenameCandidate[] {
  const unusedIndices = cullMatrixSourceIndices(sources.length, uses, 'unused-only');
  const unusedSources = unusedIndices.map((index) => sources[index] as RenameSource);

  return uniqueBasenamePairs(unusedSources, destinations)
    .map(({ source, destination }) => ({
      sourceIndex: unusedIndices[source] as number,
      destination: destinations[destination] as AddChange,
    }))
    .filter(
      ({ sourceIndex, destination }) =>
        isRegularFile((sources[sourceIndex] as RenameSource).mode) &&
        isRegularFile(destination.newMode),
    );
}

function basenameCandidateIds(
  sources: ReadonlyArray<RenameSource>,
  candidates: ReadonlyArray<BasenameCandidate>,
): ObjectId[] {
  return candidates.flatMap(({ sourceIndex, destination }) => [
    (sources[sourceIndex] as RenameSource).id,
    destination.newId,
  ]);
}

/** Like `basenameCandidateIds`, but keeps each id's own path alongside it —
 *  `runBasenamePass` resolves a similarity content-kind override from the
 *  path, not the id. */
function basenameCandidateEntries(
  sources: ReadonlyArray<RenameSource>,
  candidates: ReadonlyArray<BasenameCandidate>,
): PathedId[] {
  return candidates.flatMap(({ sourceIndex, destination }) => [
    {
      id: (sources[sourceIndex] as RenameSource).id,
      path: (sources[sourceIndex] as RenameSource).path,
    },
    { id: destination.newId, path: destination.newPath },
  ]);
}

/**
 * git's `find_basename_matches` → `estimate_similarity` size prefilter: a
 * pair whose DECLARED sizes alone cannot reach `minBasename` is dropped
 * before either blob is ever read — mirrors `isSizeRejected`'s use in the
 * ordinary matrix, applied here at the id level so a rejected pair's ids
 * never reach `basenameCandidateIds`/`hydrateFingerprints`.
 */
function sizeSurvivingBasenameCandidates(
  candidates: ReadonlyArray<BasenameCandidate>,
  sources: ReadonlyArray<RenameSource>,
  sizes: ReadonlyMap<ObjectId, number>,
  minBasename: number,
): BasenameCandidate[] {
  return candidates.filter(({ sourceIndex, destination }) => {
    const srcSize = sizes.get((sources[sourceIndex] as RenameSource).id) as number;
    const dstSize = sizes.get(destination.newId) as number;
    return !isSizeRejected(srcSize, dstSize, minBasename);
  });
}

/**
 * git's own `find_basename_matches` scoring loop: each candidate is
 * independent (`uniqueBasenamePairs` never repeats a source or a
 * destination), so accepted pairs need no running use-count here — folding
 * them into `uses`/`unpaired` is the caller's job. Every candidate here has
 * already cleared `sizeSurvivingBasenameCandidates`, so both fingerprints
 * are guaranteed present.
 */
function scoreBasenameCandidates(
  candidates: ReadonlyArray<BasenameCandidate>,
  sources: ReadonlyArray<RenameSource>,
  fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  overridesByPath: ReadonlyMap<FilePath, BinaryOverride | undefined>,
  minBasename: number,
): SourcePair[] {
  const pairs: SourcePair[] = [];
  for (const { sourceIndex, destination } of candidates) {
    const source = sources[sourceIndex] as RenameSource;
    const sf = fingerprintAt(
      source.id,
      source.path,
      fingerprints,
      overridesByPath,
    ) as BlobFingerprint;
    const df = fingerprintAt(
      destination.newId,
      destination.newPath,
      fingerprints,
      overridesByPath,
    ) as BlobFingerprint;
    const score = estimateSimilarityFromFingerprints(
      sf.fingerprint,
      sf.size,
      df.fingerprint,
      df.size,
    );
    if (score >= minBasename) pairs.push({ source: sourceIndex, destination, score });
  }
  return pairs;
}

interface BasenamePassOutcome {
  readonly pairs: ReadonlyArray<SourcePair>;
  readonly unpaired: ReadonlyArray<AddChange>;
  readonly uses: ReadonlyArray<number>;
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
}

/** Folds accepted basename pairs into the exact pass's uses/unpaired. */
function applyBasenamePairs(
  exact: ExactPairing,
  pairs: ReadonlyArray<SourcePair>,
): Pick<BasenamePassOutcome, 'unpaired' | 'uses'> {
  const uses = [...exact.uses];
  const claimed = new Set<AddChange>();
  for (const pair of pairs) {
    uses[pair.source] = (uses[pair.source] as number) + 1;
    claimed.add(pair.destination);
  }
  return { unpaired: exact.unpaired.filter((add) => !claimed.has(add)), uses };
}

/**
 * git's find_basename_matches pre-pass (`-M` only, run between the exact
 * pass and the cull-plus-limit gate): a delete and an add sharing a UNIQUE
 * basename pair at a lower gate — the midpoint between `threshold` and
 * MAX_SCORE — before the ordinary matrix ever runs. This lets a weaker but
 * same-named pair win over a stronger, differently-named one (the matrix
 * alone always prefers the higher score). Never limited; its fingerprints
 * are handed back so the matrix phase never re-reads an already-hydrated blob.
 */
async function runBasenamePass(
  ctx: Context,
  sources: ReadonlyArray<RenameSource>,
  exact: ExactPairing,
  threshold: number,
  resolver: SimilarityContentKindResolver,
): Promise<BasenamePassOutcome> {
  const candidates = regularBasenameCandidates(sources, exact.uses, exact.unpaired);
  if (candidates.length === 0) {
    return { pairs: [], unpaired: exact.unpaired, uses: exact.uses, fingerprints: new Map() };
  }

  const minBasename = threshold + Math.trunc((MAX_SCORE - threshold) / 2);
  const candidateIds = Array.from(new Set(basenameCandidateIds(sources, candidates)));
  const sizes = await readDeclaredSizes(ctx, candidateIds);
  const survivors = sizeSurvivingBasenameCandidates(candidates, sources, sizes, minBasename);
  const survivorEntries = basenameCandidateEntries(sources, survivors);
  const overridesByPath = await resolveOverridesFor(resolver, survivorEntries);
  const fingerprints = await hydrateFingerprints(ctx, survivorEntries, new Map(), overridesByPath);
  const pairs = scoreBasenameCandidates(
    survivors,
    sources,
    fingerprints,
    overridesByPath,
    minBasename,
  );

  return { pairs, ...applyBasenamePairs(exact, pairs), fingerprints };
}

/** git's basename pre-pass runs only under plain `-M`: copies off, no broken
 *  pair anywhere in the diff (a broken modify or type change switches off
 *  `break_idx`'s absence), and threshold below MAX_SCORE (an exact-only run
 *  never reaches the inexact stage at all). */
function isBasenamePassEligible(
  copies: 'off' | 'on' | 'harder',
  broken: ReadonlyArray<BrokenRecord>,
  threshold: number,
): boolean {
  return copies === 'off' && broken.length === 0 && threshold < MAX_SCORE;
}

async function runBasenamePassIfEligible(
  ctx: Context,
  sources: ReadonlyArray<RenameSource>,
  exact: ExactPairing,
  broken: ReadonlyArray<BrokenRecord>,
  copies: 'off' | 'on' | 'harder',
  threshold: number,
  resolver: SimilarityContentKindResolver,
): Promise<BasenamePassOutcome> {
  if (!isBasenamePassEligible(copies, broken, threshold)) {
    return { pairs: [], unpaired: exact.unpaired, uses: exact.uses, fingerprints: new Map() };
  }
  return runBasenamePass(ctx, sources, exact, threshold, resolver);
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
  options: InexactPassOptions,
  knownFingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>,
  resolver: SimilarityContentKindResolver,
): Promise<InexactPhaseOutcome> {
  // git's "Did we only want exact renames?" (`diffcore-rename.c:1480`): once
  // the threshold IS the ceiling, no approximate score could mean anything
  // beyond "identical", and the exact pass already caught every identical
  // pair — running the matrix here could only ever manufacture a false
  // MAX_SCORE match (e.g. same lines, reverse-sorted) for non-identical bytes.
  if (options.threshold >= MAX_SCORE) return mergeInexactOutcome(exact, null);
  const cull: SourceCull =
    options.copies !== 'off' || broken.length > 0 ? 'keep-all' : 'unused-only';
  const inexact = await runInexactMatrixIfPlanned(
    ctx,
    registry,
    exact,
    options,
    cull,
    knownFingerprints,
    resolver,
  );
  return mergeInexactOutcome(exact, inexact);
}

interface ExactAndBasenameOutcome {
  readonly pairing: ExactPairing;
  readonly fingerprints: ReadonlyMap<FingerprintKey, BlobFingerprint>;
}

/**
 * The exact pass (never limited; always sees every registered source), then
 * the plain-`-M` basename pre-pass between it and the cull-plus-limit gate —
 * folded into one pairing, plus whatever fingerprints the basename pass
 * hydrated so the matrix phase never re-reads an already-hydrated blob.
 */
async function runExactAndBasenamePasses(
  ctx: Context,
  registry: CandidateRegistry,
  broken: ReadonlyArray<BrokenRecord>,
  copies: 'off' | 'on' | 'harder',
  threshold: number,
  resolver: SimilarityContentKindResolver,
): Promise<ExactAndBasenameOutcome> {
  const exactMode = copies === 'off' ? 'rename' : 'copy';
  const exact = pairIdenticalFiles(registry.sources, registry.destinations, exactMode);
  const basename = await runBasenamePassIfEligible(
    ctx,
    registry.sources,
    exact,
    broken,
    copies,
    threshold,
    resolver,
  );
  return {
    pairing: {
      pairs: [...exact.pairs, ...basename.pairs],
      unpaired: basename.unpaired,
      uses: basename.uses,
    },
    fingerprints: basename.fingerprints,
  };
}

/**
 * Detect exact and inexact (content-similarity) renames, and optionally
 * copies, with optional -B break-rewrite detection. A thin orchestrator over
 * six named steps: break, register, exact+basename, matrix, write-back,
 * assemble — each already its own function; this wires them in order.
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
 *    (whatever its own use count); paired with its OWN delete half (a
 *    same-path self-pair), it resolves back to a modify at the delete's own
 *    break score and is dropped from the pair list untouched-use-count;
 *    otherwise the halves rejoin into a modify (plain or broken) and the
 *    rejoin counts as one more use of the delete-half's source —
 *    this runs BEFORE labelRenameCopy.
 * 10. labelRenameCopy: every exact+inexact pair becomes a rename or copy by
 *     final use count (post write back) in destination-path order; unpaired
 *     destinations stay adds; a deleted source's delete survives iff nothing
 *     beyond its seed used it.
 */
export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
  preimage?: ReadonlyMap<FilePath, FlatTreeEntry>,
): Promise<TreeDiff> {
  const detectOptions = resolveDetectOptions(options);
  const mergeScore = resolveEffectiveMergeScore(detectOptions.breakRewrites);
  // Built once for the whole detection call, lazily: the first path any pass
  // actually fingerprints is what triggers `buildAttributeProvider` — an
  // unattributed repo, or one whose diff pairs every file at the exact pass
  // alone, never builds it at all.
  const resolver = buildSimilarityContentKindResolver(ctx);

  // Break, then register: the break pass runs BEFORE registration so its
  // synthetic delete+add halves feed the registry.
  const breakOutcome = await runBreakPass(ctx, diff, detectOptions.breakRewrites, resolver);
  const registry = registerCandidates(
    breakOutcome.workingDiff,
    breakOutcome.broken,
    detectOptions.copies,
    preimage,
    mergeScore,
  );

  // Exact pass, then the basename pre-pass.
  const exactAndBasename = await runExactAndBasenamePasses(
    ctx,
    registry,
    breakOutcome.broken,
    detectOptions.copies,
    detectOptions.threshold,
    resolver,
  );

  // Matrix: the cull-plus-limit gate, size-gated hydration, and selection.
  const inexact = await runInexactPhase(
    ctx,
    registry,
    exactAndBasename.pairing,
    breakOutcome.broken,
    detectOptions,
    mergeFingerprintMaps(breakOutcome.fingerprints, exactAndBasename.fingerprints),
    resolver,
  );

  // Write-back, then assemble: reconciles every broken pair against its
  // final pairing, then labels renames vs copies and reassembles the list.
  const writeBack = writeBackBroken(
    breakOutcome.broken,
    registry.originalDeletes,
    inexact.pairs,
    inexact.unpaired,
    inexact.uses,
    mergeScore,
  );
  return finalizeWithBroken(
    assembleFromRegistry(
      registry,
      writeBack.pairs,
      writeBack.unpaired,
      writeBack.uses,
      writeBack.rejoined,
    ),
  );
}

/** Replace each broken record's ORIGINAL change (still in `diff.changes`, never
 *  split into synthetic halves) with `rejoinBroken`'s verdict — every other
 *  change, and the whole list's order, stay exactly as they were. */
function rejoinBrokenInPlace(
  diff: TreeDiff,
  broken: ReadonlyArray<BrokenRecord>,
  mergeScore: number,
): TreeDiff {
  const byPath = new Map(broken.map((record) => [record.original.path, record] as const));
  const changes = diff.changes.map((change) => {
    const isBreakableChange = change.type === 'modify' || change.type === 'type-change';
    const record = isBreakableChange ? byPath.get(change.path) : undefined;
    return record !== undefined ? rejoinBroken(record, mergeScore) : change;
  });
  return { changes };
}

/**
 * git's `-B` break-rewrite detection alone, with rename/copy detection off
 * (`--no-renames -B`): attempts each dissimilar modify/type-change break
 * (`attemptBreaks`), then replaces every broken change IN PLACE with its
 * `rejoinBroken` verdict. No registration, no exact or inexact pairing ever
 * runs — mirrors git's `diffcore_break` immediately followed by
 * `diffcore_merge_broken` with the rename step skipped entirely, so two
 * otherwise-identical delete/add halves never pair.
 */
export async function detectBreakRewrites(
  ctx: Context,
  diff: TreeDiff,
  breakRewrites: { readonly score: number; readonly merge: number },
): Promise<TreeDiff> {
  const { breakScore, mergeScore } = resolveBreakGates(breakRewrites);
  const resolver = buildSimilarityContentKindResolver(ctx);
  const { broken } = await attemptBreaks(ctx, diff, breakScore, resolver);
  return rejoinBrokenInPlace(diff, broken, mergeScore);
}
