import { BinaryHeap } from '../../../domain/commit/binary-heap.js';
import { precedesByArrival, type QueueEntry } from '../../../domain/commit/priority-queue.js';
import { operationAborted } from '../../../domain/error.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { asIdSet } from './as-id-set.js';
import { type BoundedReader, createBoundedReader } from './bounded-reader.js';
import { limitFor } from './concurrency.js';
import { readCommit } from './read-commit.js';
import { commitHeader } from './read-commit-graph.js';
import { resolveShallow } from './shallow-set.js';

type CommitBodies = BoundedReader<Commit | undefined>;
type HeapEntry = QueueEntry<Promise<Commit | undefined>> & { readonly arrival: number };

/**
 * One walk step: the popped commit plus the frontier state sampled after the
 * pop and before its parents are enqueued (git describe cond-2 check point).
 */
export type DateWalkStep = {
  readonly commit: Commit;
  readonly frontierEmpty: boolean;
  /** Lazy snapshot of the queued oids; valid until the iterator resumes. */
  readonly frontier: () => ReadonlyArray<ObjectId>;
};

/** Parents this walk follows: the first parent only, or all of them. */
export const selectParents = (commit: Commit, firstParent: boolean): ReadonlyArray<ObjectId> =>
  firstParent ? commit.data.parents.slice(0, 1) : commit.data.parents;

export interface CommitDateWalkOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId> | ReadonlySet<ObjectId>;
  /**
   * Boundary override. Omitted ⇒ the repository's `.git/shallow` set is
   * loaded automatically (once per `Context`); supplied — including an
   * explicit empty `Set` — ⇒ the caller's set governs which commits are
   * masked. A boundary commit is still yielded with `parents: []`; only its
   * parents are skipped.
   */
  readonly shallow?: ReadonlySet<ObjectId>;
  /** Follow only the first parent through merges (git's `--first-parent`). */
  readonly firstParent?: boolean;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
  /**
   * When a popped commit's parents are read. `'before-yield'` (default) is
   * git's revision walk — `process_parents` runs before the commit is shown,
   * so an unreadable parent refuses before its child is yielded.
   * `'after-yield'` is git describe's loop, which checks its stop conditions
   * before parsing any parent.
   */
  readonly parentReads?: ParentReads;
}

export type ParentReads = 'before-yield' | 'after-yield';

/** Mutable state threaded through the date-ordered walk. */
interface DateWalk {
  readonly heap: BinaryHeap<HeapEntry>;
  /** Next arrival ticket; advanced in place, once per resolved candidate. */
  arrivals: number;
  readonly seen: Set<ObjectId>;
  readonly until: ReadonlySet<ObjectId>;
  readonly firstParent: boolean;
  readonly bodies: CommitBodies;
  readonly ignoreMissing: boolean;
  readonly parentReads: ParentReads;
}

/**
 * The shared date-priority commit traversal: walk every commit reachable from
 * `from` (across all parents, or first-parent only) in commit-date priority
 * order — newest committer date first, first-enqueued on ties (git's
 * `prio_queue` insertion counter). A commit's date is sourced from the
 * commit-graph when available (no I/O beyond the first parse), which lets its
 * heap entry — and its parents' — get pushed without waiting on a full object
 * read; the read itself is deferred to a bounded, deduped prefetcher and
 * awaited only when the entry is popped. Commits absent from the graph fall
 * back to reading eagerly, exactly as before.
 *
 * A `seen` set guards enqueue, so each reachable commit is read and yielded at
 * most once and the frontier is bounded by the reachable-commit count. `until`
 * excludes commits before they are read; `shallow` boundaries are yielded but
 * their parents are not walked; `ignoreMissing` / `verifyHash` thread into the
 * shared commit reader; an aborted signal throws at the next loop head.
 *
 * Seeds are assumed already resolved and within bounds — the public
 * `walkCommitsByDate` wrapper owns the `INVALID_WALK_INPUT` seed contract.
 *
 * The walk is lazy (parents discovered on pop), so it matches
 * `git rev-list --date-order` for histories whose committer dates strictly
 * decrease along parent edges. Equal dates pop in enqueue order, which is
 * plain `git rev-list` / `git log` order; `--date-order` would also hold an
 * equal-date parent back until all its children are shown. It does not
 * enforce git's strict all-children-before-parent rule for forged reverse-causal
 * dates, trading that edge case for streaming composition.
 */
