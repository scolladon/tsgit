import type { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';
import { logCandidateReadFault } from '../../primitives/internal/ambiguous-candidates.js';

/** git's `advise` header over the candidate list `get_short_oid` shows. */
const CANDIDATES_HINT = 'The candidates are:';

/**
 * git's `get_short_oid` reports an ambiguous abbreviated id on `error:`, then
 * each failed type read its sort and listing made, then lists the candidates on `hint:` — logged here with the structured candidates
 * as its payload — before the read fails. Any other failure reports nothing.
 */
export const reportAmbiguousOid = (ctx: Context, failure: unknown): void => {
  const data = (failure as Partial<TsgitError>).data;
  if (data?.code !== 'AMBIGUOUS_OID_PREFIX') return;
  const { prefix, candidates, readFaults = [] } = data;
  ctx.logger?.error?.(`short object ID ${prefix} is ambiguous`, { prefix });
  for (const fault of readFaults) logCandidateReadFault(ctx, fault);
  ctx.logger?.error?.(CANDIDATES_HINT, { prefix, candidates });
};
