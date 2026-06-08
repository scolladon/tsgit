/**
 * `submodule` porcelain — the `repo.submodule.*` nested namespace.
 *
 * `list` materialises the streaming `walkSubmodules` primitive over a tree-ish
 * (mirrors `log` / `walkCommits`). The write verbs (`init` / `sync` / `deinit`)
 * operate on local state — the working-tree `.gitmodules`, `.git/config`
 * `[submodule "<name>"]` sections, and (for `deinit`) the submodule working
 * tree. Each verb is a Context-aware function returning a per-verb concrete
 * result (no discriminator); the namespace binder lives in
 * `internal/submodule-namespace.ts`.
 */
import { ObjectId, type RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import type { SubmoduleEntry } from '../primitives/types.js';
import { looksLikeObjectId } from '../primitives/validators.js';
import { walkSubmodules } from '../primitives/walk-submodules.js';
import { assertRepository } from './internal/repo-state.js';

export type { SubmoduleEntry };

export interface SubmoduleListOptions {
  /** Tree-ish to walk. Default: `'HEAD'`. */
  readonly ref?: string;
  /** Descend into nested submodules' own `.gitmodules`. Default: `false`. */
  readonly recursive?: boolean;
  /**
   * Cap on recursion depth. Default: `MAX_SUBMODULE_DEPTH`. Entries at exactly
   * this depth are yielded but not recursed into.
   */
  readonly maxDepth?: number;
}

export interface SubmoduleListResult {
  readonly entries: ReadonlyArray<SubmoduleEntry>;
}

const coerceRef = (ref: string): RefName | ObjectId =>
  looksLikeObjectId(ref) ? ObjectId.from(ref) : validateRefName(ref);

export const submoduleList = async (
  ctx: Context,
  opts: SubmoduleListOptions = {},
): Promise<SubmoduleListResult> => {
  await assertRepository(ctx);
  const ref = coerceRef(opts.ref ?? 'HEAD');
  const recursive = opts.recursive === true;
  const entries: SubmoduleEntry[] = [];
  for await (const entry of walkSubmodules(ctx, {
    ref,
    recursive,
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `walkSubmodules` reads `options?.maxDepth ?? MAX_SUBMODULE_DEPTH`, so spreading `{ maxDepth: undefined }` is identical to spreading `{}`; the conditional only exists to keep the spread well-typed under `exactOptionalPropertyTypes`.
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  })) {
    entries.push(entry);
  }
  return { entries };
};
