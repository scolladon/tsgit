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
`git rev-list --date-order` exactly; the deterministic tie-break is pinned by a
unit test, not by git parity.

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

### `walkCommits` — new `order: 'date'`

```ts
// src/application/primitives/types.ts
readonly order?: 'topo' | 'first-parent' | 'date';
```

`date` walks **all parents** of every reachable commit, yielding them in
commit-date priority order (newest first, oid-asc tie-break). It honours the
same `from` / `until` / `shallow` / `ignoreMissing` / `verifyHash` / abort
semantics as the existing orders. The primitive is already bound at
`repo.primitives.walkCommits`, so the new order is reachable without any new
binding or export — only the `WalkCommitsOptions.order` union widens (additive).

`topo` (all-parents FIFO) and `first-parent` (FIFO) are **untouched** — their
lazy "read-on-pop" discipline and the queue-overflow DoS guard that depends on
it stay exactly as today.

## Decision — date-order walk lives on `walkCommits` (`order: 'date'`)

`walkCommits` already declares a three-state intent: `pickNext(queue, _order)`
carries the comment *"Order arg retained for future heap-based scheduler."* The
date order **is** that scheduler. Adding it as a third `order` keeps one
read-model entry point for "walk commits," reuses `validateOptions`,
`fetchCommit`, the abort check, and the `until`/`shallow`/`missing` handling,
and surfaces automatically through the existing `repo.primitives.walkCommits`
binding.

The alternative — a separate `walkCommitsByDate` primitive — buys cleaner
separation of the eager (date) from the lazy (FIFO) disciplines but at the cost
of a second primitive, a new binding/export, and duplicated `until`/`shallow`/
abort plumbing. Rejected as surface bloat against the breadcrumb's intent. (ADR
below.)

### Why date order must read eagerly (and why FIFO must not)

The two disciplines are genuinely different and **cannot share one queue**:

- **FIFO (`topo`/`first-parent`)** enqueues bare parent **oids** and reads each
  commit lazily *on pop*. This is what makes the queue-overflow guard
  meaningful: an octopus commit with thousands of *fake* parents floods the
  queue cheaply (no reads), and `MAX_WALK_QUEUE_SIZE` is the backstop. A unit
  test exploits exactly this cheap-flood vector.
- **`date`** must know a commit's timestamp to place it in the priority queue,
  so it reads each commit *at enqueue time* and carries the loaded `Commit`
  through the queue (yielded on pop, never re-read). A fake parent **cannot**
  enter the date frontier — it fails to read first — so the cheap-flood vector
  the FIFO guard defends against does not exist here.

Consequently the date path is **not** given the numeric `MAX_WALK_QUEUE_SIZE`
guard. Its frontier is bounded another way: a `seen` set guards enqueue (each
reachable commit is read and enqueued **at most once**, mirroring `describe`'s
walk), so peak queue size ≤ the reachable-commit count — the same memory ceiling
any reachability walk inherently holds (and the same `visited`-bounded ceiling
the FIFO path reaches once its cheap-flood guard is satisfied). Forcing FIFO to
also read-on-enqueue (to unify the two) is rejected: it would move the overflow
detection *after* the first parent read, changing the guard's observable error
from `INVALID_WALK_INPUT` to `OBJECT_NOT_FOUND` and breaking the documented DoS
contract.

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
  commit ← fetchCommit(oid)              // shared with FIFO: verifyHash / ignoreMissing / missing
  if commit: enqueue {oid, date: commit.committer.timestamp, value: commit}
```

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
- **ignoreMissing / verifyHash**: threaded straight into the shared
  `fetchCommit`; a missing parent under `ignoreMissing` is recorded and skipped.

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

### `walkCommits` `order: 'date'` — example (`walk-commits.test.ts`)

Extends the existing suite (same `linearChain` / `buildDiamond` fixtures):

- linear 5-chain, `order:'date'` → newest-first sequence, all five present;
- diamond `A→B,C→D` with strictly-increasing dates `a<b<c<d` → exact order
  `[d, c, b, a]` (pins the all-parents reach **and** the newest-first
  comparator: a topo-FIFO mutant would yield `[d,b,c,a]`);
- **tie-break**: two commits with **equal** committer dates pop in oid-ascending
  order (pins `precedes`'s tie-break; kills the `a.oid < b.oid` mutant);
- diamond shared base `a` appears exactly once (dedup `seen` guard);
- `until=[base]` excludes the base (and is not yielded);
- `shallow={tip}` yields only the tip (parents not expanded);
- `ignoreMissing` + a missing parent → child yielded, no throw;
- missing parent without `ignoreMissing` → `OBJECT_NOT_FOUND`;
- an already-aborted signal → zero yields, `OPERATION_ABORTED`;
- **regression**: `topo` and `first-parent` outputs are unchanged (existing
  cases stay green).

### Interop — faithfulness goldens

A new `history-interop.test.ts` (cross-tool, `skipIf(!GIT_AVAILABLE)`) builds a
small DAG with **strictly-decreasing** commit dates via canonical `git`
(scrubbed `GIT_*`, signing off), then asserts:

- the `order:'date'` oid sequence equals `git rev-list --date-order <tip>`;
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
- Unifying `describe`'s bespoke date walk onto the new `order:'date'` — its
  candidate-reachability bookkeeping is entangled; rule-of-three is not yet met
  (date-walk is the second general consumer). Re-evaluated in the architecture
  pass; logged as a follow-up if it stays divergent.
