/**
 * git's `remote_find_tracking` for a source query: the ref a remote's fetch
 * refspecs map a remote ref onto, the way push names the tracking ref it
 * updates and a forced lease names the value it expects — and
 * `refspec_find_all_matches` for a destination query, the remote refs a local
 * ref tracks, the way fetch's prune judges it stale.
 */
import type { RefName } from '../../../domain/objects/index.js';
import { expandPattern, isExcludedByNegativeRefspec } from './negative-refspec.js';
import { type RefspecSides, splitSides } from './refspec-grammar.js';

const STAR = '*';

// A negative refspec carries no destination, so it maps nothing here.
const mapSource = ({ src, dst }: RefspecSides, ref: string): string | undefined => {
  if (dst === undefined) return undefined;
  if (src.includes(STAR)) return expandPattern(src, ref, dst);
  return ref === src ? dst : undefined;
};

/**
 * The destination of the earliest positive refspec mapping `ref` — none when a
 * negative refspec rules it out, which git judges with the query reversed
 * through every positive refspec, as for a destination query.
 */
export const findTrackingRef = (specs: ReadonlyArray<string>, ref: string): RefName | undefined => {
  if (isExcludedByNegativeRefspec(specs, ref)) return undefined;
  for (const sides of specs.map(splitSides)) {
    const mapped = mapSource(sides, ref);
    if (mapped !== undefined) return mapped as RefName;
  }
  return undefined;
};

const mapDestination = ({ src, dst }: RefspecSides, ref: string): string | undefined => {
  if (dst === undefined) return undefined;
  if (src.includes(STAR)) return expandPattern(dst, ref, src);
  return ref === dst ? src : undefined;
};

/** Every remote ref the positive refspecs map onto the local ref `ref`, in refspec order. */
export const findTrackedSources = (
  specs: ReadonlyArray<string>,
  ref: string,
): ReadonlyArray<string> => {
  if (isExcludedByNegativeRefspec(specs, ref)) return [];
  return specs.map(splitSides).flatMap((sides) => mapDestination(sides, ref) ?? []);
};
