/**
 * git's `refs_verify_refname_available` over one ref transaction: a name the
 * transaction creates may not sit under an existing ref or another name of
 * the same transaction, nor above one.
 */
import type { RefName } from '../objects/object-id.js';

/** A created name's collision: a ref at one of its proper prefixes (`above`)
 *  or a ref under it (`below`), named by `blocking`. */
export interface RefNameConflict {
  readonly position: 'above' | 'below';
  readonly blocking: RefName;
}

/** What storage holds around one created name. */
export interface RefNameFacts {
  /** The proper prefixes of the name that exist as refs. */
  readonly existingPrefixes: ReadonlySet<RefName>;
  /** The byte-smallest existing ref under `<name>/`. */
  readonly smallestExistingUnder: RefName | undefined;
}

/** Every name a transaction carries, as a set and in byte order. */
export interface TransactionNames {
  readonly names: ReadonlySet<RefName>;
  readonly sorted: readonly RefName[];
}

const SEPARATOR = '/';

/** Every `/`-bounded proper prefix of `name`, shortest first. */
export const refNamePrefixes = (name: RefName): readonly RefName[] => {
  const prefixes: RefName[] = [];
  for (
    let slash = name.indexOf(SEPARATOR);
    slash !== -1;
    slash = name.indexOf(SEPARATOR, slash + 1)
  ) {
    prefixes.push(name.slice(0, slash) as RefName);
  }
  return prefixes;
};

/** The byte-smallest of `sorted` strictly under `<name>/` — one binary search. */
export const smallestNameUnder = (
  sorted: readonly RefName[],
  name: RefName,
): RefName | undefined => {
  const floor = `${name}${SEPARATOR}`;
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] as RefName) < floor) low = middle + 1;
    else high = middle;
  }
  const candidate = sorted[low];
  return candidate?.startsWith(floor) === true ? candidate : undefined;
};

/** Whether one of `names` is a proper prefix of another. */
export const hasPrefixRelatedNames = (names: ReadonlySet<RefName>): boolean =>
  [...names].some((name) => refNamePrefixes(name).some((prefix) => names.has(prefix)));

export const transactionNamesOf = (names: readonly RefName[]): TransactionNames => {
  const distinct = new Set(names);
  return { names: distinct, sorted: [...distinct].sort((a, b) => (a < b ? -1 : 1)) };
};

/**
 * git's check order for one created name: each proper prefix shortest first
 * (an existing ref, then a transaction name), then the smallest existing ref
 * under it, then the smallest transaction name under it.
 */
export function firstRefNameConflict(
  name: RefName,
  facts: RefNameFacts,
  transaction: TransactionNames,
): RefNameConflict | undefined {
  const above = refNamePrefixes(name).find(
    (prefix) => facts.existingPrefixes.has(prefix) || transaction.names.has(prefix),
  );
  if (above !== undefined) return { position: 'above', blocking: above };
  const below = facts.smallestExistingUnder ?? smallestNameUnder(transaction.sorted, name);
  return below === undefined ? undefined : { position: 'below', blocking: below };
}
