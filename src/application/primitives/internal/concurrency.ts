import { deriveLimits } from '../../../domain/concurrency/derive-limits.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context, RepositoryConfig } from '../../../ports/context.js';
import { boundedMap } from './bounded-map.js';
import { type BoundedReader, createBoundedReader } from './bounded-reader.js';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from './concurrency-limiter.js';

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

/**
 * The bucket's bound with no `Context` to consult — the same safe floor
 * `limitFor` itself falls back to when a Context carries no concurrency
 * policy. For the handful of public, `Context`-free pipeline operators
 * (`hashWorkdir`, `loadBlob`) that have no repository to derive a real
 * machine-backed bound from.
 */
export const defaultLimitFor = (bucket: Bucket): number => deriveLimits({})[bucket];

/**
 * Bounded fan-out over `items`, the limit resolved from `ctx`'s bucket —
 * `boundedMap` with its numeric limit replaced by the policy. Same
 * input-order / rejection-propagates-without-cancelling contract.
 */
export const boundedMapFor = <T, R>(
  ctx: Context,
  bucket: Bucket,
  items: ReadonlyArray<T>,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => boundedMap(items, limitFor(ctx, bucket), worker);

/**
 * A counting semaphore sized from `ctx`'s bucket, for a streaming caller
 * that discovers work incrementally (see `concurrency-limiter.ts`).
 */
export const limiterFor = (ctx: Context, bucket: Bucket): ConcurrencyLimiter =>
  createConcurrencyLimiter(limitFor(ctx, bucket));

/**
 * A bounded, per-id-deduped reader sized from `ctx`'s bucket (see
 * `bounded-reader.ts`).
 */
export const boundedReaderFor = <T>(
  ctx: Context,
  bucket: Bucket,
  read: (id: ObjectId) => Promise<T>,
): BoundedReader<T> => createBoundedReader(limitFor(ctx, bucket), read);
