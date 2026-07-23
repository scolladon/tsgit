import { configMissingValue, mergeDriverMissingCommand } from '../../domain/commands/error.js';
import {
  type ContentMergeResult,
  type ContentMerger,
  DEFAULT_MERGE_LABELS,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeLabels,
  mergeContent,
} from '../../domain/merge/index.js';
import type { Context } from '../../ports/context.js';
import { findFirstValuelessInSection } from './config-read.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { resolvePathMergeSpec } from './resolve-merge-driver.js';
import { runMergeDriver } from './run-merge-driver.js';

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
): ContentMerger => {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const provider = (): Promise<AttributeProvider> =>
    (providerPromise ??= buildAttributeProvider(ctx));
  let driverGuard: Promise<void> | undefined;
  const ensureNoValuelessMergeDriver = (): Promise<void> =>
    (driverGuard ??= findFirstValuelessInSection(ctx, 'merge', ['driver', 'name', 'recursive'], {
      requireSubsection: true,
    }).then((found) => {
      if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
    }));
  return async (mergeCtx): Promise<ContentMergeResult> => {
    await ensureNoValuelessMergeDriver();
    const [ours, theirs, base] = await Promise.all([
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
      readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      mergeCtx.baseId !== undefined
        ? // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
          readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
        : Promise.resolve(undefined),
    ]);
    const { driver, markerSize } = await resolvePathMergeSpec(ctx, await provider(), mergeCtx.path);
    if (driver.kind === 'missing-command') {
      throw mergeDriverMissingCommand(driver.name);
    }
    if (driver.kind === 'binary') {
      return { status: 'conflict', conflictType: 'binary', markedBytes: ours.content };
    }
    if (driver.kind === 'external' && ctx.command !== undefined) {
      return runMergeDriver(ctx, ctx.command, {
        command: driver.command,
        base: base?.content,
        ours: ours.content,
        theirs: theirs.content,
        path: mergeCtx.path,
        markerSize,
        labels,
      });
    }
    return mergeContent(base?.content, ours.content, theirs.content, {
      favor: driver.kind === 'union' ? 'union' : 'none',
      markerSize,
      labels: { ours: labels.ours, theirs: labels.theirs },
    });
  };
};
