import { type AttributeValue, resolveAttribute } from '../../domain/attributes/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { assertValidBooleanConfigInSection } from './internal/boolean-config-guard.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';

/**
 * How a path's content should be filtered on clean (add) and smudge (checkout):
 * - `identity` — pass bytes through unchanged (no filter configured).
 * - `external` — run the configured `[filter "<name>"].clean` / `.smudge` commands.
 *   A missing `clean` means identity clean; a missing `smudge` means identity smudge.
 */
export type FilterChoice =
  | { readonly kind: 'identity' }
  | {
      readonly kind: 'external';
      readonly name: string;
      readonly clean?: string;
      readonly smudge?: string;
      readonly required: boolean;
    };

const IDENTITY: FilterChoice = { kind: 'identity' };

/** Consult `[filter "<name>"]` and return the filter choice. */
const namedFilterChoice = async (ctx: Context, name: string): Promise<FilterChoice> => {
  // Once a filter attribute engages, git validates EVERY `[filter "<d>"]`
  // required value — selected or not, section present or not — while a
  // subsectionless `[filter] required` stays inert. So the section-wide guard
  // runs before the per-driver section lookup and its early return.
  await assertValidBooleanConfigInSection(ctx, 'filter', ['required'], { requireSubsection: true });
  const section = (await readConfig(ctx)).filter?.get(name);
  if (section === undefined) return IDENTITY;
  return {
    kind: 'external',
    name,
    ...(section.clean !== undefined && { clean: section.clean }),
    ...(section.smudge !== undefined && { smudge: section.smudge }),
    required: section.required ?? false,
  };
};

/** Map a resolved `filter` attribute value to a filter choice. */
const choiceFromFilterValue = (ctx: Context, value: AttributeValue): Promise<FilterChoice> => {
  if (value === false || value === true || value === 'unspecified')
    return Promise.resolve(IDENTITY);
  return namedFilterChoice(ctx, value.set);
};

/**
 * Resolve the filter driver for `path` using a single `sourcesForPath` lookup.
 * Returns `{ kind: 'identity' }` when no `filter=<name>` attribute is active,
 * when the driver section is absent (`filter=name` but no `[filter "name"]`),
 * or when the `filter` attribute is `false`/`true`/`unspecified`.
 *
 * `eagerSectionValidation` mirrors git's convert-machinery split: a CONVERTING
 * caller (clean on add, smudge on checkout) validates every `[filter "<d>"]`
 * required value per path even when NO filter attribute matches — measured:
 * `git add`/`checkout`/`commit -a` refuse a malformed unrelated driver with no
 * `.gitattributes` at all, while `git status` and tree-to-tree diff accept the
 * same state. Status-shaped callers leave it off and still refuse when an
 * attribute engages a driver (the `namedFilterChoice` guard).
 *
 * Note: the `binary` macro expands to `-diff -merge -text`, NOT `-filter` — a
 * path marked `binary` with an explicit `filter=<name>` still resolves external.
 */
export const resolveFilterDriver = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
  options: { readonly eagerSectionValidation?: boolean } = {},
): Promise<FilterChoice> => {
  if (options.eagerSectionValidation === true) {
    await assertValidBooleanConfigInSection(ctx, 'filter', ['required'], {
      requireSubsection: true,
    });
  }
  const { sources, macros } = await provider.sourcesForPath(path);
  return choiceFromFilterValue(ctx, resolveAttribute(sources, path, 'filter', macros));
};
