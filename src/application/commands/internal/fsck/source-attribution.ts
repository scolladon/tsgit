import type { ObjectSource, ObjectStore } from '../../../primitives/object-store.js';
import type { FsckOptions } from './types.js';

/**
 * Spread target that attributes a finding to the alternate it came from. The
 * primary contributes no key at all, so a repository without alternates keeps
 * its findings byte-identical.
 */
export function attributeTo(
  store: Pick<ObjectStore, 'primary'>,
  source: ObjectSource,
): { readonly objectsDir?: string } {
  return source === store.primary ? {} : { objectsDir: source.objectsDir };
}

/**
 * The sources a health pass audits: every source, or only the local one when
 * `full` is `false` (git skips alternates under `--no-full`).
 */
export function auditedSources(
  store: Pick<ObjectStore, 'sources'>,
  opts: FsckOptions,
): ReadonlyArray<ObjectSource> {
  return opts.full === false ? store.sources.filter((source) => source.local) : store.sources;
}
