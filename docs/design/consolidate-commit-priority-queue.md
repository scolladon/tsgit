# Design — consolidate the date-ordered commit priority-queue

## Goal

A pure, behaviour-preserving refactor surfaced by `blame`'s architecture pass:
the date-ordered commit priority-queue (`precedes` = commit-date desc with an
oid-ascending tie-break, plus a sorted-insert `enqueue`) now exists in **three**
places:

- `src/domain/blame/priority-queue.ts` — the generic, payload-carrying variant
  (`QueueEntry<T>`, exported, with a unit test that fully kills its mutants).
- `src/application/commands/describe.ts` — an inline, payload-free copy
  (`QueueEntry { oid, date }`, local `enqueue`/`precedes`).
- `src/application/primitives/merge-base.ts` — an inline, payload-free copy with
  the field named `id` instead of `oid` (`QueueEntry { id, date }`, local
  `enqueue`/`precedes`).

Rule-of-three is met. Unifying touches `describe`/`merge-base` (outside blame's
own diff), so blame's architecture pass logged the consolidation here rather than
widening that PR (YAGNI/KISS bounded the blast radius).

Centralise the three into one shared **domain** helper, delete the two inline
copies, point all three consumers at it. No SHA, ref, reflog, on-disk state,
refusal, or output changes — the logic is identical across the three copies
(verified below). `npm run validate` stays green throughout.

## The duplication (verified identical)

The comparator is character-for-character the same modulo the field name:

```ts
// blame & describe
a.date > b.date || (a.date === b.date && a.oid < b.oid)
// merge-base (field named `id`)
a.date > b.date || (a.date === b.date && a.id  < b.id)
```

The sorted insert is identical in all three:

```ts
const enqueue = (queue, entry) => {
  let i = 0;
  while (i < queue.length && !precedes(entry, queue[i]!)) i += 1;
  queue.splice(i, 0, entry);
};
```

All three pop with `queue.shift()` and walk while `queue.length > 0` (merge-base
drains via `hasNonStale`, an orthogonal stop condition layered on the same pop
order). The entry shapes differ only in:

| consumer    | field | payload        | enqueue sites | reads after pop |
|-------------|-------|----------------|---------------|-----------------|
| blame       | `oid` | `value: T`     | 1             | `.value`        |
| describe    | `oid` | none           | 3             | `.oid`          |
| merge-base  | `id`  | none           | 1             | `.id`           |

## Decision — relocate the generic module, keep `QueueEntry<T>`

The backlog mandates **"pick the generic `QueueEntry<T>` shape"** — i.e. the
blame variant is canonical; the payload-free copies fold into it. The blame
module is already the right abstraction and is already fully mutation-killed by
its unit test, so the consolidation is a **relocation of the existing file** plus
deletion of the two inline copies — not a rewrite.

### Shared module surface (unchanged from today's blame module)

```ts
export interface QueueEntry<T> {
  readonly oid: ObjectId;
  readonly date: number;
  readonly value: T;
}

/** Newest commit date first, oid-ascending on equal dates. */
export const precedes = (a: Ordered, b: Ordered): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);

/** Sorted insert keeping the queue ordered by `precedes`. */
export const enqueue = <T>(queue: QueueEntry<T>[], entry: QueueEntry<T>): void => { … };
```

`precedes` keeps its structural `Ordered = { date; oid }` parameter type, so it
is callable on a bare `{ date, oid }` (as the existing test already does).

### Payload-free consumers

`describe` and `merge-base` carry no payload. They adopt `QueueEntry<undefined>`
and pass `value: undefined` at their enqueue sites. This is the literal reading
of "pick the generic `QueueEntry<T> shape`": one entry type, one comparator, one
insert, used everywhere.

- **`describe`**: delete the inline `QueueEntry`/`enqueue`/`precedes`; import the
  shared trio; type the walk queue as `QueueEntry<undefined>`; add `value: undefined`
  to the three enqueue calls (seed, `enqueueParents`, `finishDepth`). Pops already
  read only `.oid` — `as QueueEntry` casts become `as QueueEntry<undefined>`.
