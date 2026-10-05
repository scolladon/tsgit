/**
 * git's `get_ref_map` for a fetch with no command-line refspec: each of the
 * remote's fetch refspecs in turn maps the advertised refs onto the local refs
 * they update, the tags follow when any refspec stores into a ref, a negative
 * refspec drops the remote refs it names, and a local ref mapped twice keeps
 * its first source.
 */
import type { AdvertisedRef } from '../../../domain/protocol/index.js';
import { TAGS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import { expandPattern, matchesNegativeRefspec } from './negative-refspec.js';
import { type RefspecSides, splitSides } from './refspec-grammar.js';

export interface MappedRef {
  readonly source: AdvertisedRef;
  /** The local ref the source updates, not yet checked for a valid name. */
  readonly target: string;
}

const STAR = '*';
const PEELED_MARK = '^';

/** git's `get_fetch_map` for one refspec; an empty destination stores into no ref. */
const mapBySpec = (
  { src, dst }: RefspecSides,
  refs: ReadonlyArray<AdvertisedRef>,
): ReadonlyArray<MappedRef> => {
  if (dst === undefined || dst === '') return [];
  if (!src.includes(STAR)) {
    const exact = refs.find((ref) => ref.name === src);
    return exact === undefined ? [] : [{ source: exact, target: dst }];
  }
  return refs
    .filter((ref) => !ref.name.includes(PEELED_MARK))
    .flatMap((source) => {
      const target = expandPattern(src, source.name, dst);
      return target === undefined ? [] : [{ source, target }];
    });
};

const storesIntoRef = ({ dst }: RefspecSides): boolean => dst !== undefined && dst !== '';

const tagRefs = (refs: ReadonlyArray<AdvertisedRef>): ReadonlyArray<MappedRef> =>
  refs
    .filter((ref) => ref.name.startsWith(TAGS_PREFIX) && !ref.name.includes(PEELED_MARK))
    .map((source) => ({ source, target: source.name }));

const firstPerTarget = (mapped: ReadonlyArray<MappedRef>): ReadonlyArray<MappedRef> => {
  const seen = new Set<string>();
  return mapped.filter((entry) => {
    if (seen.has(entry.target)) return false;
    seen.add(entry.target);
    return true;
  });
};

export const mapFetchedRefs = (
  specs: ReadonlyArray<string>,
  refs: ReadonlyArray<AdvertisedRef>,
): ReadonlyArray<MappedRef> => {
  const sides = specs.map(splitSides);
  const mapped = sides.flatMap((side) => mapBySpec(side, refs));
  const followed = sides.some(storesIntoRef) ? [...mapped, ...tagRefs(refs)] : mapped;
  return firstPerTarget(
    followed.filter((entry) => !matchesNegativeRefspec(specs, entry.source.name)),
  );
};
