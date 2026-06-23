import { resolveAttribute } from '../../domain/attributes/index.js';
import { primaryPath } from '../../domain/diff/change-path.js';
import type { DiffChange, PatchFile } from '../../domain/diff/index.js';
import { isGitlink } from '../../domain/diff/index.js';
import { isBinary } from '../../domain/diff/line-diff.js';
import { MAX_SCORE } from '../../domain/diff/similarity.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';
import { applyTextconv } from './apply-textconv.js';
import { readConfig } from './config-read.js';
import { boundedMap, MAX_CONCURRENT_BLOB_LOADS } from './internal/bounded-map.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { type BinaryOverridePair, resolveBinaryOverride } from './resolve-binary-override.js';

const SUBPROJECT_PREFIX = 'Subproject commit ';

const encoder = new TextEncoder();

/** Options for `materialisePatchFiles` and `materialiseOne`. */
export interface MaterialisePatchFilesOptions {
  /**
   * When `true`, resolve the `diff` attribute for each path to apply binary
   * overrides and, when `ctx.command` is also present, execute any configured
   * `diff=<name>` textconv driver before returning content.
   *
   * Defaults to `false` — raw blob bytes are returned, no attribute lookup.
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

/** Bundled override/textconv config — only present when applyTextconv is enabled.
 *  `runner` is defined only when `ctx.command` is available (textconv execution).
 *  `getProvider` is always available when the config object exists. */
interface OverrideConfig {
  readonly runner: CommandRunner | undefined;
  readonly getProvider: () => Promise<AttributeProvider>;
}

/**
 * Resolve the textconv command string (if any) for a named diff driver.
 * Returns `undefined` when the driver section is absent or has no textconv key.
 */
async function resolveTextconvCommand(
  ctx: Context,
  driverName: string,
): Promise<string | undefined> {
  const section = (await readConfig(ctx)).diff?.get(driverName);
  const textconv = section?.textconv;
  return textconv !== undefined && textconv !== '' ? textconv : undefined;
}

/**
 * Resolve override pair + textconv command for a path using a SINGLE
 * `sourcesForPath` call.  The `rawIsBinary` check uses the raw bytes BEFORE
 * any textconv transform so numstat always reflects blob content, not output.
 *
 * Returns both the `BinaryOverridePair` and the optional textconv command string
 * (only if a configured external driver applies).
 */
async function resolveOverrideAndCommand(
  ctx: Context,
  provider: AttributeProvider,
  filePath: string,
  rawIsBinary: () => boolean | Promise<boolean>,
): Promise<{ pair: BinaryOverridePair; command: string | undefined }> {
  const { sources, macros } = await provider.sourcesForPath(
    filePath as Parameters<typeof provider.sourcesForPath>[0],
  );
  const diffAttr = resolveAttribute(
    sources,
    filePath as Parameters<typeof resolveAttribute>[1],
    'diff',
    macros,
  );

  let textconvConfigured = false;
  let command: string | undefined;
  if (diffAttr !== false && diffAttr !== true && diffAttr !== 'unspecified') {
    command = await resolveTextconvCommand(ctx, diffAttr.set);
    textconvConfigured = command !== undefined;
  }

  const pair = resolveBinaryOverride(diffAttr, {
    textconvConfigured,
    // Evaluate the raw-binary scan only when a configured named driver consumes it;
    // every other attribute state ignores it, so non-textconv paths skip the blob scan.
    rawIsBinary: textconvConfigured ? await rawIsBinary() : false,
  });
  return { pair, command };
}

/**
 * Apply textconv when a runner and command are available and the mode is not
 * a gitlink. The temp file receives a unique token derived from the change path
 * and side so concurrent invocations on different files never collide.
 */
async function maybeTextconv(
  ctx: Context,
  runner: CommandRunner,
  command: string,
  change: DiffChange,
  side: 'old' | 'new',
  mode: FileMode,
  raw: Uint8Array,
): Promise<Uint8Array> {
  if (isGitlink(mode)) return raw;
  const token = `${side}_${sanitizePath(primaryPath(change))}`;
  return applyTextconv(ctx, runner, command, raw, token);
}

/** Spread `BinaryOverridePair` fields into a `PatchFile` conditionally. */
function withOverride(base: PatchFile, pair: BinaryOverridePair): PatchFile {
  return {
    ...base,
    ...(pair.patch !== undefined ? { patchBinaryOverride: pair.patch } : {}),
    ...(pair.numstat !== undefined ? { numstatBinaryOverride: pair.numstat } : {}),
  };
}

/** Apply textconv to both sides when runner + command are present. */
async function applyTextconvBothSides(
  ctx: Context,
  config: OverrideConfig,
  command: string | undefined,
  change: DiffChange,
  oldRaw: Uint8Array,
  newRaw: Uint8Array,
  oldMode: FileMode,
  newMode: FileMode,
): Promise<[Uint8Array, Uint8Array]> {
  if (config.runner === undefined || command === undefined) return [oldRaw, newRaw];
  return Promise.all([
    maybeTextconv(ctx, config.runner, command, change, 'old', oldMode, oldRaw),
    maybeTextconv(ctx, config.runner, command, change, 'new', newMode, newRaw),
  ]);
}

async function materialiseAdd(
  ctx: Context,
  change: DiffChange & { type: 'add' },
  config: OverrideConfig | undefined,
): Promise<PatchFile> {
  if (isGitlink(change.newMode)) return { change, newContent: synthesizeGitlink(change.newId) };
  const blob = await readBlob(ctx, change.newId);
  const rawNew = blob.content;
  if (config === undefined) return { change, newContent: rawNew };
  const provider = await config.getProvider();
  const { pair, command } = await resolveOverrideAndCommand(
    ctx,
    provider,
    primaryPath(change),
    () => isBinary(rawNew),
  );
  const newContent =
    config.runner !== undefined && command !== undefined
      ? await maybeTextconv(ctx, config.runner, command, change, 'new', change.newMode, rawNew)
      : rawNew;
  return withOverride({ change, newContent }, pair);
}

async function materialiseDelete(
  ctx: Context,
  change: DiffChange & { type: 'delete' },
  config: OverrideConfig | undefined,
): Promise<PatchFile> {
  if (isGitlink(change.oldMode)) return { change, oldContent: synthesizeGitlink(change.oldId) };
  const blob = await readBlob(ctx, change.oldId);
  const rawOld = blob.content;
  if (config === undefined) return { change, oldContent: rawOld };
  const provider = await config.getProvider();
  const { pair, command } = await resolveOverrideAndCommand(
    ctx,
    provider,
    primaryPath(change),
    () => isBinary(rawOld),
  );
  const oldContent =
    config.runner !== undefined && command !== undefined
      ? await maybeTextconv(ctx, config.runner, command, change, 'old', change.oldMode, rawOld)
      : rawOld;
  return withOverride({ change, oldContent }, pair);
}

async function materialiseRenameOrCopy(
  ctx: Context,
  change: DiffChange & { type: 'rename' | 'copy' },
  config: OverrideConfig | undefined,
): Promise<PatchFile> {
  if (change.similarity.score === MAX_SCORE) {
    // Pure rename/copy (no content diff) — no content to carry; still resolve override
    // for the numstat surface so binary attribute is honoured even when blobs are identical.
    if (config === undefined) return { change };
    const provider = await config.getProvider();
    // Gitlink sides have no blob in the object store — synthesize is pointer-only; treat as non-binary.
    const { pair } = await resolveOverrideAndCommand(
      ctx,
      provider,
      primaryPath(change),
      async () =>
        isGitlink(change.newMode) ? false : isBinary((await readBlob(ctx, change.newId)).content),
    );
    return withOverride({ change }, pair);
  }
  const [oldBlob, newBlob] = await Promise.all([
    readBlob(ctx, change.oldId),
    readBlob(ctx, change.newId),
  ]);
  if (config === undefined) {
    return { change, oldContent: oldBlob.content, newContent: newBlob.content };
  }
  const provider = await config.getProvider();
  const { pair, command } = await resolveOverrideAndCommand(
    ctx,
    provider,
    primaryPath(change),
    () => isBinary(oldBlob.content) || isBinary(newBlob.content),
  );
  const [oldContent, newContent] = await applyTextconvBothSides(
    ctx,
    config,
    command,
    change,
    oldBlob.content,
    newBlob.content,
    change.oldMode,
    change.newMode,
  );
  return withOverride({ change, oldContent, newContent }, pair);
}

async function materialiseModifySameId(
  ctx: Context,
  change: DiffChange & { type: 'modify' | 'type-change' },
  config: OverrideConfig | undefined,
): Promise<PatchFile> {
  const blob = await readBlob(ctx, change.oldId);
  const rawBytes = blob.content;
  if (config === undefined) return { change, oldContent: rawBytes, newContent: rawBytes };
  const provider = await config.getProvider();
  const { pair, command } = await resolveOverrideAndCommand(
    ctx,
    provider,
    primaryPath(change),
    () => isBinary(rawBytes),
  );
  const [oldContent, newContent] = await applyTextconvBothSides(
    ctx,
    config,
    command,
    change,
    rawBytes,
    rawBytes,
    change.oldMode,
    change.newMode,
  );
  return withOverride({ change, oldContent, newContent }, pair);
}

async function materialiseModifyDifferentIds(
  ctx: Context,
  change: DiffChange & { type: 'modify' | 'type-change' },
  config: OverrideConfig | undefined,
): Promise<PatchFile> {
  const [oldRaw, newRaw] = await Promise.all([
    resolveSide(ctx, change.oldMode, change.oldId),
    resolveSide(ctx, change.newMode, change.newId),
  ]);
  if (config === undefined) return { change, oldContent: oldRaw, newContent: newRaw };
  // Use raw blob bytes for rawIsBinary — gitlink-synthesized content should not
  // pollute the binary detection so treat gitlink sides as non-binary.
  const oldForBinary = isGitlink(change.oldMode) ? new Uint8Array(0) : oldRaw;
  const newForBinary = isGitlink(change.newMode) ? new Uint8Array(0) : newRaw;
  const provider = await config.getProvider();
  const { pair, command } = await resolveOverrideAndCommand(
    ctx,
    provider,
    primaryPath(change),
    () => isBinary(oldForBinary) || isBinary(newForBinary),
  );
  const [oldContent, newContent] = await applyTextconvBothSides(
    ctx,
    config,
    command,
    change,
    oldRaw,
    newRaw,
    change.oldMode,
    change.newMode,
  );
  return withOverride({ change, oldContent, newContent }, pair);
}

/**
 * Hydrate list of `DiffChange` entries into the blob bytes the unified-diff
 * serializer needs. `add` / `delete` / `rename` shapes load only the relevant
 * side (or neither for a pure rename); `modify` / `type-change` load both
 * sides, short-circuiting when both ids match (mode-only modify).
 *
 * Textconv is opt-in: pass `{ applyTextconv: true }` to enable driver
 * transforms on non-gitlink sides for the display path. When opted in,
 * `diff` attribute overrides are also resolved and attached to `PatchFile`.
 * Consumers that need content-stable raw bytes (patch-id, rebase patch,
 * range-diff) must omit the option. Gitlink sides always use the synthesized
 * `Subproject commit` line. OIDs on the `DiffChange` are never touched.
 */
export async function materialisePatchFiles(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
  options?: MaterialisePatchFilesOptions,
): Promise<ReadonlyArray<PatchFile>> {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const config: OverrideConfig | undefined =
    options?.applyTextconv === true
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
  config?: OverrideConfig | undefined,
): Promise<PatchFile> {
  // `config` is the sole gate: callers that want textconv/override must supply it.
  // materialiseOne never auto-infers from ctx.command so the caller
  // controls the opt-in (materialisePatchFiles gates it via options.applyTextconv).

  if (change.type === 'add') return materialiseAdd(ctx, change, config);
  if (change.type === 'delete') return materialiseDelete(ctx, change, config);
  if (change.type === 'rename' || change.type === 'copy') {
    return materialiseRenameOrCopy(ctx, change, config);
  }
  // modify / type-change — resolve sides independently.
  // Short-circuit when ids match (mode-only modify), but only when neither side is
  // gitlink: gitlink pointer-bump always differs in oids, but guard explicitly to
  // keep the existing mode-only short-circuit test green.
  if (change.oldId === change.newId && !isGitlink(change.oldMode) && !isGitlink(change.newMode)) {
    return materialiseModifySameId(ctx, change, config);
  }
  return materialiseModifyDifferentIds(ctx, change, config);
}
