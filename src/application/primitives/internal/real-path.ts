import type { Context } from '../../../ports/context.js';
import { narrowAlternatePathProbe } from '../object-store.js';
import {
  type RealpathOutcome,
  realpathAllowingMissingLeaf,
  realpathOutcome,
} from './alternate-chain.js';
import { gitPathSyntaxOf } from './git-path-syntax.js';

const probeOf = (ctx: Context, absolute: string) =>
  ctx.alternatePathProbe?.(absolute) ?? narrowAlternatePathProbe(ctx.fs);

/**
 * git's `real_pathdup`: every component of an absolute path resolved, links followed hop by
 * hop through the probe that may look outside the repository's roots. `undefined` when the
 * chain cannot be resolved (a loop, a link into nowhere, a component under a file).
 */
export const realPathOf = (ctx: Context, absolute: string): Promise<string | undefined> =>
  realpathAllowingMissingLeaf(gitPathSyntaxOf(ctx), probeOf(ctx, absolute), absolute, absolute);

/** {@link realPathOf} that says where and why the chain stopped. */
export const realPathOutcomeOf = (ctx: Context, absolute: string): Promise<RealpathOutcome> =>
  realpathOutcome(gitPathSyntaxOf(ctx), probeOf(ctx, absolute), absolute, absolute);
