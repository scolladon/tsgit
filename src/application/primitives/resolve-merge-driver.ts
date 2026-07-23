import {
  type AttributeValue,
  resolveAttribute,
  resolveMarkerSize,
} from '../../domain/attributes/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import type { AttributeProvider } from './internal/read-gitattributes.js';

/**
 * How a path's content merge should be performed:
 * - `text`            — the built-in 3-way line merge (git's default).
 * - `union`           — the built-in line merge resolving overlaps by concatenating both sides.
 * - `binary`          — take `ours` and declare a conflict (git's `-merge`).
 * - `external`        — run the configured `[merge "<driver>"].driver` command.
 * - `missing-command` — a driver is registered (`name`/`recursive` set) but has no `driver`
 *   command; git refuses this lazily, only when the driver is actually selected for a path.
 */
export type MergeDriverChoice =
  | { readonly kind: 'text' }
  | { readonly kind: 'union' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'external'; readonly command: string; readonly name?: string }
  | { readonly kind: 'missing-command'; readonly name: string };

const TEXT: MergeDriverChoice = { kind: 'text' };
const UNION: MergeDriverChoice = { kind: 'union' };
const BINARY: MergeDriverChoice = { kind: 'binary' };

/** Map a `merge=<name>` value to a driver choice, consulting `[merge "<name>"]` first. */
const namedChoice = async (ctx: Context, name: string): Promise<MergeDriverChoice> => {
  const driver = (await readConfig(ctx)).merge?.get(name);
  if (driver?.driver !== undefined) {
    return driver.name === undefined
      ? { kind: 'external', command: driver.driver }
      : { kind: 'external', command: driver.driver, name: driver.name };
  }
  // Registered but driverless: a non-empty record (name/recursive set) with no driver command
  // → git's lazy "lacks command line" refusal, thrown per-path at the content-merge
  // chokepoint so an unused section stays inert. Must precede the name fallback.
  if (driver !== undefined && (driver.name !== undefined || driver.recursive !== undefined)) {
    return { kind: 'missing-command', name };
  }
  // No registered driver record (no section / empty {} / unknown-key-only) → built-in by name.
  if (name === 'binary') return BINARY;
  if (name === 'union') return UNION;
  return TEXT; // 'text' or any unknown name defaults to built-in text
};

/** Map a resolved `merge` attribute value to a driver choice. */
const driverFromMergeValue = (ctx: Context, value: AttributeValue): Promise<MergeDriverChoice> => {
  if (value === false) return Promise.resolve(BINARY);
  if (value === true || value === 'unspecified') return Promise.resolve(TEXT);
  return namedChoice(ctx, value.set);
};

/** A path's merge driver choice paired with its conflict-marker length. */
export interface PathMergeSpec {
  readonly driver: MergeDriverChoice;
  readonly markerSize: number;
}

/**
 * Resolve both the merge driver and the conflict-marker size for `path` from a
 * single `sourcesForPath` lookup — the `merge` and `conflict-marker-size`
 * attributes are read off the same precedence-ordered sources.
 */
export const resolvePathMergeSpec = async (
  ctx: Context,
  provider: AttributeProvider,
  path: FilePath,
): Promise<PathMergeSpec> => {
  const { sources, macros } = await provider.sourcesForPath(path);
  const driver = await driverFromMergeValue(ctx, resolveAttribute(sources, path, 'merge', macros));
  const markerSize = resolveMarkerSize(
    resolveAttribute(sources, path, 'conflict-marker-size', macros),
  );
  return { driver, markerSize };
};
