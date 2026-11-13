import { resolveAttribute } from '../../../domain/attributes/index.js';
import type { BinaryOverride } from '../../../domain/diff/binary-decision.js';
import { type DiffDrivers, userdiffBinaryOverride } from '../../../domain/diff/userdiff-binary.js';
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

// git reads the index copy whenever the repository is not bare, work tree or not.
const providerFor = (ctx: Context, index: LoadedIndex): Promise<AttributeProvider> =>
  ctx.layout.bare || index === undefined
    ? buildAttributeProvider(ctx)
    : buildCheckinAttributeProvider(ctx, index);

const driversOf = async (ctx: Context): Promise<DiffDrivers> => (await readConfig(ctx)).diff;

export const grepBinaryOverrideReader = (
  ctx: Context,
  index: LoadedIndex,
): GrepBinaryOverrideOf => {
  const provider = lazily(() => providerFor(ctx, index));
  const drivers = lazily(() => driversOf(ctx));
  return async (path) => {
    const { sources, macros } = await (await provider()).sourcesForPath(path);
    return userdiffBinaryOverride(resolveAttribute(sources, path, 'diff', macros), await drivers());
  };
};

/**
 * A tree object or a path-less blob reads no attribute, yet git still applies the
 * `default` driver to it: `diff.default.binary` decides before the content sniff.
 */
export const grepDefaultDriverOverride = async (
  ctx: Context,
): Promise<BinaryOverride | undefined> =>
  userdiffBinaryOverride('unspecified', await driversOf(ctx));

export const grepDefaultDriverReader = (ctx: Context): GrepBinaryOverrideOf => {
  const verdict = lazily(() => grepDefaultDriverOverride(ctx));
  return () => verdict();
};
