/**
 * Reconstruct a unified `git diff` patch from a structured `TreeDiff`, via the
 * same domain serializer the library uses internally (rebase's
 * `.git/rebase-merge/patch`, patch-id). The `diff` command returns structured
 * data only — the rendered patch text is no longer a library surface — so the
 * interop tests pin git byte-parity by reconstructing here.
 *
 * The optional `opts` argument forwards to `renderPatch`, enabling whitespace
 * and blank-line modes to be threaded through for whitespace interop tests.
 * Omitting `opts` (default) matches today's no-options behaviour so that the
 * existing recursive interop test stays byte-unchanged.
 */
import { materialisePatchFiles } from '../../src/application/primitives/materialise-patch-files.js';
import { type PatchOptions, renderPatch, type TreeDiff } from '../../src/domain/diff/index.js';
import type { Context } from '../../src/ports/context.js';

export const reconstructPatch = async (
  ctx: Context,
  treeDiff: TreeDiff,
  opts?: PatchOptions,
): Promise<string> => renderPatch(await materialisePatchFiles(ctx, treeDiff.changes), opts);
