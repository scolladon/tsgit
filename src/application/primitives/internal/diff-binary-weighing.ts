/**
 * Where git's `diff_filespec_is_binary` falls through to weighing a blob — the
 * one step that reads `core.bigFileThreshold` — instead of taking binary-ness
 * from the path's `diff` attribute. A set or unset attribute (and so the
 * `binary` macro) settles it, as does a named driver's `diff.<d>.binary`; a
 * named driver's textconv settles it only for the patch, which converts
 * before weighing, never for the stat, which weighs the raw blob.
 */
import { resolveAttribute } from '../../../domain/attributes/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import type { AttributeProvider } from './read-gitattributes.js';

type Weighing = 'settled' | 'raw-only' | 'open';

const weighingOf = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<Weighing> => {
  const { sources, macros } = await provider.sourcesForPath(path);
  const value = resolveAttribute(sources, path, 'diff', macros);
  if (value === 'unspecified') return 'open';
  if (typeof value !== 'object') return 'settled';
  const driver = (await readConfig(ctx)).diff?.get(value.set);
  if (driver?.binary !== undefined) return 'settled';
  return driver?.textconv === undefined ? 'open' : 'raw-only';
};

/** The stat (`builtin_diffstat`) weighs `path`'s raw blob. */
export const statWeighsBlob = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<boolean> => (await weighingOf(ctx, provider, path)) !== 'settled';

/** The patch (`builtin_diff`, which the whitespace drop runs) weighs `path`'s blob. */
export const patchWeighsBlob = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<boolean> => (await weighingOf(ctx, provider, path)) === 'open';
