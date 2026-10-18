import { compareBytes, decodeEscapingInvalid, encode } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import {
  type CacheTreePlan,
  cacheTreeNodesOf,
  compareSubtreeNames,
  type PlannedNode,
} from './cache-tree-update.js';
import type { CacheTreeEntry } from './index-entry.js';

const ROOT = 0;
const SLASH = 0x2f;

type Ids = ReadonlyArray<ObjectId | undefined>;

/** Earlier oids whose object is not stored. */
export type AbsentIds = ReadonlySet<ObjectId>;

/** git's update_one returns -1 for a subtree it cannot store when it has no stored earlier oid to fall back on. */
const cannotBeRepaired = (
  plan: CacheTreePlan,
  ids: Ids,
  absent: AbsentIds,
  node: number,
): boolean => {
  if (ids[node] !== undefined) return false;
  const previous = (plan.nodes[node] as PlannedNode).previousId;
  return previous === undefined || absent.has(previous);
};

/** The nodes whose update_one returns -1: a child does, or a child is unrepairable. */
export const abortedNodes = (
  plan: CacheTreePlan,
  ids: Ids,
  absent: AbsentIds,
): ReadonlySet<number> => {
  const aborted = new Set<number>();
  for (const build of plan.builds) {
    if (
      build.subtrees.some(
        (child) => aborted.has(child) || cannotBeRepaired(plan, ids, absent, child),
      )
    ) {
      aborted.add(build.node);
    }
  }
  return aborted;
};

const slashed = (name: Uint8Array): Uint8Array => {
  const out = new Uint8Array(name.length + 1);
  out.set(name);
  out[name.length] = SLASH;
  return out;
};

/** The order in which git meets the directories: index order, where a name is followed by its slash. */
const inIndexOrder = (plan: CacheTreePlan, children: ReadonlyArray<number>): number[] =>
  [...children].sort((a, b) =>
    compareBytes(
      slashed((plan.nodes[a] as PlannedNode).nameBytes),
      slashed((plan.nodes[b] as PlannedNode).nameBytes),
    ),
  );

const nameOf = (entry: CacheTreeEntry): Uint8Array => entry.nameBytes ?? encode(entry.path);

const keyOf = (name: Uint8Array): string => decodeEscapingInvalid(name);

/** The directories git reaches before the first unrepairable one, by name. */
const visitedBy = (
  plan: CacheTreePlan,
  aborted: ReadonlySet<number>,
  index: number,
): Map<string, number> => {
  const ordered = inIndexOrder(plan, (plan.nodes[index] as PlannedNode).children);
  const cut = ordered.findIndex((child) => aborted.has(child));
  return new Map(
    ordered
      .slice(0, cut + 1)
      .map((child) => [keyOf((plan.nodes[child] as PlannedNode).nameBytes), child]),
  );
};

/** An aborted node returns before it sets its count and oid, so it keeps the ones it carried in. */
const carriedState = (
  node: CacheTreeEntry,
  previous: CacheTreeEntry | undefined,
): CacheTreeEntry => ({
  ...node,
  entryCount: previous?.entryCount ?? -1,
  ...(previous?.id === undefined ? {} : { id: previous.id }),
});

/**
 * git stops at the first unrepairable directory: the ones before it are repaired, the ones
 * after it keep their carried state, and carried directories the index no longer has stay.
 * A directory that only fails its entry pass has visited every child and dropped the unused ones.
 */
export const toRepairedCacheTree = (
  plan: CacheTreePlan,
  ids: Ids,
  carried: CacheTreeEntry | undefined,
  absent: AbsentIds,
): CacheTreeEntry => {
  const aborted = abortedNodes(plan, ids, absent);
  const nodes = cacheTreeNodesOf(plan, ids);

  const stoppedAtChild = (index: number): boolean =>
    (plan.nodes[index] as PlannedNode).children.some((child) => aborted.has(child));

  const settled = (index: number, previous: CacheTreeEntry | undefined): CacheTreeEntry => {
    if (!aborted.has(index)) return nodes[index] as CacheTreeEntry;
    if (!stoppedAtChild(index)) return carriedState(nodes[index] as CacheTreeEntry, previous);
    const visited = visitedBy(plan, aborted, index);
    const kept = (previous?.children ?? []).map((old) => {
      const child = visited.get(keyOf(nameOf(old)));
      visited.delete(keyOf(nameOf(old)));
      return child === undefined ? old : settled(child, old);
    });
    const added = [...visited.values()].map((child) => settled(child, undefined));
    const children = [...kept, ...added].sort((a, b) => compareSubtreeNames(nameOf(a), nameOf(b)));
    return carriedState(
      { ...(nodes[index] as CacheTreeEntry), subtreeCount: children.length, children },
      previous,
    );
  };

  return settled(ROOT, carried);
};
