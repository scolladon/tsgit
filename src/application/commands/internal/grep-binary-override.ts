import { resolveAttribute } from '../../../domain/attributes/index.js';
import type { BinaryOverride } from '../../../domain/diff/binary-decision.js';
import { userdiffBinaryOverride } from '../../../domain/diff/userdiff-binary.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { lazily } from '../../primitives/internal/lazily.js';
import {
  type AttributeProvider,
  buildAttributeProvider,
  buildCheckinAttributeProvider,
} from '../../primitives/internal/read-gitattributes.js';

export type GrepBinaryOverrideOf = (path: FilePath) => Promise<BinaryOverride | undefined>;

/** The index a target loaded, when it loaded one: git's attribute fallback reads only a loaded index. */
export type LoadedIndex = { readonly entries: ReadonlyArray<IndexEntry> } | undefined;

const providerFor = (ctx: Context, index: LoadedIndex): Promise<AttributeProvider> =>
  ctx.layout.bare || ctx.layout.workDir === undefined || index === undefined
    ? buildAttributeProvider(ctx)
    : buildCheckinAttributeProvider(ctx, index);

export const grepBinaryOverrideReader = (
  ctx: Context,
  index: LoadedIndex,
): GrepBinaryOverrideOf => {
  const provider = lazily(() => providerFor(ctx, index));
  const drivers = lazily(async () => (await readConfig(ctx)).diff);
  return async (path) => {
    const { sources, macros } = await (await provider()).sourcesForPath(path);
    return userdiffBinaryOverride(resolveAttribute(sources, path, 'diff', macros), await drivers());
  };
};
