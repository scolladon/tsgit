import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import type { Context } from '../../ports/context.js';
import { readBlob } from './read-blob.js';

/**
 * Cap on simultaneous `readBlob` calls when hydrating a `TreeDiff` for patch
 * output. A pure `Promise.all` over thousands of changes saturates the
 * adapter's file-descriptor budget in a single tick; the bound matches
 * `merge`'s `MAX_CONCURRENT_PATH_WRITES`.
 */
const MAX_CONCURRENT_BLOB_LOADS = 32;

/**
 * Hydrate a list of `DiffChange` entries with the blob bytes the unified-diff
 * serializer needs. The `add` / `delete` / `rename` shapes each load only the
 * relevant side (or neither, for a pure rename); `modify` and `type-change`
 * load both sides and short-circuit when both ids match (mode-only modify).
 */
export async function materialisePatchFiles(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
): Promise<ReadonlyArray<PatchFile>> {
  const results = new Array<PatchFile | undefined>(changes.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < changes.length) {
      const idx = cursor++;
      // The loop guard pins `idx < changes.length`, so `changes[idx]` is
      // always defined; the non-null assertion mirrors `merge.runBounded`.
      const change = changes[idx]!;
      results[idx] = await materialiseOne(ctx, change);
    }
  };
  const concurrency = Math.min(MAX_CONCURRENT_BLOB_LOADS, changes.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  // Every slot is populated by the time all workers return; non-null assertion
  // matches the same pattern as merge's per-path bounded pool.
  return results.map((entry) => entry!);
}

export async function materialiseOne(ctx: Context, change: DiffChange): Promise<PatchFile> {
  if (change.type === 'add') {
    const blob = await readBlob(ctx, change.newId);
    return { change, newContent: blob.content };
  }
  if (change.type === 'delete') {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content };
  }
  if (change.type === 'rename') {
    return { change };
  }
  // modify or type-change — load both sides; short-circuit when ids match
  // (mode-only modify) to save one readBlob round-trip.
  if (change.oldId === change.newId) {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content, newContent: blob.content };
  }
  const [oldBlob, newBlob] = await Promise.all([
    readBlob(ctx, change.oldId),
    readBlob(ctx, change.newId),
  ]);
  return { change, oldContent: oldBlob.content, newContent: newBlob.content };
}
