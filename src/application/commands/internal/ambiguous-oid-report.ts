import type { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';

/**
 * git's `get_short_oid` reports an ambiguous abbreviated id on `error:` before
 * the read fails; a reader that carries on past the failure (`name-rev`,
 * `mailmap.blob`) emits that line itself. Any other failure reports nothing.
 */
export const reportAmbiguousOid = (ctx: Context, failure: unknown): void => {
  const data = (failure as Partial<TsgitError>).data;
  if (data?.code !== 'AMBIGUOUS_OID_PREFIX') return;
  ctx.logger?.error?.(`short object ID ${data.prefix} is ambiguous`, { prefix: data.prefix });
};
