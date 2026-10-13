import { configMissingValue, mergeDriverMissingCommand } from '../../domain/commands/error.js';
import type { DiffAlgorithm } from '../../domain/diff/line-diff.js';
import type { LineKey } from '../../domain/diff/whitespace.js';
import type { EolSettings } from '../../domain/eol/crlf-action.js';
import {
  type BlobUnchanged,
  type ConflictStyle,
  type ContentMergeContext,
  type ContentMergeResult,
  type ContentMerger,
  DEFAULT_MERGE_LABELS,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeFavor,
  type MergeLabels,
  mergeContent,
} from '../../domain/merge/index.js';
import type { OrtVariant } from '../../domain/merge/strategy-options.js';
import { mergeBinary } from '../../domain/merge/three-way-content.js';
import { bytesEqual } from '../../domain/objects/encoding.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { findFirstValuelessInSection } from './config-read.js';
import { undefinedWhenBlobAbsent } from './internal/absent-blob.js';
import { renormalizeBuffer } from './internal/convert-blob.js';
import { readConflictStyle } from './internal/merge-rename-config.js';
import {
  type AttributeProvider,
  buildAttributeProvider,
  type IndexBlobLookup,
} from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { readEolSettings, resolveConversion } from './resolve-conversion.js';
import { resolvePathMergeSpec } from './resolve-merge-driver.js';
import { runMergeDriver } from './run-merge-driver.js';

/** git's ort labels each side `<label>:<path>` once a rename puts the sides at different paths. */
const labelsFor = (labels: MergeLabels, mergeCtx: ContentMergeContext): MergeLabels => {
  const paths = mergeCtx.sidePaths;
  if (paths === undefined) return labels;
  return {
    ours: `${labels.ours}:${paths.ours}`,
    theirs: `${labels.theirs}:${paths.theirs}`,
    base: `${labels.base}:${paths.base}`,
  };
};

/** The `-X` settings that steer the built-in merge of every path. */
export interface ContentMergeSettings {
  readonly variant?: OrtVariant;
  readonly lineKey?: LineKey;
  readonly diffAlgorithm?: DiffAlgorithm;
  /** Normalizes each side to its repository form, under the merged `.gitattributes`, before merging. */
  readonly renormalize?: RenormalizeSettings;
}

export interface RenormalizeSettings {
  readonly attributes: IndexBlobLookup;
}

type Normalize = (path: FilePath, bytes: Uint8Array) => Promise<Uint8Array>;

const keepBytes: Normalize = async (_path, bytes) => bytes;

/** git's `renormalize_buffer` over one lazily built `index-only` attribute provider. */
const buildNormalizer = (ctx: Context, { attributes }: RenormalizeSettings): Normalize => {
  let ready: Promise<{ provider: AttributeProvider; eol: EolSettings }> | undefined;
  const prepare = () =>
    (ready ??= Promise.all([
      buildAttributeProvider(ctx, { kind: 'index-only', index: attributes }),
      readEolSettings(ctx),
    ]).then(([provider, eol]) => ({ provider, eol })));
  return async (path, bytes) => {
    const { provider, eol } = await prepare();
    const conversion = await resolveConversion(ctx, provider, path, eol);
    return renormalizeBuffer(ctx, path, bytes, conversion, eol);
  };
};

/** git counts a side it cannot read as a blob as changed, and caps the read like the content merge. */
const readComparedBlob = (ctx: Context, id: ObjectId) =>
  undefinedWhenBlobAbsent(() => readBlob(ctx, id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }));

/** ort's `blob_unchanged`: a side whose bytes differ from the base only by normalization is untouched. */
export const buildBlobUnchanged = (
  ctx: Context,
  renormalize: RenormalizeSettings,
): BlobUnchanged => {
  const normalize = buildNormalizer(ctx, renormalize);
  return async (path, base, side) => {
    if (base.mode !== side.mode) return false;
    if (base.id === side.id) return true;
    if (base.mode === FILE_MODE.GITLINK) return false;
    const [baseBlob, sideBlob] = await Promise.all([
      readComparedBlob(ctx, base.id),
      readComparedBlob(ctx, side.id),
    ]);
    if (baseBlob === undefined || sideBlob === undefined) return false;
    const [normalizedBase, normalizedSide] = await Promise.all([
      normalize(path, baseBlob.content),
      normalize(path, sideBlob.content),
    ]);
    return bytesEqual(normalizedBase, normalizedSide);
  };
};

