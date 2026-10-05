/**
 * git's `refspec_find_negative_match` for a destination query — whether the
 * remote-tracking ref `ref` is one a remote's negative fetch refspec excludes.
 * The positive refspecs are applied in reverse to recover every source `ref`
 * could stand for, and any of those a negative refspec names rules `ref` out.
 */
import { type RefspecSides, splitSides } from './refspec-grammar.js';

const STAR = '*';

/**
 * git's `match_refname_with_pattern`: `name` matched against the one-`*`
 * pattern `key`, with what the `*` captured substituted into `value`.
 */
export const expandPattern = (key: string, name: string, value: string): string | undefined => {
  const star = key.indexOf(STAR);
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  const fits = name.length >= prefix.length + suffix.length;
  if (!fits || !name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const captured = name.slice(prefix.length, name.length - suffix.length);
  return value.replace(STAR, captured);
};

/**
 * The source one positive refspec maps `ref` back to. A non-pattern spec is
 * compared on its SOURCE, as git's own loop compares it; the matching `:` spec
 * stands for any ref.
 */
const reversedSource = (sides: RefspecSides, ref: string): string | undefined => {
  const { src, dst } = sides;
  if (src.includes(STAR)) return expandPattern(dst ?? src, ref, src);
  if (src === '' && dst === '') return ref;
  return ref === src ? src : undefined;
};

const matchesNegative = (name: string, negative: RefspecSides): boolean =>
  negative.src.includes(STAR)
    ? expandPattern(negative.src, name, negative.src) !== undefined
    : name === negative.src;

/** Whether a negative refspec among `specs` excludes the tracking ref `ref`. */
export const isExcludedByNegativeRefspec = (specs: ReadonlyArray<string>, ref: string): boolean => {
  const sides = specs.map(splitSides);
  const negatives = sides.filter((side) => side.negative);
  return sides
    .filter((side) => !side.negative)
    .map((side) => reversedSource(side, ref))
    .some(
      (source) =>
        source !== undefined && negatives.some((negative) => matchesNegative(source, negative)),
    );
};
