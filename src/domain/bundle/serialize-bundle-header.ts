import type { BundleHashAlgorithm, BundlePrerequisite, BundleRef, BundleVersion } from './types.js';

const MAGIC_V2 = '# v2 git bundle\n';
const MAGIC_V3 = '# v3 git bundle\n';

const sortByOidAscending = (
  prerequisites: ReadonlyArray<BundlePrerequisite>,
): ReadonlyArray<BundlePrerequisite> =>
  [...prerequisites].sort((a, b) => a.oid.localeCompare(b.oid));

const encodePrerequisite = (prereq: BundlePrerequisite): string =>
  `-${prereq.oid} ${prereq.comment}\n`;

const encodeRef = (ref: BundleRef): string => `${ref.oid} ${ref.name}\n`;

const encodeMagic = (version: BundleVersion, hashAlgorithm: BundleHashAlgorithm): string =>
  version === 3 ? `${MAGIC_V3}@object-format=${hashAlgorithm}\n` : MAGIC_V2;

/**
 * Serialises a bundle header to UTF-8 bytes.
 *
 * Emits: magic line (plus, for v3, the `@object-format` capability — always,
 * including `sha1`), prerequisite lines sorted by oid ascending (the sort is
 * applied here so callers cannot forget), ref lines in the given order, and
 * a single blank terminating line. Version and algorithm selection is the
 * caller's decision — this function only encodes what it is given.
 */
export const serializeBundleHeader = (input: {
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly refs: ReadonlyArray<BundleRef>;
}): Uint8Array => {
  const sorted = sortByOidAscending(input.prerequisites);

  const parts: string[] = [encodeMagic(input.version, input.hashAlgorithm)];
  for (const prereq of sorted) {
    parts.push(encodePrerequisite(prereq));
  }
  for (const ref of input.refs) {
    parts.push(encodeRef(ref));
  }
  parts.push('\n');

  return new TextEncoder().encode(parts.join(''));
};
