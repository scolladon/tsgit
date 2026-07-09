# Design — `describe` early termination (26.4a)

## Problem

`describe` currently walks **all** history reachable from the target even when the nearest tag sits a few commits
away: `selectNearest` collects candidates and finalises the winner's depth by
exhausting `commitDateWalk`. Canonical git stops early via two traversal breaks
that are **output-inert** — they change only how many commits are read, never
the printed result. ADR-276 implemented the output-affecting logic exhaustively
and deferred the two inert breaks to this item as pure perf work.

Verified against `builtin/describe.c` at git v2.54.0 (identical in v2.55.0, the
locally installed interop peer).

## Git's two breaks (v2.54.0, `builtin/describe.c`)

### Break 1 — collection-loop "last remaining path" (cond 2)

In `describe_commit`'s main loop, after the per-candidate depth bumps and
**before** enqueuing the popped commit's parents:

```c
/* Stop if last remaining path already covered by best candidate(s) */
if (annotated_cnt && lazy_queue_empty(&queue)) {
        unsigned long best_depth = ULONG_MAX;
        unsigned best_within = 0;
        for (cur_match = 0; cur_match < match_cnt; cur_match++) {
                struct possible_tag *t = &all_matches[cur_match];
                if (t->depth < best_depth) {
                        best_depth = t->depth;
                        best_within = t->flag_within;
                } else if (t->depth == best_depth) {
                        best_within |= t->flag_within;
                }
        }
        if ((c->object.flags & best_within) == best_within) {
                if (debug)
                        fprintf(stderr, _("finished search at %s\n"),
                                oid_to_hex(&c->object.oid));
                break;
        }
}
```

Three conditions, all required:

1. at least one **annotated** candidate collected (`annotated_cnt` counts only
   `prio == 2` candidates);
2. the queue is empty at the moment the popped commit has been processed but
   its parents have not been pushed (single remaining path);
