import type { Context } from '../../../ports/context.js';
import { narrowAlternatePathProbe } from '../object-store.js';
import { realpathAllowingMissingLeaf } from './alternate-chain.js';
import { gitPathSyntaxOf } from './git-path-syntax.js';

/**
 * git's `real_pathdup`: every component of an absolute path resolved, links followed hop by
 * hop through the probe that may look outside the repository's roots. `undefined` when the
 * chain cannot be resolved (a loop, a link into nowhere, a component under a file).
 */
export const realPathOf = (ctx: Context, absolute: string): Promise<string | undefined> =>
  realpathAllowingMissingLeaf(
    gitPathSyntaxOf(ctx),
    ctx.alternatePathProbe?.(absolute) ?? narrowAlternatePathProbe(ctx.fs),
    absolute,
    absolute,
  );
