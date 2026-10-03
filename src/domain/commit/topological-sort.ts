import type { ObjectId } from '../objects/index.js';
import { BinaryHeap } from './binary-heap.js';
import { precedesByArrival } from './priority-queue.js';

/**
 * git's `rev_sort_order` under `topo_order`: `'graph'` is `--topo-order`
 * (each line of history shown whole), `'commit-date'` is `--date-order` and
 * `'author-date'` is `--author-date-order` (newest first among the commits
 * whose children have all been shown).
 */
export type TopoSortOrder = 'graph' | 'commit-date' | 'author-date';

/** The slice of a `Commit` the sort reads. */
export interface TopoSortable {
  readonly id: ObjectId;
  readonly data: {
    readonly parents: ReadonlyArray<ObjectId>;
    readonly author: { readonly timestamp: number };
    readonly committer: { readonly timestamp: number };
  };
}

interface TopoQueue<T> {
  readonly put: (commit: T) => void;
  readonly get: () => T | undefined;
}

/**
 * git's `sort_in_topological_order`: a commit shows only once every child in
 * `commits` has. Parents outside `commits` are ignored; the tips start in the
 * order given.
 */
export const sortInTopologicalOrder = <T extends TopoSortable>(
  commits: ReadonlyArray<T>,
  order: TopoSortOrder,
): T[] => {
  const pending = pendingChildrenOf(commits);
  const tips = [...pending.values()].filter((entry) => entry.children === 0);
  const queue = queueFor(
    order,
    tips.map((entry) => entry.commit),
  );
  const sorted: T[] = [];
  for (let commit = queue.get(); commit !== undefined; commit = queue.get()) {
    sorted.push(commit);
    releaseParents(commit, pending, queue);
  }
  return sorted;
};

/** A listed commit and how many of its listed children are still to show, git's in-degree slab. */
interface Pending<T> {
  readonly commit: T;
  children: number;
}

const pendingChildrenOf = <T extends TopoSortable>(
  commits: ReadonlyArray<T>,
): Map<ObjectId, Pending<T>> => {
  const pending = new Map<ObjectId, Pending<T>>(
    commits.map((commit) => [commit.id, { commit, children: 0 }]),
  );
  for (const commit of commits) {
    for (const parent of commit.data.parents) {
      const entry = pending.get(parent);
      if (entry !== undefined) entry.children += 1;
    }
  }
  return pending;
};

const releaseParents = <T extends TopoSortable>(
  commit: T,
  pending: ReadonlyMap<ObjectId, Pending<T>>,
  queue: TopoQueue<T>,
): void => {
  for (const parent of commit.data.parents) {
    const entry = pending.get(parent);
    if (entry === undefined) continue;
    entry.children -= 1;
    if (entry.children === 0) queue.put(entry.commit);
  }
};

const queueFor = <T extends TopoSortable>(
  order: TopoSortOrder,
  tips: ReadonlyArray<T>,
): TopoQueue<T> => {
  if (order === 'graph') return stackOf(tips);
  return order === 'commit-date'
    ? dateQueueOf(tips, (commit) => commit.data.committer.timestamp)
    : dateQueueOf(tips, (commit) => commit.data.author.timestamp);
};

/** git's comparator-less `prio_queue` is a stack; reversing the tips shows them in list order. */
const stackOf = <T>(tips: ReadonlyArray<T>): TopoQueue<T> => {
  const stack = [...tips].reverse();
  return {
    put: (commit) => {
      stack.push(commit);
    },
    get: () => stack.pop(),
  };
};

interface Dated<T> {
  readonly date: number;
  readonly arrival: number;
  readonly commit: T;
}

const dateQueueOf = <T>(tips: ReadonlyArray<T>, dateOf: (commit: T) => number): TopoQueue<T> => {
  const heap = new BinaryHeap<Dated<T>>(precedesByArrival);
  let arrivals = 0;
  const put = (commit: T): void => {
    heap.push({ date: dateOf(commit), arrival: arrivals, commit });
    arrivals += 1;
  };
  for (const tip of tips) put(tip);
  return { put, get: () => heap.pop()?.commit };
};
