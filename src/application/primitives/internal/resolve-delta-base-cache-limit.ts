/**
 * Resolves the delta-base cache's byte budget: an explicit
 * `ctx.cacheBudgets.deltaBaseCacheMaxBytes` always wins; otherwise
 * `core.deltaBaseCacheLimit` (git's own dial for this cache); otherwise git's
 * `96 * 1024 * 1024` default. Lives in its own module — not
 * `internal/object-caches.ts` — so `pack-registry.ts` gains a dependency on
 * `config-read.ts` only, never a runtime edge into the other derived-cache
 * budgets.
 *
 * Resolution order (option, then key, then default) is a pin, mirroring
 * git's own `-c` precedence: when the option is supplied,
 * `core.deltaBaseCacheLimit` is neither read nor validated — `readConfig` is
 * skipped entirely by the `??` short-circuit, not merely ignored after being
 * read.
 */
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';

export const GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;

export const deltaBaseCacheBudgetFor = async (ctx: Context): Promise<number> =>
  ctx.cacheBudgets?.deltaBaseCacheMaxBytes ??
  (await readConfig(ctx)).core?.deltaBaseCacheLimit ??
  GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES;
