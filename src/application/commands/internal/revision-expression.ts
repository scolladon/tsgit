/**
 * git's `repo_get_oid` over a full revision expression (`HEAD~1`, `v1^{}`,
 * `main@{1}`), with a miss reported as `undefined` rather than thrown — each
 * command owns the refusal git prints for its own argument. Any failure other
 * than the expression naming no object propagates.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { evaluateRevision } from '../rev-parse.js';

/** The codes `evaluateRevision` reports when a revision names no object. */
const UNRESOLVED_REVISION_CODES: ReadonlySet<string | undefined> = new Set([
  'OBJECT_NOT_FOUND',
  'REVPARSE_UNRESOLVED',
]);

export const resolveRevisionExpression = async (
  ctx: Context,
  expression: string,
): Promise<ObjectId | undefined> => {
  try {
    return await evaluateRevision(ctx, expression);
  } catch (error) {
    if (UNRESOLVED_REVISION_CODES.has(errorDataCode(error))) return undefined;
    throw error;
  }
};
