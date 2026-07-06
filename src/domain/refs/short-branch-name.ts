import type { RefName } from '../objects/index.js';
import { HEADS_PREFIX } from './ref-prefixes.js';

/**
 * Strip the `refs/heads/` prefix from a full ref, yielding the short branch
 * name. A ref outside `refs/heads/` (a tag, a remote-tracking ref, …) is
 * returned unchanged.
 */
export const shortBranchName = (ref: RefName): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
