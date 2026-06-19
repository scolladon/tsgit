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
import { sortByPath } from '../../domain/diff/path-compare.js';
import { detectRenames, type RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
  DEFAULT_BREAK_SCORE,
  DEFAULT_MERGE_SCORE,
  DEFAULT_RENAME_THRESHOLD,
  estimateSimilarity,
  MAX_SCORE,
} from '../../domain/diff/similarity.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readBlob } from './read-blob.js';

/** Must match `rename-detect.ts` DEFAULT_LIMIT (1000). */
const DEFAULT_LIMIT = 1000;

const MAX_CONCURRENT_BLOB_LOADS = 32;

interface BlobEntry {
  readonly id: ObjectId;
  readonly bytes: Uint8Array;
}

async function hydrateIds(
  ctx: Context,
  ids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<BlobEntry>> {
  const results = new Array<BlobEntry | undefined>(ids.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const idx = cursor++;
      // The loop guard pins `idx < ids.length`, so `ids[idx]` is always defined;
      // the cast mirrors the bounded pool pattern in `materialise-patch-files.ts`.
      const id = ids[idx] as ObjectId;
      const blob = await readBlob(ctx, id);
      results[idx] = { id, bytes: blob.content };
    }
  };
  const concurrency = Math.min(MAX_CONCURRENT_BLOB_LOADS, ids.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  // Every slot is populated by the time all workers return; mirrors materialise-patch-files.ts.
  return results.map((e) => e as BlobEntry);
}

interface CopySource {
  readonly oldPath: FilePath;
  readonly oldId: ObjectId;
  readonly oldMode: FileMode;
}

/**
 * Build the copy source set for `copies: 'on'`:
 * PREIMAGE blobs of files MODIFIED (modify/type-change) in the diff
 * plus the unpaired deletes already in the rename source set.
 * An UNCHANGED file is NOT a copy source under plain -C (matrix #C1b).
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
    sources.push({ oldPath: path, oldId: entry.id, oldMode: entry.mode });
  }
  return sources;
}

type ScoredKind = 'rename' | 'copy';

interface ScoredTriple {
  readonly kind: ScoredKind;
  readonly src: DeleteChange | CopySource;
  readonly add: AddChange;
  readonly score: number;
}

function buildRenameTriples(
  deletes: ReadonlyArray<DeleteChange>,
  adds: ReadonlyArray<AddChange>,
  srcBytes: Map<ObjectId, Uint8Array>,
  dstBytes: Map<ObjectId, Uint8Array>,
  threshold: number,
): ScoredTriple[] {
  const triples: ScoredTriple[] = [];
  for (const del of deletes) {
    const sb = srcBytes.get(del.oldId);
    if (sb === undefined) continue;
    for (const add of adds) {
      const db = dstBytes.get(add.newId);
      if (db === undefined) continue;
      const score = estimateSimilarity(sb, db);
      if (score >= threshold) triples.push({ kind: 'rename', src: del, add, score });
    }
  }
  return triples;
}

function buildCopyTriples(
  copySources: ReadonlyArray<CopySource>,
  adds: ReadonlyArray<AddChange>,
  srcBytes: Map<ObjectId, Uint8Array>,
  dstBytes: Map<ObjectId, Uint8Array>,
  copyThreshold: number,
): ScoredTriple[] {
  const triples: ScoredTriple[] = [];
  for (const src of copySources) {
    const sb = srcBytes.get(src.oldId);
    if (sb === undefined) continue;
    for (const add of adds) {
      const db = dstBytes.get(add.newId);
      if (db === undefined) continue;
      const score = estimateSimilarity(sb, db);
      if (score >= copyThreshold) triples.push({ kind: 'copy', src, add, score });
    }
  }
  return triples;
}

/**
 * Sort triples score-descending; at equal score rename sorts AHEAD of copy
 * (matrix #C3 — copy-vs-rename precedence).
 */
function sortTriples(triples: ScoredTriple[]): void {
  triples.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Rename candidate wins over copy at equal score.
    if (a.kind === 'rename' && b.kind === 'copy') return -1;
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

function greedySelect(
  triples: ReadonlyArray<ScoredTriple>,
  deletes: ReadonlyArray<DeleteChange>,
): ReadonlyArray<GreedyMatch> {
  const usedDeletes = new Set<DeleteChange>();
  const usedAdds = new Set<AddChange>();
  const matches: GreedyMatch[] = [];

  for (const triple of triples) {
    if (usedAdds.has(triple.add)) continue;

    if (triple.kind === 'rename') {
      const del = triple.src as DeleteChange;
      if (usedDeletes.has(del)) continue;
      usedDeletes.add(del);
      usedAdds.add(triple.add);
      matches.push({
        kind: 'rename',
        change: buildRenameChange(del, triple.add, triple.score),
        del,
        add: triple.add,
      });
    } else {
      // Copy: only consumed if the add is not yet consumed.
      // The copy source is NOT consumed (retained in result set).
      // Check if the copy src is actually a delete — if so, it must not be consumed
      // as a delete already (but copy sources are CopySource, not DeleteChange).
      usedAdds.add(triple.add);
      const src = triple.src as CopySource;
      matches.push({
        kind: 'copy',
        change: buildCopyChange(src, triple.add, triple.score),
        add: triple.add,
      });
    }
  }

  // After greedy selection, unused deletes that were NOT consumed as rename sources
  // remain available. We don't need to track them separately — the caller does.
  void deletes; // referenced for type completeness
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
    if (change.type === 'add') adds.push(change);
    else if (change.type === 'delete') deletes.push(change);
    else other.push(change);
  }
  return { adds, deletes, other };
}

interface InexactPassOptions {
  readonly adds: ReadonlyArray<AddChange>;
  readonly deletes: ReadonlyArray<DeleteChange>;
  readonly other: ReadonlyArray<DiffChange>;
  readonly threshold: number;
  readonly copyThreshold: number;
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

async function runInexactPass(
  ctx: Context,
  opts: InexactPassOptions,
): Promise<InexactPassResult | null> {
  const { adds, deletes, threshold, copyThreshold, copies, copySources } = opts;

  if (deletes.length === 0 && copySources.length === 0) return null;

  const allSrcIds = [...deletes.map((d) => d.oldId), ...copySources.map((s) => s.oldId)];
  const [srcEntries, dstEntries] = await Promise.all([
    hydrateIds(ctx, allSrcIds),
    hydrateIds(
      ctx,
      adds.map((a) => a.newId),
    ),
  ]);

  const srcBytes = new Map<ObjectId, Uint8Array>(srcEntries.map((e) => [e.id, e.bytes]));
  const dstBytes = new Map<ObjectId, Uint8Array>(dstEntries.map((e) => [e.id, e.bytes]));

  const renameTriples = buildRenameTriples(deletes, adds, srcBytes, dstBytes, threshold);
  const copyTriples =
    copies !== 'off' ? buildCopyTriples(copySources, adds, srcBytes, dstBytes, copyThreshold) : [];

  const allTriples: ScoredTriple[] = [...renameTriples, ...copyTriples];
  sortTriples(allTriples);

  const matches = greedySelect(allTriples, deletes);
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
  const modifies = diff.changes.filter((c): c is ModifyChange => c.type === 'modify');
  if (modifies.length === 0) return { broken: [], patchedDiff: diff };

  const modifyIds = modifies.flatMap((m) => [m.oldId, m.newId]);
  const entries = await hydrateIds(ctx, modifyIds);
  const bytesById = new Map<ObjectId, Uint8Array>(entries.map((e) => [e.id, e.bytes]));

  const brokenRecords: BrokenRecord[] = [];
  const brokenModifyPaths = new Set<FilePath>();

  for (const mod of modifies) {
    const oldBytes = bytesById.get(mod.oldId) ?? new Uint8Array(0);
    const newBytes = bytesById.get(mod.newId) ?? new Uint8Array(0);
    const similarity = estimateSimilarity(oldBytes, newBytes);
    const dissimilarity = MAX_SCORE - similarity;
    if (dissimilarity < breakScore) continue;

    const del: DeleteChange = {
      type: 'delete',
      oldPath: mod.path,
      oldId: mod.oldId,
      oldMode: mod.oldMode,
    };
    const add: AddChange = {
      type: 'add',
      newPath: mod.path,
      newId: mod.newId,
      newMode: mod.newMode,
    };
    brokenRecords.push({ original: mod, del, add, dissimilarity });
    brokenModifyPaths.add(mod.path);
  }

  if (brokenRecords.length === 0) return { broken: [], patchedDiff: diff };

  // Replace broken modifies with their synthetic delete+add halves.
  const patchedChanges: DiffChange[] = [];
  for (const change of diff.changes) {
    if (change.type === 'modify' && brokenModifyPaths.has(change.path)) {
      const record = brokenRecords.find((r) => r.original.path === change.path);
      if (record !== undefined) {
        patchedChanges.push(record.del, record.add);
        continue;
      }
    }
    patchedChanges.push(change);
  }

  return { broken: brokenRecords, patchedDiff: { changes: patchedChanges } };
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
  if (broken.length === 0) return changes;

  const { presentDels, presentAdds } = findPresentHalves(changes, broken);
  const toStrip = new Set<DiffChange>();
  const reinsert: DiffChange[] = [];

  for (const record of broken) {
    const delPresent = presentDels.has(record.del);
    const addPresent = presentAdds.has(record.add);
    if (!delPresent && !addPresent) continue; // both consumed; nothing to strip or emit
    if (delPresent && addPresent) {
      // Both unconsumed: strip both halves; emit a modify (plain or broken).
      toStrip.add(record.del);
      toStrip.add(record.add);
      reinsert.push(emitMergedModify(record, mergeScore));
    }
    // Exactly one half present: the surviving half stays; no modify to emit.
  }

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
 * 5. Hydrate blob bytes for all candidates via a bounded concurrency pool.
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

export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
  preimage?: ReadonlyMap<FilePath, FlatTreeEntry>,
): Promise<TreeDiff> {
  const threshold = options?.threshold ?? DEFAULT_RENAME_THRESHOLD;
  const copyThreshold = options?.copyThreshold ?? threshold;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const copies = options?.copies ?? 'off';
  const breakRewrites = options?.breakRewrites ?? false;

  // Break-attempt pass: runs BEFORE exact/inexact so halves feed the matrix.
  // The fixed order ensures break-then-rename is possible.
  const { broken, workingDiff } = await runBreakPass(ctx, diff, breakRewrites);

  // Run the exact pass with an unlimited ceiling so it never bails on the quadratic
  // guard — the per-id fan-out cap still applies via maxSameIdDeletes. The rename-limit
  // guard governs the inexact pass only (git never limits exact pairing).
  const exactResult = detectRenames(workingDiff, { ...options, limit: Number.MAX_SAFE_INTEGER });
  const { adds, deletes, other } = partitionLeftovers(exactResult.changes);

  const hasRenameWork = adds.length > 0 && deletes.length > 0;
  const hasCopyWork = copies !== 'off' && adds.length > 0;
  const mergeScore = resolveEffectiveMergeScore(breakRewrites);

  if (!hasRenameWork && !hasCopyWork) {
    return finalizeWithBroken(exactResult.changes, broken, mergeScore);
  }

  // Git's rename-only limit: skip the whole inexact pass when rename candidates alone exceed it.
  const isOverLimit = limit !== 0 && adds.length * deletes.length > limit * limit;
  if (isOverLimit) {
    return finalizeWithBroken(exactResult.changes, broken, mergeScore);
  }

  // Resolve copy sources; applies harder-limit fallback when needed.
  const copySources = resolveCopySources(copies, adds, deletes, other, preimage, limit);

  const passResult = await runInexactPass(ctx, {
    adds,
    deletes,
    other,
    threshold,
    copyThreshold,
    copies,
    copySources,
  });

  const consumedDeletes = passResult?.consumedDeletes ?? new Set<DeleteChange>();
  const consumedAdds = passResult?.consumedAdds ?? new Set<AddChange>();
  const renames = passResult?.renames ?? [];
  const copyChanges = passResult?.copyChanges ?? [];

  const preRemerge: DiffChange[] = [
    ...adds.filter((a) => !consumedAdds.has(a)),
    ...deletes.filter((d) => !consumedDeletes.has(d)),
    ...renames,
    ...copyChanges,
    ...other,
  ];

  return finalizeWithBroken(preRemerge, broken, mergeScore);
}
