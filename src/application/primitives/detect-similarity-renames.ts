import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
  CopyChange,
  DeleteChange,
  DiffChange,
  RenameChange,
  TreeDiff,
} from '../../domain/diff/diff-change.js';
import { sortByPath } from '../../domain/diff/path-compare.js';
import { detectRenames, type RenameDetectOptions } from '../../domain/diff/rename-detect.js';
import {
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
  const { adds, deletes, other, threshold, copyThreshold, copies } = opts;
  const copySources = copies !== 'off' ? buildCopySourcesForOn(deletes, other) : [];

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

/**
 * Detect inexact (content-similarity) renames and optionally copies.
 *
 * Algorithm:
 * 1. Run the pure exact `detectRenames` first (R100, never limited).
 * 2. Partition leftovers into unpaired adds (destinations) and unpaired deletes (sources).
 * 3. Apply the rename-limit guard: if num_create * num_src > limit, skip inexact pass.
 * 4. Hydrate blob bytes for all candidates via a bounded concurrency pool.
 * 5. Build scored triples for renames (deletes vs adds) and optionally copies.
 *    At equal score, rename sorts AHEAD of copy (matrix #C3 tiebreak).
 * 6. Greedy score-descending selection: pair when add is free AND score >= threshold.
 *    Rename also requires the delete to be free; copy retains its source.
 * 7. Emit winners; unconsumed adds/deletes remain as-is. Copy sources are never consumed.
 */
export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
): Promise<TreeDiff> {
  const threshold = options?.threshold ?? DEFAULT_RENAME_THRESHOLD;
  const copyThreshold = options?.copyThreshold ?? threshold;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const copies = options?.copies ?? 'off';

  // Run the exact pass with an unlimited ceiling so it never bails on the quadratic
  // guard — the per-id fan-out cap still applies via maxSameIdDeletes. The rename-limit
  // guard governs the inexact pass only (git never limits exact pairing).
  const exactResult = detectRenames(diff, { ...options, limit: Number.MAX_SAFE_INTEGER });
  const { adds, deletes, other } = partitionLeftovers(exactResult.changes);

  const hasRenameWork = adds.length > 0 && deletes.length > 0;
  const hasCopyWork = copies !== 'off' && adds.length > 0;
  if (!hasRenameWork && !hasCopyWork) return exactResult;

  // Git's check: num_destinations * num_sources > rename_limit * rename_limit
  const isOverLimit = limit !== 0 && adds.length * deletes.length > limit * limit;
  if (isOverLimit) return exactResult;

  const passResult = await runInexactPass(ctx, {
    adds,
    deletes,
    other,
    threshold,
    copyThreshold,
    copies,
  });

  if (passResult === null) return exactResult;

  const { renames, copyChanges, consumedDeletes, consumedAdds } = passResult;
  const leftoverAdds = adds.filter((a) => !consumedAdds.has(a));
  const leftoverDeletes = deletes.filter((d) => !consumedDeletes.has(d));
  const merged: DiffChange[] = [
    ...leftoverAdds,
    ...leftoverDeletes,
    ...renames,
    ...copyChanges,
    ...other,
  ];
  return { changes: sortByPath(merged, primaryPath) };
}
