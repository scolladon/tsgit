import type { AttributeValue } from '../../../domain/attributes/attribute-value.js';
import { resolveAttribute } from '../../../domain/attributes/index.js';
import type { BinaryOverride } from '../../../domain/diff/binary-decision.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { buildAttributeProvider } from './read-gitattributes.js';

/**
 * Resolve a `diff` attribute value to a similarity/break-scoring content-kind
 * override. Unlike `resolveBinaryOverride` (patch/numstat rendering), textconv
 * never enters this decision: git's rename/break scorer
 * (`diff_filespec_is_binary`) reads the RAW blob, never textconv output.
 * Mirrors userdiff's `driver.binary` tristate: `-diff` forces binary, bare
 * `diff` forces text, `diff=<name>` defers to that driver's own
 * `diff.<name>.binary` config when set, and unspecified or an unconfigured
 * driver leave `undefined` for the caller's own content sniff to decide.
 */
export function resolveSimilarityOverride(
  value: AttributeValue,
  driverBinary: boolean | undefined,
): BinaryOverride | undefined {
  if (value === false) return 'binary';
  if (value === true) return 'text';
  if (value === 'unspecified') return undefined;
  if (driverBinary === undefined) return undefined;
  return driverBinary ? 'binary' : 'text';
}

/**
 * Resolves each path's similarity content-kind override, lazily and once per
 * path. Every rename/break fingerprinting call site in
 * `detect-similarity-renames.ts` threads a single instance of this through,
 * so an unattributed repo never builds an `AttributeProvider` at all — the
 * provider (and, for a named driver, `readConfig`) is only ever touched on
 * the first path a caller actually asks about.
 */
export interface SimilarityContentKindResolver {
  readonly overrideFor: (path: FilePath) => Promise<BinaryOverride | undefined>;
}

/** The driver's own `diff.<name>.binary` config, or `undefined` when the
 *  attribute did not name a driver at all. */
async function resolveDriverBinary(
  ctx: Context,
  value: AttributeValue,
): Promise<boolean | undefined> {
  if (typeof value !== 'object') return undefined;
  const config = await readConfig(ctx);
  return config.diff?.get(value.set)?.binary;
}

export function buildSimilarityContentKindResolver(ctx: Context): SimilarityContentKindResolver {
  let providerPromise: ReturnType<typeof buildAttributeProvider> | undefined;
  const getProvider = (): ReturnType<typeof buildAttributeProvider> => {
    providerPromise ??= buildAttributeProvider(ctx);
    return providerPromise;
  };

  const cache = new Map<FilePath, Promise<BinaryOverride | undefined>>();
  const resolveOne = async (path: FilePath): Promise<BinaryOverride | undefined> => {
    const provider = await getProvider();
    const { sources, macros } = await provider.sourcesForPath(path);
    const value = resolveAttribute(sources, path, 'diff', macros);
    const driverBinary = await resolveDriverBinary(ctx, value);
    return resolveSimilarityOverride(value, driverBinary);
  };

  return {
    overrideFor: (path) => {
      const pending = cache.get(path) ?? resolveOne(path);
      cache.set(path, pending);
      return pending;
    },
  };
}
