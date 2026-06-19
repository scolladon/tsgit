import { primaryPath } from '../../domain/diff/change-path.js';
import type {
  AddChange,
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
import type { ObjectId } from '../../domain/objects/index.js';
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

interface ScoredTriple {
  readonly del: DeleteChange;
  readonly add: AddChange;
  readonly score: number;
}

function buildScoredTriples(
  deletes: ReadonlyArray<DeleteChange>,
  adds: ReadonlyArray<AddChange>,
  delBytes: Map<ObjectId, Uint8Array>,
  addBytes: Map<ObjectId, Uint8Array>,
  threshold: number,
): ReadonlyArray<ScoredTriple> {
  const triples: ScoredTriple[] = [];
  for (const del of deletes) {
    const srcBytes = delBytes.get(del.oldId);
    if (srcBytes === undefined) continue;
    for (const add of adds) {
      const dstBytes = addBytes.get(add.newId);
      if (dstBytes === undefined) continue;
      const score = estimateSimilarity(srcBytes, dstBytes);
      if (score >= threshold) {
        triples.push({ del, add, score });
      }
    }
  }
  triples.sort((a, b) => b.score - a.score);
  return triples;
}

interface GreedyMatch {
  readonly rename: RenameChange;
  readonly del: DeleteChange;
  readonly add: AddChange;
}

function greedySelect(triples: ReadonlyArray<ScoredTriple>): ReadonlyArray<GreedyMatch> {
  const usedDeletes = new Set<DeleteChange>();
  const usedAdds = new Set<AddChange>();
  const matches: GreedyMatch[] = [];

  for (const { del, add, score } of triples) {
    if (usedDeletes.has(del) || usedAdds.has(add)) continue;
    usedDeletes.add(del);
    usedAdds.add(add);
    matches.push({
      del,
      add,
      rename: {
        type: 'rename',
        oldPath: del.oldPath,
        newPath: add.newPath,
        oldId: del.oldId,
        newId: add.newId,
        oldMode: del.oldMode,
        newMode: add.newMode,
        similarity: { score, maxScore: MAX_SCORE },
      },
    });
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
    if (change.type === 'add') adds.push(change);
    else if (change.type === 'delete') deletes.push(change);
    else other.push(change);
  }
  return { adds, deletes, other };
}

/**
 * Detect inexact (content-similarity) renames after the exact R100 pass.
 *
 * Algorithm:
 * 1. Run the pure exact `detectRenames` first (R100, never limited).
 * 2. Partition leftovers into unpaired adds (destinations) and unpaired deletes (sources).
 * 3. Apply the rename-limit guard: if num_create * num_src > limit, skip inexact pass.
 * 4. Hydrate blob bytes for all candidates via a bounded concurrency pool.
 * 5. Score every (delete, add) pair with `estimateSimilarity`.
 * 6. Greedy score-descending selection: pair when both sides free AND score >= threshold.
 * 7. Emit rename winners; unconsumed adds/deletes remain as-is.
 */
export async function detectSimilarityRenames(
  ctx: Context,
  diff: TreeDiff,
  options?: RenameDetectOptions,
): Promise<TreeDiff> {
  const threshold = options?.threshold ?? DEFAULT_RENAME_THRESHOLD;
  const limit = options?.limit ?? DEFAULT_LIMIT;

  // Run the exact pass with an unlimited ceiling so it never bails on the quadratic
  // guard — the per-id fan-out cap still applies via maxSameIdDeletes. The rename-limit
  // guard governs the inexact pass only (git never limits exact pairing).
  const exactResult = detectRenames(diff, { ...options, limit: Number.MAX_SAFE_INTEGER });
  const { adds, deletes, other } = partitionLeftovers(exactResult.changes);

  if (adds.length === 0 || deletes.length === 0) {
    return exactResult;
  }

  const numCreate = adds.length;
  const numSrc = deletes.length;
  // Git's check: num_destinations * num_sources > rename_limit * rename_limit
  // (not num_dst * num_src > limit — the limit is a per-side cap, not a product cap)
  const isOverLimit = limit !== 0 && numCreate * numSrc > limit * limit;

  if (isOverLimit) {
    return exactResult;
  }

  const [delEntries, addEntries] = await Promise.all([
    hydrateIds(
      ctx,
      deletes.map((d) => d.oldId),
    ),
    hydrateIds(
      ctx,
      adds.map((a) => a.newId),
    ),
  ]);

  const delBytes = new Map<ObjectId, Uint8Array>(delEntries.map((e) => [e.id, e.bytes]));
  const addBytes = new Map<ObjectId, Uint8Array>(addEntries.map((e) => [e.id, e.bytes]));

  const triples = buildScoredTriples(deletes, adds, delBytes, addBytes, threshold);
  const matches = greedySelect(triples);

  const consumedDeletes = new Set<DeleteChange>(matches.map((m) => m.del));
  const consumedAdds = new Set<AddChange>(matches.map((m) => m.add));

  const renames = matches.map((m) => m.rename);
  const leftoverAdds = adds.filter((a) => !consumedAdds.has(a));
  const leftoverDeletes = deletes.filter((d) => !consumedDeletes.has(d));

  const merged: DiffChange[] = [...leftoverAdds, ...leftoverDeletes, ...renames, ...other];
  return { changes: sortByPath(merged, primaryPath) };
}