export async function* commitDateWalk(
  ctx: Context,
  options: CommitDateWalkOptions,
): AsyncIterable<DateWalkStep> {
  const shallow = await resolveShallow(ctx, options.shallow);
  const verifyHash = options.verifyHash ?? false;
  const ignoreMissing = options.ignoreMissing ?? false;
  // `seen` already prevents any re-read, so the reader's missing-memo is inert
  // here; it satisfies the shared contract without a second set.
  const missing = new Set<string>();
  const bound = limitFor(ctx, 'ioBound');
  const walk: DateWalk = {
    heap: new BinaryHeap<HeapEntry>(precedesByArrival),
    arrivals: 0,
    seen: new Set<ObjectId>(options.from),
    until: asIdSet(options.until),
    firstParent: options.firstParent ?? false,
    bodies: createBoundedReader(bound, (id) =>
      readCommit(ctx, id, { verifyHash, ignoreMissing, missing, shallow }),
    ),
    ignoreMissing,
    parentReads: options.parentReads ?? 'before-yield',
  };
  // One closure per walk, not per pop: `entries()` reads `walk.heap` live, so
  // every step's snapshot is still valid "until the iterator resumes" — the
  // contract `frontier` documents above.
  const frontier = (): ReadonlyArray<ObjectId> => walk.heap.entries().map((entry) => entry.oid);

  await enqueueSeeds(ctx, walk);

  while (walk.heap.size() > 0) {
    if (ctx.signal?.aborted) throw operationAborted();
    const { oid, value: bodyPromise } = walk.heap.pop() as HeapEntry;
    const commit = await bodyPromise;
    // Consumed: drop the memo entry (`seen` already blocks re-enqueue), or a
    // full-history drain retains every body simultaneously.
    walk.bodies.forget(oid);
    if (commit === undefined) continue;
    // Read early or late per `parentReads`, but always pushed after the yield
    // so the yielded frontier is the one sampled before any parent enqueues.
    const early =
      walk.parentReads === 'before-yield' ? await parentsOf(ctx, walk, commit, shallow) : undefined;
    yield {
      commit,
      frontierEmpty: walk.heap.size() === 0,
      frontier,
    };
    const parents = early ?? (await parentsOf(ctx, walk, commit, shallow));
    for (const entry of parents) walk.heap.push(entry);
  }
}

// Iterate the deduped `seen` set, not raw `from`, so a duplicate seed enqueues
// once — the pop loop has no visited check by design.
const enqueueSeeds = async (ctx: Context, walk: DateWalk): Promise<void> => {
  for (const seed of walk.seen) {
    if (walk.until.has(seed)) continue;
    await enqueueCommit(ctx, walk, seed);
  }
};

const NO_ENTRIES: ReadonlyArray<HeapEntry> = [];

/** A shallow boundary is yielded, but its parents are not walked. */
const parentsOf = (
  ctx: Context,
  walk: DateWalk,
  commit: Commit,
  shallow: ReadonlySet<ObjectId>,
): Promise<ReadonlyArray<HeapEntry>> =>
  shallow.has(commit.id) ? Promise.resolve(NO_ENTRIES) : resolveParents(ctx, walk, commit);

/**
 * Every selected parent is resolved concurrently (each one's date comes from
 * the commit-graph, with no body await, or from its own body), and handed
 * back in parent-array order, not completion order. `entries()` returns the
 * heap's backing array by reference, so sibling push order becomes observable
 * frontier order; a naive "push as each resolves" fan-out would leak
 * completion timing into it. Rejections likewise rethrow in array order, not
 * first-in-time — `Promise.allSettled` already waited for every read.
 */
const resolveParents = async (
  ctx: Context,
  walk: DateWalk,
  commit: Commit,
): Promise<ReadonlyArray<HeapEntry>> => {
  const parents = selectParents(commit, walk.firstParent).filter((parent) => {
    if (walk.seen.has(parent) || walk.until.has(parent)) return false;
    walk.seen.add(parent);
    return true;
  });
  if (parents.length === 0) return NO_ENTRIES;
  // A single parent needs no fan-out, and its rejection rethrows unwrapped.
  if (parents.length === 1) return asEntries(await resolveHeapEntry(ctx, walk, parents[0]!));
  const settled = await Promise.allSettled(
    parents.map((parent) => resolveHeapEntry(ctx, walk, parent)),
  );
  const entries: HeapEntry[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') throw result.reason;
    if (result.value !== undefined) entries.push(result.value);
  }
  return entries;
};

const asEntries = (entry: HeapEntry | undefined): ReadonlyArray<HeapEntry> =>
  entry === undefined ? NO_ENTRIES : [entry];

const enqueueCommit = async (ctx: Context, walk: DateWalk, id: ObjectId): Promise<void> => {
  const entry = await resolveHeapEntry(ctx, walk, id);
  if (entry !== undefined) {
    walk.heap.push(entry);
  }
};

const resolveHeapEntry = async (
  ctx: Context,
  walk: DateWalk,
  id: ObjectId,
): Promise<HeapEntry | undefined> => {
  // Ticketed before any await: callers resolve candidates in git's push order
  // (seeds as given, parents in parent order), so the ticket is that order
  // whatever the reads' completion timing. A dropped candidate's gap is inert.
  const arrival = walk.arrivals;
  walk.arrivals += 1;
  const header = await commitHeader(ctx, id);
  const bodyPromise = walk.bodies.start(id);
  if (header !== undefined && !walk.ignoreMissing) {
    // Graph-confirmed: the date is known without awaiting the body, so
    // resolving (and any downstream enqueue it enables) does not wait on
    // I/O. (A missing body without `ignoreMissing` rejects at pop and aborts
    // the walk, so resolving early is unobservable.)
    return { oid: id, date: header.committerDate, arrival, value: bodyPromise };
  }
  // Graph-absent fallback — and, under `ignoreMissing`, the stale-graph
  // guard: a commit whose body is gone must never enter the heap (it would
  // leak into `frontierEmpty`/`frontier()` snapshots the old walk never saw).
  const commit = await bodyPromise;
  if (commit === undefined) return undefined;
  const date = header?.committerDate ?? commit.data.committer.timestamp;
  return { oid: id, date, arrival, value: bodyPromise };
};
