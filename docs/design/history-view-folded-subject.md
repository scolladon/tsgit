# Design — history/commit view + folded subject

## Goal

A read-model **foundation** pass, surfaced by the 23.4 API review (findings
**E1** + **M2**). It lands two faithful, composable read primitives the
remaining Phase-23 inspection commands (shortlog, range-diff, whatchanged,
name-rev) build on:

1. **An all-parents, commit-date-ordered commit walk.** Today the only
   date-ordered ancestry walk in the codebase is buried inside `describe`
   (entangled with tag-candidate bookkeeping), and the general-purpose
   `walkCommits` primitive offers only a topological FIFO and a first-parent
   FIFO — there is no way to ask the read model for "every reachable commit,
   newest commit-date first." A converged `log` and every `shortlog`-class
   consumer needs exactly that.

2. **`foldSubject` — git's `%s` / `format_subject` port.** The codebase has
   `subjectLine` (the literal first line) and `stripspace` (whole-message
   cleanup), but **not** git's *folded subject*: the leading paragraph collapsed
   to a single space-joined line. `git log --format=%s`, `shortlog`, and
   `oneline` all key off this projection; without it every history summary would
   hand-roll the fold.

This is **purely additive** — no existing behaviour, SHA, ref, reflog, on-disk
state, refusal, or porcelain output changes. No new Tier-1 command ships here;
the read-model **convergence** of the porcelain reads (`log` projecting over the
new walk) is the capstone **23.4j**, explicitly sequenced last and gated on the
over-design caution. 23.4b only strengthens the Core those projections will sit
on.

## Faithfulness anchors (git source)

### `%s` — `format_subject` (`pretty.c`)

git computes `%s` by walking the message line-by-line from its start:

- each line's length is taken **including** its `\n`;
- `is_blank_line` then strips trailing `isspace` bytes (ASCII space, `\t`, `\n`,
  `\v`, `\f`, `\r`) and reports whether the remainder is empty;
- the **first blank line ends the subject** — everything after it is the body;
- non-blank lines are appended, joined by a single **space** (`%s`'s line
  separator), with each line's *trailing* whitespace removed but its *leading*
  whitespace preserved.

So a two-line subject `"Fix the bug\nin the parser"` folds to
`"Fix the bug in the parser"`; a leading blank line yields the empty subject;
internal blank lines never appear because the walk stops at the first one.

`is_blank_line`'s byte class is **ASCII-only** (C-locale `isspace`) — the same
reason `stripspace` must not lean on JS `String.trim()` (Unicode-aware). U+00A0
is content, not whitespace.

### Date order — `compare_commits_by_commit_date` (`commit.c`)

git's default `git log` and `git rev-list` order the frontier by **committer
timestamp, newest first**, via a priority queue (`prio_queue`). On *equal*
timestamps git's heap order is unspecified (structure-/insertion-dependent and
version-sensitive), so it is **not** a faithfulness anchor — a deterministic
library must pick its own total order. We reuse the repo's existing
`domain/commit/priority-queue.ts` comparator (`precedes`: commit-date desc,
oid-asc tie-break), already the date-order primitive for `describe`, `blame`,
and `merge-base` (ADR-259). The faithfulness golden (below) therefore uses
**strictly-decreasing** commit dates so the ordering is unambiguous and matches
`git rev-list --date-order`; the deterministic tie-break is pinned by a
unit test, not by git parity.

**Lazy scope (ADR-261).** The walk is **lazy** — it discovers a commit's parents
only on pop, so a parent enters the frontier only after a child, preserving
child-before-parent along every discovered path. This equals `--date-order` for
any history whose committer dates are **monotonic along parent edges** — i.e.
every history built by normal git operations, since a parent object predates the
child that references it. It does **not** enforce git's strict
all-children-before-parent rule for the adversarial *forged reverse-causal* case
(a parent dated newer than a child), trading that edge case for streaming
composition (efficient `take(N)`). Strict `--date-order` is deferred to **23.4j**.
See ADR-261 §"Date-order scope".

## Surface

### `foldSubject` (domain)

```ts
// src/domain/objects/commit-message.ts — beside subjectLine / stripspace
export const foldSubject = (message: string): string => { /* … */ };
```

Pure, total, zero-dependency. Returns a single line (never contains `\n`).
**Not** re-exported from the public barrel in this slice — it is an internal
domain projection consumed by the upcoming `shortlog`/`log`-converge work, in
keeping with the existing treatment of `subjectLine`/`stripspace` (domain-local,
not advertised on `src/index.ts`). Exposing it publicly is a separable call left
to whoever first needs it on the public surface (YAGNI).

