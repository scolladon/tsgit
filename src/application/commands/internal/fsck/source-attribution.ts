import type { ObjectSource, ObjectStore } from '../../../primitives/object-store.js';

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
