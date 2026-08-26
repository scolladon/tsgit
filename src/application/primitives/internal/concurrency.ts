import { deriveLimits } from '../../../domain/concurrency/derive-limits.js';
import type { Context, RepositoryConfig } from '../../../ports/context.js';

/** The two stage classes every pool bound classifies into — see the concurrency-policy design. */
export type Bucket = 'cpuBound' | 'ioBound';

/**
 * `RepositoryConfig.parallelism`'s value for `bucket`, if the caller set
 * one. A bare number applies to both buckets; the `{ cpu, io }` form
 * overrides them independently, and an absent member falls through to the
 * derived bound for that bucket.
 */
const overrideFor = (
  parallelism: RepositoryConfig['parallelism'],
  bucket: Bucket,
): number | undefined => {
  if (parallelism === undefined) return undefined;
  if (typeof parallelism === 'number') return parallelism;
  return bucket === 'cpuBound' ? parallelism.cpu : parallelism.io;
};

/**
 * Resolves the concurrency bound for one bucket. An explicit
 * `RepositoryConfig.parallelism` override always wins; otherwise the bound
 * comes from the Context's resolved concurrency policy, or — when that is
 * absent entirely (an unmodified test Context, or a runtime with no machine
 * facts at all) — the safe floor.
 */
export const limitFor = (ctx: Context, bucket: Bucket): number => {
  const override = overrideFor(ctx.config?.parallelism, bucket);
  if (override !== undefined) return override;
  return (ctx.concurrency ?? deriveLimits({}))[bucket];
};
