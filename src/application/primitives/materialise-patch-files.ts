import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import { MAX_SCORE } from '../../domain/diff/similarity.js';
import type { Context } from '../../ports/context.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { readBlob } from './read-blob.js';

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
  return boundedMap(changes, MAX_CONCURRENT_BLOB_LOADS, (c) => materialiseOne(ctx, c));
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
  if (change.type === 'rename' || change.type === 'copy') {
    if (change.similarity.score === MAX_SCORE) return { change };
    const [oldBlob, newBlob] = await Promise.all([
      readBlob(ctx, change.oldId),
      readBlob(ctx, change.newId),
    ]);
    return { change, oldContent: oldBlob.content, newContent: newBlob.content };
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
