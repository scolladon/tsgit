import {
  type ContentMergeResult,
  type ContentMerger,
  MAX_CONFLICT_OUTPUT_BYTES,
  mergeContent,
} from '../../domain/merge/index.js';
import type { Context } from '../../ports/context.js';
import { type AttributeProvider, buildAttributeProvider } from './internal/read-gitattributes.js';
import { readBlob } from './read-blob.js';
import { resolveMergeDriver } from './resolve-merge-driver.js';
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
 */
export const buildContentMerger = (ctx: Context): ContentMerger => {
  let providerPromise: Promise<AttributeProvider> | undefined;
  const provider = (): Promise<AttributeProvider> =>
    (providerPromise ??= buildAttributeProvider(ctx));
  return async (mergeCtx): Promise<ContentMergeResult> => {
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
    const choice = await resolveMergeDriver(ctx, await provider(), mergeCtx.path);
    if (choice.kind === 'binary') {
      return { status: 'conflict', conflictType: 'binary', markedBytes: ours.content };
    }
    if (choice.kind === 'external' && ctx.command !== undefined) {
      return runMergeDriver(ctx, ctx.command, {
        command: choice.command,
        base: base?.content,
        ours: ours.content,
        theirs: theirs.content,
        path: mergeCtx.path,
      });
    }
    return mergeContent(base?.content, ours.content, theirs.content, {
      favor: choice.kind === 'union' ? 'union' : 'none',
    });
  };
};
