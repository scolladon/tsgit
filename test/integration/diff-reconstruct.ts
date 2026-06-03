/**
 * Reconstruct a unified `git diff` patch from a structured `TreeDiff`, via the
 * same domain serializer the library uses internally (rebase's
 * `.git/rebase-merge/patch`, patch-id). The `diff` command returns structured
 * data only — the rendered patch text is no longer a library surface — so the
 * interop tests pin git byte-parity by reconstructing here.
 */
import { materialisePatchFiles } from '../../src/application/primitives/materialise-patch-files.js';
import { renderPatch, type TreeDiff } from '../../src/domain/diff/index.js';
import type { Context } from '../../src/ports/context.js';

export const reconstructPatch = async (ctx: Context, treeDiff: TreeDiff): Promise<string> =>
  renderPatch(await materialisePatchFiles(ctx, treeDiff.changes));