- **`merge-base`**: delete the inline copies; import the shared trio; rename the
  entry **field** `id` → `oid` (entry construction in `mark`, `entry.id` in the
  `hasNonStale` scan); add `value: undefined` in `mark`. The well-named local
  variable `id` used throughout `paint` stays — the pop becomes
  `const { oid: id } = queue.shift()!` (destructure alias), so no local rename
  ripples through the function body.

### Alternative considered — structural `Ordered` + `enqueue<T extends Ordered>`

Export only `Ordered` + `precedes` + a constraint-generic
`enqueue<T extends Ordered>(queue: T[], entry: T)`, letting each consumer keep
its own entry interface (blame `QueueEntry<T> extends Ordered`; describe/merge-base
their bare `{ oid, date }`). This avoids the `value: undefined` literals and keeps
blame's payload non-optional, **but** it abandons the single shared `QueueEntry<T>`
the backlog asked for (two entry-type definitions survive) and forces churn on the
already-correct blame module. Rejected: more change, weaker consolidation, against
the backlog's explicit guidance.

### Mutation win (no new suppressions)

The inline `describe`/`merge-base` copies each carry `// Stryker disable`
*equivalent-mutant* annotations on their `precedes`/`enqueue`: in those two walks
the pop order is result-invariant (merge-base's result set is order-independent;
describe's nearest-tag selection is invariant under equal-date reordering), so the
comparator's mutants are genuinely equivalent there. The shared module is instead
mutation-tested against **blame**, whose output *is* order-sensitive, so blame's
existing unit test kills every `precedes`/`enqueue` mutant with **zero
suppressions**. Consolidation therefore *removes* the two inline equivalence
annotations rather than adding any — the shared logic is proven by the one
consumer that observes ordering.

## Module location (ADR)

There is no established home for a pure, cross-command commit-walk primitive
(blame's copy lives under `domain/blame/`, coupling it to blame). This is a
genuine taxonomy choice → ADR. See the ADR conversation for the options; the
recommendation is a new `domain/commit/` directory (`domain/commit/priority-queue.ts`),
forward-looking for the commit-walk commands still queued (shortlog, range-diff,
name-rev), with the existing test relocated alongside.

## Test plan

- **Relocate** `test/unit/domain/blame/priority-queue.test.ts` to the new
  module's directory, updating only the import path. Its cases already cover
  `precedes` (date dominance, oid tie-break, full-equality) and `enqueue`
  (newest-first, ascending-tie, middle insert, empty queue) with a `string`
  payload — generic over `T`, so they exercise the shared shape directly.
- **describe**: existing `describe` unit + `describe-interop` suites must stay
  green unchanged (behaviour-preserving).
- **merge-base**: existing `merge-base` unit + interop suites must stay green
  unchanged; the `id` → `oid` rename is internal.
- **Mutation**: re-run Stryker on the shared module + all three consumers; target
  0 surviving killable mutants. Pre-existing equivalent-mutant annotations on the
  consumers' *other* logic are untouched; the two on the deleted inline queues
  disappear with the code.

## Architecture pass (post-implementation)

A no-op, justified. The feature's concern is the date-ordered commit priority-queue;
it had exactly three consumers, now all on `domain/commit/priority-queue.ts`. The
only other commit queue, `primitives/walk-commits.ts`, is a plain topo/first-parent
FIFO (`push`/`shift`, no date ordering) — a different scheduling concern, correctly
left untouched. The adjacent memoizing commit-readers (`describe`'s
`makeCommitReader`, `merge-base`'s `makeReadCommit`) are two *divergent* copies
(different cached projections: `{date, parents}` vs `Commit | undefined`) — below
rule-of-three and not reached by the priority-queue concern; unifying them would be
speculative (YAGNI), so they stay. Nothing to refactor; no scoped re-review needed.

## Non-goals

- No first-class collection / class wrapper around the queue (`shift`/`length`
  stay as the consumers use them) — YAGNI; the free-function array form already
  in use is preserved.
- No payload introduced for describe/merge-base (they remain payload-free via
  `QueueEntry<undefined>`); folding their parallel state maps into the entry is a
  behaviour-risking change out of scope here.
- No public-API change: the module is internal (imported by relative path, not
  re-exported through any barrel), so `reports/api.json` is unaffected.
