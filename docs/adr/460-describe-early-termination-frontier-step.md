# ADR-460: `describe` early termination via frontier-exposing walk step

## Status

Accepted (2026-07-09)

## Context

ADR-276 implemented `describe`'s candidate selection exhaustively and deferred
git's two output-inert traversal breaks (collection-loop cond 2 and
`finish_depth_computation`'s covered-frontier stop) as pure perf work — this
item. Replicating them requires `selectNearest` to observe the walk frontier,
which the internal `commitDateWalk` core (ADR-275) does not expose. Semantics
verified against `builtin/describe.c` at git v2.54.0 (identical in v2.55.0);
full transcription in `design/describe-early-termination.md`.

## Decision

1. **`commitDateWalk` yields `DateWalkStep`** — `{ commit, frontierEmpty,
   frontier() }` — instead of a bare `Commit`. `frontierEmpty` is sampled
   after the pop and before parents are enqueued (git's `!list` position at
   cond 2); `frontier()` is a lazy snapshot of the queued oids, valid until
   the iterator resumes. `walkCommitsByDate` projects `.commit`, keeping the
   public Tier-2 surface unchanged.
2. **Cond-2 break** in `selectNearest`'s collection branch: break when an
   annotated candidate exists (`named.priority === 2` at push), the frontier
   is empty, and the popped commit's reach set covers every minimum-depth
   candidate — git's three-condition form.
3. **Covered-frontier break** in the winner-finalisation branch uses the
   **lazy frontier scan** (git's classic formulation): on each winner-covered
   popped commit, scan `frontier()` and break when every queued oid is
   winner-covered, early-exiting at the first uncovered one. Git v2.54's
   incremental `unflagged` oidset is a CPU refinement with the same stopping
   point; it would force mirroring the walker's seen-set into `describe`, so
   it is adopted only if the bench ever shows the scan matters.
4. **Differential property test in scope**: a `fast-check` arbitrary over
   small random tagged DAGs asserts break-enabled output ≡ exhaustive
   selection output (oracle = the pre-change algorithm, independently pinned
   by the byte-identical `describe-interop` suite — not a tautology).

## Consequences

- `describe` on a deep history with a nearby tag reads O(distance) commits
  instead of O(N); pinned by exact read-count unit tests and a new
  `test/bench/describe.bench.ts` (`bench:summary` delta).
- Output stays byte-identical — the existing `describe-interop` suite is the
  faithfulness pin (ADR-226); no public API change, no `api.json` churn.
- The internal walk-step shape change touches only `walkCommitsByDate`'s
  projection and `describe`; other walk consumers observe nothing.
- Traversal counts are pinned to tsgit's own freeze semantics (23.4n), which
  enter winner-finalisation one commit earlier than git's `gave_up_on` in the
  slots-full window; commit-read counts there may differ from git's
  `seen_commits` (unobservable — no `--debug` stream, ADR-249) while output
  remains identical.

## Alternatives considered

- **`frontierEmpty` only (no `frontier()`)** — supports cond 2 but not the
  finalisation break; leaves the dominant O(N) finalisation walk in place.
- **Incremental unflagged set (git v2.54 form)** — rejected for now, see
  Decision 3.
- **Break logic inside the walker (callback/predicate option)** — rejected:
  winner-coverage is `describe` domain knowledge; the walker stays a generic
  date-ordered traversal (ADR-275 separation).
