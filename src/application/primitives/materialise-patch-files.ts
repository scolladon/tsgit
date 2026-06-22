import { primaryPath } from '../../domain/diff/change-path.js';
import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import { isGitlink } from '../../domain/diff/index.js';
import { MAX_SCORE } from '../../domain/diff/similarity.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { applyTextconv } from './apply-textconv.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { resolveTextconvDriver } from './resolve-textconv-driver.js';

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
 * When `ctx.command` is present, apply textconv for non-gitlink sides.
 * Falls back to raw bytes when `ctx.command` is absent (inert default path).
 */
async function maybeTextconv(
  ctx: Context,
  getProvider: (() => Promise<AttributeProvider>) | undefined,
  change: DiffChange,
  side: 'old' | 'new',
  mode: FileMode,
  raw: Uint8Array,
): Promise<Uint8Array> {
  if (ctx.command === undefined || getProvider === undefined || isGitlink(mode)) return raw;
  const provider = await getProvider();
  const path = primaryPath(change);
  const choice = await resolveTextconvDriver(ctx, provider, path);
  if (choice.kind !== 'external') return raw;
  return applyTextconv(ctx, ctx.command, choice.command, raw, side);
}

/**
 * Hydrate list of `DiffChange` entries blob bytes unified-diff
 * serializer needs. `add` / `delete` / `rename` shapes load only
 * relevant side (or neither, pure rename); `modify` `type-change`
 * load both sides short-circuit when both ids match (mode-only modify).
 *
 * When `ctx.command` is present and a `diff=<name>` attribute with a
 * configured `textconv` command is active for the path, non-gitlink
 * sides are transformed through the textconv driver before being
 * returned. Gitlink sides always use the synthesized `Subproject commit`
 * line. OIDs on the `DiffChange` are never touched.
 */
export async function materialisePatchFiles(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
): Promise<ReadonlyArray<PatchFile>> {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const getProvider =
    ctx.command !== undefined
      ? (): Promise<AttributeProvider> => (providerPromise ??= buildAttributeProvider(ctx))
      : undefined;

  return boundedMap(changes, MAX_CONCURRENT_BLOB_LOADS, (c) => materialiseOne(ctx, c, getProvider));
}

export async function materialiseOne(
  ctx: Context,
  change: DiffChange,
  getProvider?: (() => Promise<AttributeProvider>) | undefined,
): Promise<PatchFile> {
  const effectiveProvider =
    getProvider ??
    (ctx.command !== undefined
      ? (): Promise<AttributeProvider> => buildAttributeProvider(ctx)
      : undefined);

  if (change.type === 'add') {
    if (isGitlink(change.newMode)) return { change, newContent: synthesizeGitlink(change.newId) };
    const blob = await readBlob(ctx, change.newId);
    const newContent = await maybeTextconv(
      ctx,
      effectiveProvider,
      change,
      'new',
      change.newMode,
      blob.content,
    );
    return { change, newContent };
  }
  if (change.type === 'delete') {
    if (isGitlink(change.oldMode)) return { change, oldContent: synthesizeGitlink(change.oldId) };
    const blob = await readBlob(ctx, change.oldId);
    const oldContent = await maybeTextconv(
      ctx,
      effectiveProvider,
      change,
      'old',
      change.oldMode,
      blob.content,
    );
    return { change, oldContent };
  }
  if (change.type === 'rename' || change.type === 'copy') {
    if (change.similarity.score === MAX_SCORE) return { change };
    const [oldBlob, newBlob] = await Promise.all([
      readBlob(ctx, change.oldId),
      readBlob(ctx, change.newId),
    ]);
    return { change, oldContent: oldBlob.content, newContent: newBlob.content };
  }
  // modify / type-change — resolve sides independently.
  // Short-circuit when ids match (mode-only modify), but only when neither side is
  // gitlink: gitlink pointer-bump always differs in oids, but guard explicitly to
  // keep the existing mode-only short-circuit test green.
  if (change.oldId === change.newId && !isGitlink(change.oldMode) && !isGitlink(change.newMode)) {
    const blob = await readBlob(ctx, change.oldId);
    const [oldContent, newContent] = await Promise.all([
      maybeTextconv(ctx, effectiveProvider, change, 'old', change.oldMode, blob.content),
      maybeTextconv(ctx, effectiveProvider, change, 'new', change.newMode, blob.content),
    ]);
    return { change, oldContent, newContent };
  }
  const [oldContent, newContent] = await Promise.all([
    resolveSide(ctx, change.oldMode, change.oldId).then((raw) =>
      maybeTextconv(ctx, effectiveProvider, change, 'old', change.oldMode, raw),
    ),
    resolveSide(ctx, change.newMode, change.newId).then((raw) =>
      maybeTextconv(ctx, effectiveProvider, change, 'new', change.newMode, raw),
    ),
  ]);
  return { change, oldContent, newContent };
}
