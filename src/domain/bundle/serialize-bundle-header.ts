import { bundleUnsupportedSerializeVersion } from '../commands/error.js';
import type { BundlePrerequisite, BundleRef, BundleVersion } from './types.js';

const MAGIC_V2 = '# v2 git bundle\n';

const sortByOidAscending = (
  prerequisites: ReadonlyArray<BundlePrerequisite>,
): ReadonlyArray<BundlePrerequisite> =>
  [...prerequisites].sort((a, b) => a.oid.localeCompare(b.oid));

const encodePrerequisite = (prereq: BundlePrerequisite): string =>
  `-${prereq.oid} ${prereq.comment}\n`;

const encodeRef = (ref: BundleRef): string => `${ref.oid} ${ref.name}\n`;

/**
 * Serialises a bundle header to UTF-8 bytes.
 *
 * Emits: magic line, prerequisite lines sorted by oid ascending (the sort is
 * applied here so callers cannot forget), ref lines in the given order, and a
 * single blank terminating line. Always emits v2.
 */
export const serializeBundleHeader = (input: {
  readonly version: BundleVersion;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly refs: ReadonlyArray<BundleRef>;
}): Uint8Array => {
  if (input.version !== 2) throw bundleUnsupportedSerializeVersion(input.version);

  const sorted = sortByOidAscending(input.prerequisites);

  const parts: string[] = [MAGIC_V2];
  for (const prereq of sorted) {
    parts.push(encodePrerequisite(prereq));
  }
  for (const ref of input.refs) {
    parts.push(encodeRef(ref));
  }
  parts.push('\n');

  return new TextEncoder().encode(parts.join(''));
};
