/**
 * Symbolic-ref writer. Produces `ref: <target>\n` files (HEAD and friends).
 * Used by `init`/`clone`/branch-rename to set the initial HEAD pointer.
 *
 * @writes
 *   surface: symbolicRef
 *   kind:    byte-identical
 *   format:  git-symbolic-ref
 */
import type { RefName } from '../../domain/objects/index.js';
import { assertRefnameSafe, validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { getRefStore } from './ref-store.js';

/**
 * Write a symbolic ref atomically. Used for HEAD updates that point at a
 * branch, branch renames affecting the current HEAD, and `clone`/`init`
 * to set the initial HEAD.
 *
 * Single-level only in v1: target MUST be a direct ref name (no chained
 * symrefs). `name` is gated on git's refname_is_safe alone, as git's
 * transaction does for an update without a new id; `target` runs through
 * `validateRefName`. Either refuses INVALID_REF before any I/O.
 */
export const writeSymbolicRef = async (
  ctx: Context,
  name: RefName,
  target: RefName,
): Promise<void> => {
  assertRefnameSafe(name);
  const validatedTarget = validateRefName(target);
  await getRefStore(ctx).applyRefUpdates([{ kind: 'setSymbolic', name, target: validatedTarget }]);
};