`foldSubject` vs the two neighbours it sits beside:

| fn            | input → output                                              | used by                        |
|---------------|-------------------------------------------------------------|--------------------------------|
| `subjectLine` | first physical line, verbatim (keeps trailing `\r`)         | reflog subjects, sequencer todos |
| `stripspace`  | whole message, git `whitespace` cleanup, `\n`-terminated    | `commit` message normalization |
| `foldSubject` | leading paragraph folded to one space-joined line (git `%s`)| shortlog / log-oneline (future)  |

These are **not** interchangeable: `subjectLine('a\nb')` is `'a'`;
`foldSubject('a\nb')` is `'a b'`. The reflog path deliberately keeps
`subjectLine` (git's reflog subject is the first line, not the folded `%s`).

### `walkCommitsByDate` — dedicated primitive (ADR-261)

```ts
// src/application/primitives/walk-commits-by-date.ts
export interface WalkCommitsByDateOptions {
  readonly from: ReadonlyArray<ObjectId>;
  readonly until?: ReadonlyArray<ObjectId>;
  readonly shallow?: ReadonlySet<ObjectId>;
  readonly ignoreMissing?: boolean;
  readonly verifyHash?: boolean;
}
export async function* walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> { /* … */ }
```

It walks **all parents** of every reachable commit, yielding them in commit-date
priority order (newest first, oid-asc tie-break), honouring the same `from` /
`until` / `shallow` / `ignoreMissing` / `verifyHash` / abort semantics as
`walkCommits` but with **no `order`** field — the order is the primitive's
identity. New binding `repo.primitives.walkCommitsByDate` + a primitives-barrel
re-export; `reports/api.json` regenerates to include both.

`walkCommits` (`topo` all-parents FIFO, `first-parent` FIFO) is left
behaviourally **untouched** — its lazy "read-on-pop" discipline and the
queue-overflow DoS guard that depends on it stay exactly as today; only its
private commit reader is relocated to the shared helper the two walkers co-own.

## Decision — dedicated `walkCommitsByDate` primitive (ADR-261)

Per ADR-261, the date-ordered history walk ships as a **sibling primitive**, not
a third `order` on `walkCommits`. The two are structurally different traversals
that cannot share a queue — the FIFO walker enqueues bare **oids** and reads
**lazily on pop**; the date walker must read **eagerly at enqueue** to know each
commit's timestamp. Cramming both into one function leaves a hard internal seam
where the overflow guard applies to one branch but not the other, and a dead
`order`-skip branch in the pop loop. A dedicated primitive keeps each walker
small, single-purpose, and independently testable — a divergent algorithm
isolated behind its own tests gives a tighter mutation surface (no FIFO/date
seam for mutants to hide in), leaves perf headroom to profile the eager-read
walk on its own, and keeps a later fusion open as a deliberate, test-backed move
rather than a risky retro-split (ADR-261's three drivers). The (now-vestigial)
`pickNext(_order)` "future heap-based scheduler" breadcrumb is logged for the
architecture pass, not removed in the feature commits.

### Why the date walk reads eagerly (and why FIFO must not)

The two disciplines are genuinely different and **cannot share one queue**:

- **`walkCommits` (FIFO)** enqueues bare parent **oids** and reads each commit
  lazily *on pop*. This is what makes the queue-overflow guard meaningful: an
  octopus commit with thousands of *fake* parents floods the queue cheaply (no
  reads), and `MAX_WALK_QUEUE_SIZE` is the backstop. A unit test exploits
  exactly this cheap-flood vector.
- **`walkCommitsByDate`** must know a commit's timestamp to place it in the
  priority queue, so it reads each commit *at enqueue time* and carries the
  loaded `Commit` through the queue (yielded on pop, never re-read). A fake
  parent **cannot** enter the date frontier — it fails to read first — so the
  cheap-flood vector the FIFO guard defends against does not exist here.

Consequently `walkCommitsByDate` is **not** given the numeric
`MAX_WALK_QUEUE_SIZE` guard (a cap line would be untestable without a
reachable-commit count in the tens of thousands). Its frontier is bounded
another way: a `seen` set guards enqueue (each reachable commit is read and
enqueued **at most once**, mirroring `describe`'s walk), so peak queue size ≤ the
reachable-commit count — the same memory ceiling any reachability walk inherently
holds. Forcing FIFO to also read-on-enqueue (to unify the two) is rejected: it
would move the overflow detection *after* the first parent read, changing the
guard's observable error from `INVALID_WALK_INPUT` to `OBJECT_NOT_FOUND` and
breaking the documented DoS contract.

### Shared between the two walkers

Only what is genuinely common is factored — over-factoring two oid-lazy /
commit-eager queues would re-introduce the seam ADR-261 avoids:

- **Seed validators** — `isEmptyFrom` / `exceedsMaxWalkSeeds` and their
  `INVALID_WALK_INPUT` reasons already live in `validators.ts`; both walkers
  call them.
- **Commit reader** — `walkCommits`'s private `fetchCommit`/`isObjectNotFound`
  (read object → skip non-commit → `ignoreMissing`/`missing` handling) is
  extracted to a shared internal helper imported by both. Behaviour-preserving
  for `walkCommits`; lands as its own `refactor(primitives)` commit before the
  feature.
- **Priority queue** — `domain/commit/priority-queue.ts` (`enqueue` /
  `QueueEntry<Commit>` / `precedes`), making `walkCommitsByDate` the
  payload-carrying consumer ADR-259 anticipated.

### Reuse — third consumer of the shared priority queue

The date path imports `enqueue` / `QueueEntry<T>` / `precedes` from
`domain/commit/priority-queue.ts` (ADR-259's home), carrying the loaded `Commit`
as the entry payload (`QueueEntry<Commit>`). This makes the date walk the
priority queue's clearest payload-carrying consumer and reuses its
property-tested comparator rather than re-deriving date ordering.

## Algorithm — `date` order

```
seen ← new Set(from)
for each seed in from:
  if until.has(seed): continue          // excluded seed: never read, never yielded
  enqueueIfCommit(seed)                  // eager read; skip non-commits / ignoreMissing
while queue not empty:
  if aborted: throw OPERATION_ABORTED
  {value: commit} ← queue.shift()        // newest commit-date first
  yield commit                           // already an until-free, deduped commit
  if shallow.has(commit.id): continue    // boundary: do not expand parents
  for parent in commit.parents:
    if seen.has(parent) or until.has(parent): continue
    seen.add(parent)
    enqueueIfCommit(parent)

enqueueIfCommit(oid):
  commit ← readCommit(oid)              // shared helper: verifyHash / ignoreMissing / non-commit-skip
  if commit: enqueue {oid, date: commit.committer.timestamp, value: commit}
```

(`commit.committer.timestamp` / `commit.parents` / `commit.id` are shorthand for
the real `commit.data.committer.timestamp` / `commit.data.parents` /
`commit.id`.)

The `until` gate moves to **before** the eager read (both at seeding and at
parent expansion) so the queue only ever holds commits that *will* be yielded —
the pop loop carries no skip branch. This matches FIFO's observable behaviour
exactly: FIFO's pop-time `until.has(id)` check fires *before* `fetchCommit`, so
an excluded — or excluded-and-missing — boundary is never read. Reading it
eagerly would diverge (throw `OBJECT_NOT_FOUND` where FIFO stays silent).

- **dedup**: `seen` is seeded with `from` and gated on enqueue → every commit
  is read and enqueued at most once; a diamond's shared base appears once.
- **until**: an excluded oid is never read, never enqueued, never yielded — at
  both seeding and parent expansion.
- **shallow**: a shallow-boundary commit is yielded but its parents are not
  walked (matches FIFO + canonical git on a `.git/shallow` repo).
- **abort**: checked at every loop head, identical to FIFO.
- **ignoreMissing / verifyHash**: threaded straight into the shared `readCommit`
  helper; a missing parent under `ignoreMissing` is skipped (the `seen` gate,
  not a `missing` set, prevents any retry).

## Tests

### `foldSubject` — example (`commit-message.test.ts`)

GWT/AAA, `sut`, one expectation per case:

- two-line subject folds with a single space (`'a\nb'` → `'a b'`);
- the body after the first blank line is dropped (`'s\n\nbody'` → `'s'`);
- per-line **trailing** whitespace stripped before joining (`'a  \nb'` → `'a b'`);
- **leading** whitespace on a continuation line is preserved (`'a\n  b'` → `'a   b'`);
- a leading blank line yields `''`;
- every git `isspace` kind is trimmed (space/`\t`/`\v`/`\f`/`\r`);
- CRLF: the trailing `\r` is trimmed (unlike `subjectLine`, which keeps it);
- single-line and empty messages;
- U+00A0 stays content (ASCII-only trim).

Guard-isolation per CLAUDE.md: the "stop at blank line" branch and the
"trailing-trim" branch get **independent** cases so neither survives alone.

### `foldSubject` — properties (`commit-message.properties.test.ts`)

Reusing `arbCommitMessage()` from the sibling `arbitraries.ts`. `foldSubject`
fits lens 4 (idempotence) + invariants:

- **idempotent**: `foldSubject(foldSubject(m)) === foldSubject(m)` (the output is
  already a single trailing-trimmed line) — `numRuns: 200`;
- **no newline**: the result never contains `\n` — `numRuns: 200`;
- **body-independent**: for an arbitrary subject (a single non-blank line) and
  arbitrary body, `foldSubject(`${subject}\n\n${body}`) === foldSubject(subject)`
  — the subject ignores everything past the first blank line — `numRuns: 100`;
- **never throws** — `numRuns: 100`.

### `walkCommitsByDate` — example (`walk-commits-by-date.test.ts`)

A new sibling suite (its own `linearChain` / `buildDiamond` fixtures, mirroring
`walk-commits.test.ts`):

- empty `from` → `INVALID_WALK_INPUT` (empty); over-cap `from` → `INVALID_WALK_INPUT`
  (too many) — both validators wired;
- linear 5-chain → newest-first sequence, all five present;
- diamond `A→B,C→D` with strictly-increasing dates `a<b<c<d` → exact order
  `[d, c, b, a]` (pins the all-parents reach **and** the newest-first
  comparator: a FIFO/topo mutant would yield `[d,b,c,a]`);
- **tie-break**: two commits with **equal** committer dates pop in oid-ascending
  order (pins `precedes`'s tie-break; kills the `a.oid < b.oid` mutant);
- diamond shared base `a` appears exactly once (dedup `seen` guard);
- `until=[base]` excludes the base (and is not yielded); a `until` seed is never
  read (kills the "read-then-skip" divergence);
- `shallow={tip}` yields only the tip (parents not expanded);
- `ignoreMissing` + a missing parent → child yielded, no throw;
- missing parent without `ignoreMissing` → `OBJECT_NOT_FOUND`;
- non-commit seed (a tree oid) is skipped (shared reader's type check);
- an already-aborted signal → zero yields, `OPERATION_ABORTED`; an abort between
  two yields → `OPERATION_ABORTED` at the next loop head.

The extracted shared reader keeps `walk-commits.test.ts` green unchanged
(behaviour-preserving relocation), proving the refactor is invisible to the FIFO
walker.

### Interop — faithfulness goldens

A new `history-interop.test.ts` (cross-tool, `skipIf(!GIT_AVAILABLE)`) builds a
small DAG with **strictly-decreasing** commit dates via canonical `git`
(scrubbed `GIT_*`, signing off), then asserts:

- the `walkCommitsByDate` oid sequence equals `git rev-list --date-order <tip>`;
- for every commit, `foldSubject(message)` equals `git log -1 --format=%s <oid>`
  — including a deliberately multi-line subject and a trailing-whitespace
  subject, the two shapes that separate `%s` from a naive first-line split.

Distinct dates keep the golden independent of git's unspecified equal-date heap
order; the deterministic tie-break is a unit-test concern only.

## Coverage / mutation

100% line/branch/function/statement on every touched file; 0 surviving killable
mutants. The known-awkward spots and their kills:

- newest-first comparator → the exact-order diamond case;
- oid tie-break → the equal-date case;
- `seen` dedup → the diamond-shared-base single-appearance case;
- `until` pop-skip vs parent-skip → separate cases;
- `foldSubject`'s blank-line break and trailing-trim → isolated cases.

No `v8 ignore` / `stryker-disable` directives. Any genuinely equivalent mutant
(e.g. a loop-bound that returns `undefined` out of range) is annotated inline
with `// equivalent-mutant: <why>` only.

## Out of scope (logged, not done)

- Widening `repo.log`'s public options with `order` — deferred to the read-model
  convergence capstone **23.4j** (which decides the converged porcelain shape);
  preempting it here would risk a surface 23.4j wants to own.
- Publicly exporting `foldSubject` — separable; recorded as a possibility, not
  done (YAGNI).
- A **strict `git rev-list --date-order` mode** (the two-pass in-degree sort that
  enforces all-children-before-parent under forged reverse-causal committer
  dates) — deferred to the log-convergence capstone **23.4j**, built only if a
  converged porcelain needs it; the lazy walk is faithful for every causally-dated
  history (ADR-261 §"Date-order scope").
- Unifying `describe`'s bespoke date walk onto `walkCommitsByDate` — its
  candidate-reachability bookkeeping is entangled; rule-of-three is not yet met
  (`walkCommitsByDate` is the second general consumer). Re-evaluated in the
  architecture pass; logged as a follow-up if it stays divergent.
