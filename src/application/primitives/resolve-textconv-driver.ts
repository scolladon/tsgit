import { type AttributeValue, resolveAttribute } from '../../domain/attributes/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';

/**
 * How a path's content should be transformed at diff time:
 * - `none`     — raw diff (no textconv; today's behaviour and the T2 fallback).
 * - `external` — run the configured `[diff "<name>"].textconv` command.
 */
export type TextconvChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'external'; readonly command: string };

const NONE: TextconvChoice = { kind: 'none' };

/** Consult `[diff "<name>"]` and return the textconv choice. */
const namedChoice = async (ctx: Context, name: string): Promise<TextconvChoice> => {
  const section = (await readConfig(ctx)).diff?.get(name);
  const textconv = section?.textconv;
  if (textconv === undefined || textconv === '') return NONE; // T2 / T2e fallback
  return { kind: 'external', command: textconv };
};

/** Map a resolved `diff` attribute value to a textconv choice. */
const choiceFromDiffValue = (ctx: Context, value: AttributeValue): Promise<TextconvChoice> => {
  if (value === false || value === true || value === 'unspecified') return Promise.resolve(NONE);
  return namedChoice(ctx, value.set);
};

/**
 * Resolve the textconv driver for `path` using a single `sourcesForPath` lookup.
 * Returns `{ kind: 'none' }` when no `diff=<name>` attribute is active, when the
 * driver is unconfigured, when `textconv` is absent or empty (T2/T2e), or when the
 * `diff` attribute is `false`/`true`/`unspecified` (including via the `binary` macro
 * which expands to `-diff -merge -text`).
 */
export const resolveTextconvDriver = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<TextconvChoice> => {
  const { sources, macros } = await provider.sourcesForPath(path);
  return choiceFromDiffValue(ctx, resolveAttribute(sources, path, 'diff', macros));
};
