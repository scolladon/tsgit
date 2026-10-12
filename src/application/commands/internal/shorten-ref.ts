/**
 * git's `refs_shorten_unambiguous_ref` (non-strict): the shortest spelling of a
 * full ref that no more-preferred revision-parse rule also resolves.
 */
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { refResolvesForReading } from '../../primitives/resolve-ref.js';

/** `ref_rev_parse_rules` past the verbatim one, as prefix and suffix, in rule order. */
const SHORTEN_RULES: ReadonlyArray<readonly [prefix: string, suffix: string]> = [
  ['refs/', ''],
  ['refs/tags/', ''],
  ['refs/heads/', ''],
  ['refs/remotes/', ''],
  ['refs/remotes/', '/HEAD'],
];

const VERBATIM_RULES = 1;

/** Each rule with the count of rules preferred over it, most specific first. */
const RANKED_RULES = SHORTEN_RULES.map(
  (rule, at) => [rule, at + VERBATIM_RULES] as const,
).reverse();

const strip = (ref: string, [prefix, suffix]: readonly [string, string]): string | undefined => {
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return undefined;
  const short = ref.slice(prefix.length, ref.length - suffix.length);
  return short === '' ? undefined : short;
};

/** Whether one of the `preferred` rules ahead of the match also resolves `short`. */
const shadowed = async (ctx: Context, short: string, preferred: number): Promise<boolean> => {
  for (const candidate of refCandidates(short).slice(0, preferred)) {
    if (await refResolvesForReading(ctx, candidate)) return true;
  }
  return false;
};

/** `ref` spelt by the most specific rule nothing more preferred shadows; whole when none. */
export const shortenUnambiguousRef = async (ctx: Context, ref: string): Promise<string> => {
  for (const [rule, preferred] of RANKED_RULES) {
    const short = strip(ref, rule);
    if (short !== undefined && !(await shadowed(ctx, short, preferred))) return short;
  }
  return ref;
};
