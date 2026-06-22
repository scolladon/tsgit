import { type AttributeValue, resolveAttribute } from '../../domain/attributes/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
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
      readonly clean?: string;
      readonly smudge?: string;
      readonly required: boolean;
    };

const IDENTITY: FilterChoice = { kind: 'identity' };

/** Consult `[filter "<name>"]` and return the filter choice. */
const namedFilterChoice = async (ctx: Context, name: string): Promise<FilterChoice> => {
  const section = (await readConfig(ctx)).filter?.get(name);
  if (section === undefined) return IDENTITY;
  return {
    kind: 'external',
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
 * Note: the `binary` macro expands to `-diff -merge -text`, NOT `-filter` — a
 * path marked `binary` with an explicit `filter=<name>` still resolves external.
 */
export const resolveFilterDriver = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<FilterChoice> => {
  const { sources, macros } = await provider.sourcesForPath(path);
  return choiceFromFilterValue(ctx, resolveAttribute(sources, path, 'filter', macros));
};
