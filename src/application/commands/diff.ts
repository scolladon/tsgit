import type { PatchPathPrefix, TreeDiff } from '../../domain/diff/index.js';
import { renderPatch } from '../../domain/diff/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';

export type DiffFormat = 'tree' | 'patch';

export interface DiffOptions {
  /** Resolve to a tree. Accepts ref name, oid, or 'HEAD'. */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  /** Output format. Default `'tree'` for backward compatibility. */
  readonly format?: DiffFormat;
  /**
   * Recurse into sub-directories (`git diff-tree -r`), surfacing nested blobs as
   * full-path changes instead of one change per top-level sub-tree. Applies to
   * the structured `'tree'` format; default `false`. **Inert for `format:
   * 'patch'`**, which always recurses (git's porcelain patch has no
   * non-recursive mode).
   */
  readonly recursive?: boolean;
  /** Lines of equal context bracketing each hunk. Default `3`. Patch-only. */
  readonly contextLines?: number;
  /** Path prefixes on `diff --git`, `--- a/`, `+++ b/` lines. Default `{ old: 'a/', new: 'b/' }`. */
  readonly pathPrefix?: PatchPathPrefix;
}

export interface PatchResult {
  readonly format: 'patch';
  readonly text: string;
  readonly diff: TreeDiff;
}

export type DiffResult = TreeDiff | PatchResult;

/**
 * Diff two tree-like targets. Returns a structured `TreeDiff` by default;
 * pass `format: 'patch'` for a canonical unified-diff text plus the
 * structured view bundled together.
 */
export function diff(ctx: Context, opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
export function diff(ctx: Context, opts: DiffOptions & { format: 'patch' }): Promise<PatchResult>;
export async function diff(ctx: Context, opts: DiffOptions = {}): Promise<DiffResult> {
  await assertRepository(ctx);
  const from = await resolveTreeId(ctx, opts.from ?? 'HEAD');
  const to = opts.to !== undefined ? await resolveTreeId(ctx, opts.to) : undefined;
  // Patch is always recursive (git porcelain); the `tree` format opts in.
  const recursive = opts.format === 'patch' || opts.recursive === true;
  const tree = await diffTrees(ctx, from, to, {
    ...(opts.detectRenames === true ? { detectRenames: true } : {}),
    ...(recursive ? { recursive: true } : {}),
  });
  if (opts.format !== 'patch') return tree;
  const files = await materialisePatchFiles(ctx, tree.changes);
  const text = renderPatch(files, buildPatchOptions(opts));
  return { format: 'patch', text, diff: tree };
}

function buildPatchOptions(opts: DiffOptions): {
  readonly contextLines?: number;
  readonly pathPrefix?: PatchPathPrefix;
} {
  const out: { contextLines?: number; pathPrefix?: PatchPathPrefix } = {};
  if (opts.contextLines !== undefined) out.contextLines = opts.contextLines;
  if (opts.pathPrefix !== undefined) out.pathPrefix = opts.pathPrefix;
  return out;
}

const resolveTreeId = async (ctx: Context, target: string): Promise<ObjectId> => {
  // `validateRefName` is the identity for already-valid names (`'HEAD'`
  // included), so a separate HEAD short-circuit would be redundant.
  const id = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, validateRefName(target));
  const obj = await readObject(ctx, id);
  if (obj.type === 'commit') return obj.data.tree;
  // A non-commit target (tree, blob, tag) is used verbatim; `diffTrees` is the
  // single place that validates the resolved id is tree-shaped.
  return id;
};
