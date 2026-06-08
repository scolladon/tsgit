# ADR-276: `describe` reproduces git's early-termination for output, not traversal

## Status

Accepted

## Context

Backlog **23.4n**: the default `git describe` candidate pick is byte-faithful
only at `--candidates=1`; the default/high-budget pick diverges. On a merge where
a newer-dated tag is structurally *farther* than an older, nearer tag, canonical
`git describe` reports the *farther, first-met* tag, while tsgit reports the
*exhaustively-nearest* one.

The cause (git 2.54.0 `builtin/describe.c`): git's date-ordered scoreboard walk
**stops collecting** the moment every candidate slot — or every name — is taken
(`gave_up_on`), sorts the candidates on their **frozen, partial depths**
(`compare_pt`: depth asc, then found-order asc), picks the winner, and only then
finalises **the winner's** depth (`finish_depth_computation`). tsgit instead
walks the entire reachable set, fully increments **every** candidate's depth, and
sorts on exhaustive depths — so it keeps the nearest tag where git keeps the
first-met one.

git has a **second** early break in the main loop — `annotated_cnt &&
queue_empty && (current commit reachable from every minimum-depth candidate)`
("finished search at …", call it **cond 2**). It serves two roles:

1. **Output**: none. Any tag cond 2 skips is an ancestor of the current commit,
   hence farther than every nearest candidate — it can never become the winner;
   and the winner (a nearest candidate) already reaches that commit and all its
   ancestors, so walking them would advance the winner's depth by zero. The
   winner's identity and finalised depth are identical whether cond 2 fires or the
   walk runs to its natural end. (Empirically confirmed: a "tag behind a
   convergence" repo makes real git fire cond 2 and report `ay-2`; tsgit, walking
   the full set and even collecting the skipped tag, also reports `ay-2`.)
2. **Performance**: it is git's early-termination engine. For a shallow tag in a
   deep history, cond 2 lets git stop after ≈`O(distance)` commits instead of
   walking all of history.

Reproducing cond 2 requires the shared `commitDateWalk` core (ADR-275) to expose
frontier-emptiness (queue empty at a pop, before parent expansion) — a signal no
other consumer needs. The decision is therefore: which of git's two roles for
cond 2 do we reproduce in this item, and at what architectural cost.

Three options were weighed with the user:

- **A — re-port the stop + winner-only finalisation, omit cond 2.** Confined to
  `describe.ts`'s `selectNearest`; the shared core and `walkCommitsByDate` /
  `reports/api.json` are untouched. Output byte-faithful. Traversal cost = today's
  (full reachable set) — no regression, but the perf gap vs git stays.
- **B — additionally port cond 2**, enriching the core to yield
  `{ commit, frontierEmpty }` (with `walkCommitsByDate` projecting it away).
  Output identical to A, plus partial perf recovery (the cond-2 cases). Widens the
  core's internal contract for a single internal consumer and adds a guard that
  must be byte-exact to stay faithful. Full git-parity perf (the branchy
  `gave_up` case) would further need git's queue-aware `finish_depth` break —
  bigger still.
- **C — revert `describe` to a bespoke queue walk** mirroring `describe_commit`
  line-by-line. Maximal literalism; undoes ADR-275's single-walk consolidation.

## Decision

Adopt **Option A**. `describe` reproduces git's early-termination for its
**observable output**, not its traversal:

- In `selectNearest`, stop collecting candidates at git's `gave_up` point
  (`candidates.length === maxCandidates || candidates.length === totalNames`,
  with `totalNames = nameMap.size` ≡ git's `hashmap_get_size(&names)`), sort on
  the **frozen** partial depths (`compareCandidates`), pick the winner, and
  finalise **only the winner's** depth by continuing the walk.
- **Omit cond 2.** Under ADR-226 this is *not* a faithfulness divergence:
  ADR-226 binds **observable** behaviour, and cond 2 has none. tsgit emits no
  `--debug` stream (ADR-249), the one place git's cond 2 is visible.
- Keep ADR-275 intact: `describe` still consumes the shared `commitDateWalk`; the
  core, `walkCommitsByDate`, `WalkCommitsByDateOptions`, and `reports/api.json`
  are unchanged.
- The convergence scenario where git fires cond 2 is pinned in `describe-interop`
  so any future change that *does* alter the output is caught.

The **performance** half of cond 2 (Option B — early-termination so `describe`
stops after `O(distance)` rather than walking all reachable history) is deferred
to the Phase 26 performance pass as **26.4a**, scoped to the `describe` command.
It is a measured optimisation that belongs with the profiling-driven hot-path
work, not bundled into a correctness fix.

## Consequences

### Positive

- Default / high-budget `describe` is byte-faithful to `git describe` on merges
  with date/distance inversion — closes 23.4n.
- Smallest blast radius and smallest correctness surface: one function in
  `describe.ts`; correct by construction (walk-everything-then-freeze), no
  byte-exact cond-2 guard to get wrong.
- ADR-275's single date-walk consolidation stays pristine; `api.json` unchanged;
  no public or internal-core surface moves.

### Negative

- `describe` keeps today's traversal cost (the full reachable set) — no
  regression, but the perf gap vs git's early termination remains until 26.4a.

### Neutral

- cond 2's omission is invisible to consumers (output identical; no debug stream).
  The deferred perf work is recorded as 26.4a (Option B), with this ADR as its
  design reference.
- The winner's reported distance can exceed its frozen depth (the
  `finish_depth_computation` lift) and can exceed a non-winner candidate's frozen
  depth — git's documented, non-globally-optimal heuristic, now reproduced.
