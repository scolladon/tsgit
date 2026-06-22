import { primaryPath } from '../../domain/diff/change-path.js';
import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import { isGitlink } from '../../domain/diff/index.js';
import { MAX_SCORE } from '../../domain/diff/similarity.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';
import { applyTextconv } from './apply-textconv.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { resolveTextconvDriver } from './resolve-textconv-driver.js';

const SUBPROJECT_PREFIX = 'Subproject commit ';

const encoder = new TextEncoder();

/** Options for `materialisePatchFiles` and `materialiseOne`. */
export interface MaterialisePatchFilesOptions {
  /**
   * When `true` and `ctx.command` is present, apply any configured
   * `diff=<name>` textconv driver to non-gitlink sides before returning.
   * Defaults to `false` — raw blob bytes are returned.
   *
   * Enable only for the display path (`diff-trees` → `git diff` / `git log -p`).
   * Consumers that need content-stable bytes (patch-id, rebase patch file,
   * range-diff inner diffs) must leave this unset.
   */
  readonly applyTextconv?: boolean;
}

function synthesizeGitlink(oid: ObjectId): Uint8Array {
  return encoder.encode(`${SUBPROJECT_PREFIX}${oid}\n`);
}

async function resolveSide(ctx: Context, mode: FileMode, id: ObjectId): Promise<Uint8Array> {
  if (isGitlink(mode)) return synthesizeGitlink(id);
  const blob = await readBlob(ctx, id);
  return blob.content;
}

/**
 * Sanitize a file path for use as a filesystem-safe temp-file token.
 * Replaces every non-alphanumeric character with `_`, keeps at most 64 chars.
 */
function sanitizePath(filePath: string): string {
  return filePath.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64);
}

/** Bundled textconv config — only present when opt-in is enabled and a runner is available. */
interface TextconvConfig {
  readonly runner: CommandRunner;
  readonly getProvider: () => Promise<AttributeProvider>;
}

/**
 * Apply textconv when opted in (`config` is non-null) and the mode is not a
 * gitlink. The temp file receives a unique token derived from the change path
 * and side so concurrent invocations on different files never collide.
 */
async function maybeTextconv(
  ctx: Context,
  config: TextconvConfig | undefined,
  change: DiffChange,
  side: 'old' | 'new',
  mode: FileMode,
  raw: Uint8Array,
): Promise<Uint8Array> {
  if (config === undefined || isGitlink(mode)) return raw;
  const provider = await config.getProvider();
  const filePath = primaryPath(change);
  const choice = await resolveTextconvDriver(ctx, provider, filePath);
  if (choice.kind !== 'external') return raw;
  const token = `${side}_${sanitizePath(filePath)}`;
  return applyTextconv(ctx, config.runner, choice.command, raw, token);
}

/**
 * Hydrate list of `DiffChange` entries into the blob bytes the unified-diff
 * serializer needs. `add` / `delete` / `rename` shapes load only the relevant
 * side (or neither for a pure rename); `modify` / `type-change` load both
 * sides, short-circuiting when both ids match (mode-only modify).
 *
 * Textconv is opt-in: pass `{ applyTextconv: true }` to enable driver
 * transforms on non-gitlink sides for the display path. Consumers that need
 * content-stable raw bytes (patch-id, rebase patch, range-diff) must omit
 * the option. Gitlink sides always use the synthesized `Subproject commit`
 * line. OIDs on the `DiffChange` are never touched.
 */
export async function materialisePatchFiles(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
  options?: MaterialisePatchFilesOptions,
): Promise<ReadonlyArray<PatchFile>> {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const config: TextconvConfig | undefined =
    options?.applyTextconv === true && ctx.command !== undefined
      ? {
          runner: ctx.command,
          getProvider: () => (providerPromise ??= buildAttributeProvider(ctx)),
        }
      : undefined;

  return boundedMap(changes, MAX_CONCURRENT_BLOB_LOADS, (c) => materialiseOne(ctx, c, config));
}

export async function materialiseOne(
  ctx: Context,
  change: DiffChange,
  config?: TextconvConfig | undefined,
): Promise<PatchFile> {
  // `config` is the sole gate: callers that want textconv must supply it.
  // materialiseOne never auto-infers textconv from ctx.command so the caller
  // controls the opt-in (materialisePatchFiles gates it via options.applyTextconv).

  if (change.type === 'add') {
    if (isGitlink(change.newMode)) return { change, newContent: synthesizeGitlink(change.newId) };
    const blob = await readBlob(ctx, change.newId);
    const newContent = await maybeTextconv(
      ctx,
      config,
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
      config,
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
      maybeTextconv(ctx, config, change, 'old', change.oldMode, blob.content),
      maybeTextconv(ctx, config, change, 'new', change.newMode, blob.content),
    ]);
    return { change, oldContent, newContent };
  }
  const [oldContent, newContent] = await Promise.all([
    resolveSide(ctx, change.oldMode, change.oldId).then((raw) =>
      maybeTextconv(ctx, config, change, 'old', change.oldMode, raw),
    ),
    resolveSide(ctx, change.newMode, change.newId).then((raw) =>
      maybeTextconv(ctx, config, change, 'new', change.newMode, raw),
    ),
  ]);
  return { change, oldContent, newContent };
}
