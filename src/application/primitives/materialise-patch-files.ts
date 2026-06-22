import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import { isGitlink } from '../../domain/diff/index.js';
import { MAX_SCORE } from '../../domain/diff/similarity.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { readBlob } from './read-blob.js';

const SUBPROJECT_PREFIX = 'Subproject commit ';

const encoder = new TextEncoder();

function synthesizeGitlink(oid: ObjectId): Uint8Array {
  return encoder.encode(`${SUBPROJECT_PREFIX}${oid}\n`);
}

async function resolveSide(ctx: Context, mode: FileMode, id: ObjectId): Promise<Uint8Array> {
  if (isGitlink(mode)) return synthesizeGitlink(id);
  const blob = await readBlob(ctx, id);
  return blob.content;
}

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
    if (isGitlink(change.newMode)) return { change, newContent: synthesizeGitlink(change.newId) };
    const blob = await readBlob(ctx, change.newId);
    return { change, newContent: blob.content };
  }
  if (change.type === 'delete') {
    if (isGitlink(change.oldMode)) return { change, oldContent: synthesizeGitlink(change.oldId) };
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
  // modify or type-change — resolve each side independently.
  // Short-circuit when ids match (mode-only modify) only when neither side
  // is gitlink: a gitlink pointer-bump always has different oids, but guard
  // explicitly to keep the existing mode-only short-circuit test green.
  if (change.oldId === change.newId && !isGitlink(change.oldMode) && !isGitlink(change.newMode)) {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content, newContent: blob.content };
  }
  const [oldContent, newContent] = await Promise.all([
    resolveSide(ctx, change.oldMode, change.oldId),
    resolveSide(ctx, change.newMode, change.newId),
  ]);
  return { change, oldContent, newContent };
}