3. the popped commit is reachable from **every minimum-depth candidate**
   (`best_within` is the OR of `flag_within` over all candidates tied at the
   minimum depth; the commit's flags must cover all of them).

Breaking here skips `parse_commit` on the remaining ancestry — with a tag near
the tip of a deep history, the walk touches O(distance) commits instead of
O(N).

### Break 2 — winner-finalisation covered-frontier (`finish_depth_computation`)

After the main loop ends (slots full → `gave_up_on`, or natural exhaustion),
git finalises the best candidate's depth by continuing the walk counting only
commits **not** reachable from the winner, and stops as soon as the popped
commit *and every commit still in the queue* are covered by the winner:

```c
static unsigned long finish_depth_computation(struct lazy_queue *queue,
                                              struct possible_tag *best)
{
        unsigned long seen_commits = 0;
        struct oidset unflagged = OIDSET_INIT;

        for (size_t i = queue->get_pending ? 1 : 0; i < queue->queue.nr; i++) {
                struct commit *commit = queue->queue.array[i].data;
                if (!(commit->object.flags & best->flag_within))
                        oidset_insert(&unflagged, &commit->object.oid);
        }

        while (!lazy_queue_empty(queue)) {
                struct commit *c = lazy_queue_get(queue);
                struct commit_list *parents = c->parents;
                seen_commits++;
                if (c->object.flags & best->flag_within) {
                        if (!oidset_size(&unflagged))
                                break;
                } else {
                        oidset_remove(&unflagged, &c->object.oid);
                        best->depth++;
                }
                while (parents) { /* push unseen, propagate flags,
                                     maintain unflagged incrementally */ }
        }
        ...
}
```

The `unflagged` oidset is a v2.5x CPU optimisation; for over a decade git
scanned the pending list directly (`for each queued commit: if not within
best, keep walking`). Both formulations stop at the **same commit**: the break
fires when the popped commit is winner-covered and the frontier contains no
uncovered commit. The observable behaviour (which commits are read from the
object store) is identical; only in-process bookkeeping differs.

## Why both breaks are output-inert (recap of ADR-276)

- Break 1 fires only when every minimum-depth candidate already covers the
  single remaining path: all deeper commits would either bump all minimum-depth
  candidates equally or none, and no candidate below the current minimum can
  appear (depths only grow). The already-collected order statistics are final.
- Break 2 only stops the **winner-only** depth counter once no reachable
  commit can increment it again (everything left is covered by the winner).

Output equivalence is pinned by the existing byte-identical
`describe-interop` suite; this change adds traversal-count pins on top.

## Current tsgit shape

- `commitDateWalk` (`src/application/primitives/internal/commit-date-walk.ts`)
  — internal date-ordered walk: `pop → yield commit → (on resume) enqueue
  parents`. A consumer `break` ends the generator before `enqueueParents`, so
  the parents of the last-popped commit are never read: the same reads git's
  pre-push break saves. `frontierEmpty` sampled after the pop and before the
  yield is exactly git's `lazy_queue_empty(&queue)` at the cond-2 check point.
- `walkCommitsByDate` (Tier-2, public) — thin projection over the core;
  its public shape must not change (ADR-275).
- `selectNearest` (`src/application/commands/describe.ts`) — single walk that
  collects candidates, freezes at `maxCandidates`/`totalNames` into a winner
  (`pickNearest`), then finalises via `finishWinner` (winner-only depth bumps
  + reach propagation) until the walk is exhausted. Reach bookkeeping
  (`reach: Map<ObjectId, Set<number>>`, `propagateReach`) mirrors git's
  per-candidate `flag_within` propagation one-for-one (established by 23.4n).

## Change

### 1. Walk core exposes the frontier (internal only)

`commitDateWalk` yields a step instead of a bare commit:

```ts
export type DateWalkStep = {
  readonly commit: Commit
  /** True when the queue is empty after this pop — git's `!list` at cond 2. */
  readonly frontierEmpty: boolean
  /** Oids currently queued (heap order, order-insensitive use only).
      Valid until the iterator is resumed. */
  readonly frontier: () => ReadonlyArray<ObjectId>
}
```

`frontierEmpty` is `queue.length === 0` sampled between pop and yield.
`frontier()` is a lazy snapshot (`queue.map(entry => oid)`) so the common path
allocates nothing; callers invoke it only when they need the covered-frontier
test. `walkCommitsByDate` projects `.commit` and keeps its public signature —
`repo.log`/blame observe nothing.

### 2. `selectNearest` — cond-2 break (pre-freeze branch)

- Track `annotatedCount`: incremented when a candidate is pushed with
  `named.priority === 2` (mirrors `annotated_cnt`).
- After the existing `incrementUnreached`/`propagateReach` for the popped
  commit, when `annotatedCount > 0 && step.frontierEmpty`: compute the minimum
  candidate depth, and break iff the popped commit's reach set contains the
  index of **every** candidate tied at that minimum (`coveredByAllMinDepth`).
- On break the loop simply ends; the existing
  `winner ?? pickNearest(candidates)` return is already correct (git QSORTs
  and takes `all_matches[0]` with the same depths).

### 3. `selectNearest` — covered-frontier break (post-freeze branch)

After `finishWinner` for a popped commit, when the commit is winner-covered
(`reach.get(oid)?.has(winner.foundOrder)`), scan `step.frontier()`: if every
queued oid's reach set also contains the winner index, break. Early-exit the
scan at the first uncovered oid.

This is git's classic (pre-lazy-queue) formulation. It needs zero mirrored
walker state — coverage comes from the reach map describe already maintains at
the same propagation points git updates flags. The v2.54 incremental
`unflagged` set is a CPU refinement with identical stopping behaviour; adopt it
later only if the bench shows the scan matters (decision candidate 2).

Timing matches git: the check runs before the generator resumes, i.e. before
the popped commit's parents join the queue — the same queue git tests before
its push loop.

### 4. Traversal pins

- **Unit (reads counted):** wrap the memory adapter / commit reader with a
  counting spy; assert exact commit-read counts on crafted DAGs:
  - single chain, annotated tag k commits below tip → walk reads k+1 commits
    then stops (cond 2), not the full chain;
  - cond-2 must NOT fire while any minimum-depth candidate does not cover the
    popped commit (branchy counter-example from ADR-276's `ay-2` scenario);
  - cond-2 must NOT fire when only lightweight candidates exist
    (`annotatedCount === 0`, `--tags` mode) — walk continues;
  - merge topology where the winner covers the popped commit but a side branch
    in the frontier is uncovered → no break; once the frontier is fully
    covered → break (finish-depth pin, exact count).
- **Interop:** existing `describe-interop` byte-identity suite unchanged —
  reruns green (output-inert claim).
- **Differential property (decision candidate 1):** for arbitrary small tagged
  DAGs, `describe` with breaks ≡ exhaustive selection output.
- **Bench:** new `test/bench/describe.bench.ts` — synthetic linear history
  (reuse the `log-scale` fixture pattern), tag near tip; `bench:summary` delta
  is the recorded evidence of O(distance) traversal.

## Non-goals

- No change to candidate selection, freeze, or winner ordering semantics
  (23.4n / ADR-276 territory — already pinned).
- No public API change (`walkCommitsByDate`, `repo.describe` signatures
  untouched; no `api.json` churn).
- No `--debug` stream (rendering is the caller's job, ADR-249; cond-2's
  "finished search at" line is stdout-cosmetic).

## Decision candidates

1. **Differential property test in scope?** A `fast-check` property generating
   small random tagged DAGs and asserting break-enabled output ≡ exhaustive
   output (oracle = the pre-change algorithm, independently pinned by interop)
   would strongly kill wrong-break mutants, at the cost of a commit-DAG
   arbitrary that does not exist yet. Recommended: **yes, in scope** (lens 4 —
   counting/equivalence invariant; the oracle is not a tautology).
2. **Covered-frontier bookkeeping: lazy scan vs incremental set.** Recommended:
   **lazy `frontier()` scan** (git-classic; zero mirrored state). The v2.54
   `unflagged` oidset variant requires mirroring the walker's seen-set or
   widening the step surface further; adopt only on bench evidence.
