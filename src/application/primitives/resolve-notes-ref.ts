import type { RefName } from '../../domain/objects/object-id.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';

/** The default notes namespace git uses when no override is in effect. */
export const DEFAULT_NOTES_REF = 'refs/notes/commits' as RefName;

/**
 * Resolves the notes ref to use for a notes operation.
 *
 * Precedence (highest first):
 *   1. Caller-supplied `ref` argument
 *   2. `GIT_NOTES_REF` environment variable (via `ctx.env`)
 *   3. `core.notesRef` git config value
 *   4. `refs/notes/commits` (hard-coded default)
 *
 * The resolved name is validated as a legal ref name before being returned.
 */
export async function resolveNotesRef(ctx: Context, ref?: RefName): Promise<RefName> {
  if (ref !== undefined) return validateRefName(ref);

  const envRef = ctx.env?.get('GIT_NOTES_REF');
  if (envRef !== undefined) return validateRefName(envRef);

  const config = await readConfig(ctx);
  const configRef = config.core?.notesRef;
  if (configRef !== undefined) return validateRefName(configRef);

  return DEFAULT_NOTES_REF;
}
