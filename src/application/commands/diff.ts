import type { RenameDetectOptions, StatTreeDiff, TreeDiff } from '../../domain/diff/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context, RepositoryConfig } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { createObjectTypeTable } from '../primitives/internal/object-type-table.js';
import type { DiffTreesOptions } from '../primitives/types.js';
import { assertOperationalRepositorySettingsFirst } from './internal/repo-state.js';
import { peelToTree, resolveReference } from './internal/resolve-rev.js';

export interface DiffOptions {
  /** Resolve to a tree. Accepts any revision (ref, oid, `HEAD`, `~`/`^` grammar). */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  /**
   * Fine-tune detection. `breakRewrites` also applies when `detectRenames` is
   * off (git's `--no-renames -B`); the other members only apply when it is on.
   */
  readonly renameOptions?: RenameDetectOptions;
  /**
   * Recurse into sub-directories (`git diff-tree -r`), surfacing nested blobs as
   * full-path changes instead of one change per top-level sub-tree. Default `false`.
   */
  readonly recursive?: boolean;
  /**
   * Attach per-file line counts (`added` / `deleted` / `binary`) to each change —
   * the data half of git's `--numstat`. Off by default (tree-level, no blob reads).
   * Implies a recursive diff — git's `--numstat` recurses before rename detection.
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
  await assertOperationalRepositorySettingsFirst(ctx);
  const { from, to } = await resolveSides(ctx, opts);
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — after rev resolution.
  await assertValidPromisorRemoteConfig(ctx);
  const treeOptions = resolveDiffOptions(opts, ctx.config);
  return diffTrees(ctx, from, to, treeOptions);
}

/** git's `setup_revisions`: each expression parsed into the invocation's table, in order, before either is peeled. */
async function resolveSides(
  ctx: Context,
  opts: DiffOptions,
): Promise<{ readonly from: ObjectId; readonly to: ObjectId | undefined }> {
  const table = createObjectTypeTable();
  const fromId = await resolveReference(ctx, table, opts.from ?? 'HEAD');
  const toId = opts.to === undefined ? undefined : await resolveReference(ctx, table, opts.to);
  const from = await peelToTree(ctx, table, fromId);
  return { from, to: toId === undefined ? undefined : await peelToTree(ctx, table, toId) };
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
    // Stryker disable next-line ConditionalExpression: equivalent — spreading `renameOptions: undefined` (the `true` branch) instead of omitting the key is unobservable; diffTrees reads options.renameOptions by value (undefined either way), never by key presence.
    ...(opts.renameOptions !== undefined ? { renameOptions: opts.renameOptions } : {}),
    ...(opts.recursive === true ? { recursive: true } : {}),
    ...(opts.withStat === true ? { withStat: true } : {}),
    ...(ignoreWhitespace !== undefined ? { ignoreWhitespace } : {}),
    ...(ignoreCrAtEol === true ? { ignoreCrAtEol: true } : {}),
    ...(ignoreBlankLines === true ? { ignoreBlankLines: true } : {}),
  };
}
