/**
 * Tier-1 `submodules` command — list the submodules in a tree-ish.
 * Materialises the streaming `walkSubmodules` primitive (mirrors the
 * `log` / `walkCommits` pairing). See `docs/design/submodule-walk.md`
 * and ADRs 083–086.
 */
import { ObjectId, type RefName } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import type { SubmoduleEntry } from '../primitives/types.js';
import { looksLikeObjectId } from '../primitives/validators.js';
import { walkSubmodules } from '../primitives/walk-submodules.js';
import { assertRepository } from './internal/repo-state.js';

export type { SubmoduleEntry };

export type SubmodulesAction = {
  readonly action?: 'list';
  /** Tree-ish to walk. Default: `'HEAD'`. */
  readonly ref?: string;
  /** Descend into nested submodules' own `.gitmodules`. Default: `false`. */
  readonly recursive?: boolean;
};

export type SubmodulesResult = {
  readonly kind: 'list';
  readonly entries: ReadonlyArray<SubmoduleEntry>;
};

const coerceRef = (ref: string): RefName | ObjectId =>
  looksLikeObjectId(ref) ? ObjectId.from(ref) : validateRefName(ref);

export const submodules = async (
  ctx: Context,
  opts: SubmodulesAction = {},
): Promise<SubmodulesResult> => {
  await assertRepository(ctx);
  const ref = coerceRef(opts.ref ?? 'HEAD');
  const recursive = opts.recursive === true;
  const entries: SubmoduleEntry[] = [];
  for await (const entry of walkSubmodules(ctx, { ref, recursive })) {
    entries.push(entry);
  }
  return { kind: 'list', entries };
};
