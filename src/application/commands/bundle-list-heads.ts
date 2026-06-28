import type { BundleRef, BundleVersion } from '../../domain/bundle/index.js';
import type { RefName } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readBundle } from './internal/read-bundle.js';

export interface BundleListHeadsInput {
  readonly path: string;
  readonly names?: ReadonlyArray<RefName>;
}

export interface BundleListHeadsResult {
  readonly version: BundleVersion;
  readonly refs: ReadonlyArray<BundleRef>;
}

export const bundleListHeads = async (
  ctx: Context,
  input: BundleListHeadsInput,
): Promise<BundleListHeadsResult> => {
  const { header } = await readBundle(ctx, input.path);
  const refs = filterRefs(header.refs, input.names);
  return { version: header.version, refs };
};

const filterRefs = (
  refs: ReadonlyArray<BundleRef>,
  names: ReadonlyArray<RefName> | undefined,
): ReadonlyArray<BundleRef> => {
  if (names === undefined) return refs;
  const nameSet = new Set<string>(names);
  return refs.filter((ref) => nameSet.has(ref.name));
};
