import type { RenameDetectOptions, StatTreeDiff, TreeDiff } from '../../domain/diff/index.js';
import type { Context, RepositoryConfig } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import type { DiffTreesOptions } from '../primitives/types.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { resolveTreeish } from './internal/resolve-rev.js';

export interface DiffOptions {
  /** Resolve to a tree. Accepts any revision (ref, oid, `HEAD`, `~`/`^` grammar). */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  /** Fine-tune rename detection (limit, threshold). Only used when `detectRenames` is true. */
  readonly renameOptions?: RenameDetectOptions;
  /**
   * Recurse into sub-directories (`git diff-tree -r`), surfacing nested blobs as
   * full-path changes instead of one change per top-level sub-tree. Default `false`.
   */
  readonly recursive?: boolean;
  /**
   * Attach per-file line counts (`added` / `deleted` / `binary`) to each change —
   * the data half of git's `--numstat`. Off by default (tree-level, no blob reads).
   */
  readonly withStat?: boolean;
  /**
   * Whitespace-normalization mode for line equality (data mode, not a rendering
   * knob). `'all'` ignores all space/tab; `'change'` ignores amount-only changes;
   * `'at-eol'` ignores trailing whitespace only.
   */
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  /**
   * When `true`, a trailing CR (`\r`) immediately before the line terminator is
   * treated as insignificant (data mode — `git diff --ignore-cr-at-eol`).
   */
  readonly ignoreCrAtEol?: boolean;
  /**
   * When `true`, change groups consisting solely of blank lines are excluded from
   * added/deleted counts and the drop-pass predicate (data mode —
   * `git diff --ignore-blank-lines`).
   */
  readonly ignoreBlankLines?: boolean;
}

/**
 * Diff two tree-like targets, returning the structured `TreeDiff`. Pass
 * `withStat: true` to attach per-file line counts (a `StatTreeDiff`). Rendering
 * the diff as a unified patch is the caller's concern.
 */
export function diff(ctx: Context, opts: DiffOptions & { withStat: true }): Promise<StatTreeDiff>;
export function diff(ctx: Context, opts?: DiffOptions): Promise<TreeDiff>;
export async function diff(ctx: Context, opts: DiffOptions = {}): Promise<TreeDiff | StatTreeDiff> {
  await assertOperationalRepository(ctx);
  const from = await resolveTreeish(ctx, opts.from ?? 'HEAD');
  const to = opts.to !== undefined ? await resolveTreeish(ctx, opts.to) : undefined;
  const treeOptions = resolveDiffOptions(opts, ctx.config);
  return diffTrees(ctx, from, to, treeOptions);
}

function resolveDiffOptions(
  opts: DiffOptions,
  config: RepositoryConfig | undefined,
): DiffTreesOptions {
  const detectRenames = opts.detectRenames ?? config?.detectRenames;
  const ignoreWhitespace = opts.ignoreWhitespace ?? config?.ignoreWhitespace;
  const ignoreCrAtEol = opts.ignoreCrAtEol ?? config?.ignoreCrAtEol;
  const ignoreBlankLines = opts.ignoreBlankLines ?? config?.ignoreBlankLines;
  return {
    ...(detectRenames === true ? { detectRenames: true } : {}),
    ...(opts.renameOptions !== undefined ? { renameOptions: opts.renameOptions } : {}),
    ...(opts.recursive === true ? { recursive: true } : {}),
    ...(opts.withStat === true ? { withStat: true } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
    ...(ignoreCrAtEol === true ? { ignoreCrAtEol: true } : {}),
    ...(ignoreBlankLines === true ? { ignoreBlankLines: true } : {}),
  };
}
