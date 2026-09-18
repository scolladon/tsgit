/**
 * The names a ref transaction has already taken, indexed by the question git's
 * prepare pass asks at every name it locks: has the run already taken a name
 * UNDER this one? A name sits under `name` exactly when `name` is one of its
 * slash-bounded prefixes, so recording each taken name's prefixes answers by
 * lookup — O(depth) — instead of by re-scanning every name taken so far.
 */
import type { RefName } from '../objects/object-id.js';
import { refNamePrefixes } from './ref-name-conflict.js';

export interface TakenNameIndex {
  /** Record `name` as taken by the run. */
  readonly take: (name: RefName) => void;
  /** Whether a name already taken sits STRICTLY under `name`. A name does not
   *  sit under itself, and one merely sharing a textual prefix does not sit
   *  under it either — the split is at a slash. */
  readonly holdsUnder: (name: RefName) => boolean;
}

export const takenNameIndex = (): TakenNameIndex => {
  const prefixes = new Set<RefName>();
  return {
    take: (name) => {
      for (const prefix of refNamePrefixes(name)) prefixes.add(prefix);
    },
    holdsUnder: (name) => prefixes.has(name),
  };
};