/** merge-ort's `init_basic_merge_options`: ort diffs with histogram unless `-X` names another. */
const ORT_DIFF_ALGORITHM: DiffAlgorithm = 'histogram';

/** git's `ll_union_merge` overrides the variant; `-merge` and `text` keep it. */
const favorFor = (driverKind: string, settings: ContentMergeSettings): MergeFavor =>
  driverKind === 'union' ? 'union' : (settings.variant ?? 'none');

/**
 * The single `ContentMerger` used by every 3-way consumer (`merge` directly,
 * and `cherry-pick` / `revert` / `rebase` / `stash` via `applyMergeToWorktree`).
 * For each path whose two sides changed differently it reads the three blobs,
 * resolves the per-path merge driver (`.gitattributes` `merge=<driver>` +
 * `[merge "<driver>"]`), and dispatches:
 *
 * - `text`     → the built-in line merge (`mergeContent`) — the default.
 * - `union`    → the built-in line merge with overlaps concatenated, no markers.
 * - `binary`   → take `ours` and declare a conflict (git's `-merge`).
 * - `external` → run the configured command (when a `CommandRunner` is wired);
 *                otherwise fall back to the built-in line merge.
 *
 * The attribute provider is built once, lazily, on the first content merge, so
 * a merge with no content-level conflicts reads no `.gitattributes`.
 *
 * The three blob reads are capped at `MAX_CONFLICT_OUTPUT_BYTES`; a hostile
 * oversize blob is rejected upfront by `readBlob` (`OBJECT_TOO_LARGE`) before
 * reaching the line-diff path. The Promise.all keeps the reads concurrent.
 *
 * `labels` are the per-operation conflict labels (`ours`/`theirs`/`base`), the
 * same for every path; the per-path `conflict-marker-size` is resolved here
 * alongside the driver. Both feed the built-in markers and the external driver's
 * `%L`/`%S`/`%X`/`%Y`.
 */
export const buildContentMerger = (
  ctx: Context,
  labels: MergeLabels = DEFAULT_MERGE_LABELS,
  settings: ContentMergeSettings = {},
): ContentMerger => {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const provider = (): Promise<AttributeProvider> =>
    (providerPromise ??= buildAttributeProvider(ctx));
  const normalize =
    settings.renormalize === undefined ? keepBytes : buildNormalizer(ctx, settings.renormalize);
  let driverGuard: Promise<void> | undefined;
  const ensureNoValuelessMergeDriver = (): Promise<void> =>
    (driverGuard ??= findFirstValuelessInSection(ctx, 'merge', ['driver', 'name', 'recursive'], {
      requireSubsection: true,
    }).then((found) => {
      if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
    }));
  let stylePromise: Promise<ConflictStyle | undefined> | undefined;
  const conflictStyle = (): Promise<ConflictStyle | undefined> =>
    (stylePromise ??= readConflictStyle(ctx));
  return async (mergeCtx): Promise<ContentMergeResult> => {
    await ensureNoValuelessMergeDriver();
    const [rawOurs, rawTheirs, rawBase] = await Promise.all([
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      mergeCtx.baseId !== undefined
        ? // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
          readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
        : Promise.resolve(undefined),
    ]);
    const [ours, theirs, base] = await Promise.all([
      normalize(mergeCtx.path, rawOurs.content),
      normalize(mergeCtx.path, rawTheirs.content),
      rawBase === undefined ? undefined : normalize(mergeCtx.path, rawBase.content),
    ]);
    const spec = await resolvePathMergeSpec(ctx, await provider(), mergeCtx.path);
    const { driver } = spec;
    const markerSize = spec.markerSize + (mergeCtx.extraMarkerSize ?? 0);
    if (driver.kind === 'missing-command') {
      throw mergeDriverMissingCommand(driver.name);
    }
    if (driver.kind === 'binary') {
      return mergeBinary(ours, theirs, settings.variant);
    }
    const pathLabels = labelsFor(labels, mergeCtx);
    if (driver.kind === 'external' && ctx.command !== undefined) {
      return runMergeDriver(ctx, ctx.command, {
        command: driver.command,
        base,
        ours,
        theirs,
        path: mergeCtx.path,
        markerSize,
        labels: pathLabels,
      });
    }
    return mergeContent(base, ours, theirs, {
      favor: favorFor(driver.kind, settings),
      lineKey: settings.lineKey,
      diffAlgorithm: settings.diffAlgorithm ?? ORT_DIFF_ALGORITHM,
      markerSize,
      labels: pathLabels,
      conflictStyle: (await conflictStyle()) ?? 'merge',
    });
  };
};
