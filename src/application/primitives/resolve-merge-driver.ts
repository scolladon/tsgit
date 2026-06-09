import { resolveAttribute } from '../../domain/attributes/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';

/**
 * How a path's content merge should be performed:
 * - `text`     — the built-in 3-way line merge (git's default).
 * - `union`    — the built-in line merge resolving overlaps by concatenating both sides.
 * - `binary`   — take `ours` and declare a conflict (git's `-merge`).
 * - `external` — run the configured `[merge "<driver>"].driver` command.
 */
export type MergeDriverChoice =
  | { readonly kind: 'text' }
  | { readonly kind: 'union' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'external'; readonly command: string; readonly name?: string };

const TEXT: MergeDriverChoice = { kind: 'text' };
const UNION: MergeDriverChoice = { kind: 'union' };
const BINARY: MergeDriverChoice = { kind: 'binary' };

/** Map a `merge=<name>` value to a driver choice, consulting `[merge "<name>"]`. */
const namedChoice = async (ctx: Context, name: string): Promise<MergeDriverChoice> => {
  if (name === 'text') return TEXT;
  if (name === 'binary') return BINARY;
  if (name === 'union') return UNION;
  const driver = (await readConfig(ctx)).merge?.get(name);
  if (driver?.driver === undefined) return TEXT; // unconfigured / driverless → built-in text
  return driver.name === undefined
    ? { kind: 'external', command: driver.driver }
    : { kind: 'external', command: driver.driver, name: driver.name };
};

/**
 * Resolve the merge driver for `path`: read its `merge` attribute via `provider`,
 * then map it to a built-in or external choice. The caller builds `provider`
 * once per merge so the `.gitattributes` sources are parsed once.
 */
export const resolveMergeDriver = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<MergeDriverChoice> => {
  const { sources, macros } = await provider.sourcesForPath(path);
  const value = resolveAttribute(sources, path, 'merge', macros);
  if (value === false) return BINARY;
  if (value === true || value === 'unspecified') return TEXT;
  return namedChoice(ctx, value.set);
};
