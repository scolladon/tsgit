import { notesRefOutside } from '../../domain/commands/error.js';
import type { RefName } from '../../domain/objects/object-id.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';

/** The notes-ref namespace; every notes ref must live under it. */
const NOTES_REF_PREFIX = 'refs/notes/';

/** The default notes namespace git uses when no override is in effect. */
export const DEFAULT_NOTES_REF = `${NOTES_REF_PREFIX}commits` as RefName;

/**
 * Expands an explicit `--ref`-style argument the way git's `expand_notes_ref`
 * does: a `refs/notes/` ref is kept, a `notes/` ref only gains the `refs/`
 * prefix, anything else is nested under `refs/notes/`. So `build` becomes
 * `refs/notes/build` and `refs/heads/evil` becomes `refs/notes/refs/heads/evil`
 * — an explicit value can never escape the notes namespace.
 */
const expandNotesRef = (ref: string): string => {
  if (ref.startsWith(NOTES_REF_PREFIX)) return ref;
  if (ref.startsWith('notes/')) return `refs/${ref}`;
  return `${NOTES_REF_PREFIX}${ref}`;
};

/**
 * `GIT_NOTES_REF` / `core.notesRef` are used verbatim — git does not expand
 * them — so a value outside `refs/notes/` is refused rather than silently
 * hijacking another namespace.
 */
const requireInsideNotes = (ref: string): string => {
  if (!ref.startsWith(NOTES_REF_PREFIX)) throw notesRefOutside(ref);
  return ref;
};

/**
 * Resolves the notes ref to use for a notes operation.
 *
 * Precedence (highest first):
 *   1. Explicit `ref` argument (git `--ref`) — expanded under `refs/notes/`
 *   2. `GIT_NOTES_REF` environment variable — verbatim, refused if outside
 *   3. `core.notesRef` git config value — verbatim, refused if outside
 *   4. `refs/notes/commits` (hard-coded default)
 *
 * The resolved name is validated as a legal ref name before being returned.
 */
export async function resolveNotesRef(ctx: Context, ref?: string): Promise<RefName> {
  if (ref !== undefined) return validateRefName(expandNotesRef(ref));

  const envRef = ctx.env?.get('GIT_NOTES_REF');
  if (envRef !== undefined) return validateRefName(requireInsideNotes(envRef));

  const config = await readConfig(ctx);
  const configRef = config.core?.notesRef;
  if (configRef !== undefined) return validateRefName(requireInsideNotes(configRef));

  return DEFAULT_NOTES_REF;
}
