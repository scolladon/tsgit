import { resolveAttribute } from '../../../domain/attributes/index.js';
import type { BinaryOverride } from '../../../domain/diff/binary-decision.js';
import type { FlatTreeEntry } from '../../../domain/diff/flat-tree.js';
import type { FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { lazily } from '../../primitives/internal/lazily.js';
import {
  attributeBlobLookup,
  buildAttributeProvider,
} from '../../primitives/internal/read-gitattributes.js';
import { resolveDriverBinary } from '../../primitives/internal/resolve-similarity-content-kind.js';
import { resolveBinaryOverride } from '../../primitives/resolve-binary-override.js';

export type BinaryOverrideOf = (path: FilePath) => Promise<BinaryOverride | undefined>;

/**
 * The per-path binary decision `diff-tree --binary` takes from the `diff` attribute: the work tree
 * first, the current index (C) for files absent from disk. The provider is built on the first ask.
 */
export const binaryOverrideReader = (
  ctx: Context,
  current: ReadonlyMap<FilePath, FlatTreeEntry>,
): BinaryOverrideOf => {
  const provider = lazily(() =>
    buildAttributeProvider(ctx, {
      kind: 'worktree-first',
      index: attributeBlobLookup([...current].map(([path, entry]) => ({ path, ...entry }))),
    }),
  );
  return async (path) => {
    const { sources, macros } = await (await provider()).sourcesForPath(path);
    const value = resolveAttribute(sources, path, 'diff', macros);
    const driverBinary = await resolveDriverBinary(ctx, value);
    return resolveBinaryOverride(value, {
      textconvConfigured: false,
      driverBinary,
      rawIsBinary: false,
    }).patch;
  };
};
