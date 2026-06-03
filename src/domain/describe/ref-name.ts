/**
 * Project a full ref name to the short name `describe` reports. Without `--all`
 * only tags are described, so `refs/tags/` is stripped (`v2.0`). With `--all`
 * every ref is a name and only `refs/` is stripped (`heads/main`,
 * `remotes/origin/x`, `tags/v2.0`).
 */
import type { RefName } from '../objects/object-id.js';

const TAGS_PREFIX = 'refs/tags/';
const REFS_PREFIX = 'refs/';

export const describeName = (ref: RefName, all: boolean): string => {
  if (all) {
    return ref.startsWith(REFS_PREFIX) ? ref.slice(REFS_PREFIX.length) : ref;
  }
  return ref.startsWith(TAGS_PREFIX) ? ref.slice(TAGS_PREFIX.length) : ref;
};
