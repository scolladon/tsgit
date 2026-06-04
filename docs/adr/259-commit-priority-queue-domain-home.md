# ADR-259: Shared commit priority-queue lives in `domain/commit/`

## Status

Proposed

## Context

The date-ordered commit priority-queue — `precedes` (commit-date descending,
oid-ascending tie-break) plus a sorted-insert `enqueue` — was duplicated across
three call sites: the generic, payload-carrying `domain/blame/priority-queue.ts`,
an inline payload-free copy in `commands/describe.ts`, and another inline copy in
`primitives/merge-base.ts` (field named `id`). Rule-of-three is met and the
backlog item directs consolidation into one shared **domain** helper, picking the
generic `QueueEntry<T>` shape.

The helper is pure (no ports, no I/O) and belongs in the domain layer. But there
is no established home for a cross-command commit-walk primitive: blame's copy
sits under `domain/blame/`, which couples a general-purpose ordering primitive to
one command. The same date-ordered walk underlies commands still queued —
shortlog, range-diff, name-rev — so the location chosen now will host more than
this one file over time.

Candidates:

1. **`domain/commit/priority-queue.ts`** — a new directory that is the semantic
   home for commit-walk ordering primitives.
2. **`domain/objects/commit-priority-queue.ts`** — reuse the directory that holds
   `ObjectId` and the commit object type (the module's only import), adding no new
   directory.
3. **`domain/walk/priority-queue.ts`** — a new directory framed around the
   "history walk" rather than the commit object.

## Decision

Place the shared module at **`src/domain/commit/priority-queue.ts`** (option 1),
relocating the existing blame module verbatim and deleting the two inline copies.

The module's surface is unchanged from today's blame module — generic
`QueueEntry<T>` (`oid`, `date`, `value: T`), `precedes` over a structural
`{ date, oid }`, and `enqueue<T>`. Payload-free consumers (`describe`,
`merge-base`) adopt `QueueEntry<undefined>` and pass `value: undefined`;
`merge-base` additionally renames its entry field `id` → `oid` to match.

`domain/commit/` is preferred over `domain/objects/` because the queue is a
commit-**walk ordering** concern, not an object-**representation** concern —
folding it into `objects/` would mix responsibilities. It is preferred over
`domain/walk/` because the unit of ordering is the commit (`oid` + committer
date), and `commit` reads more concretely than the broader `walk`. The one-file
directory is consistent with the codebase's many-small-focused-modules ethos and
is the forward-looking home for the queued commit-walk commands.

## Consequences

### Positive

- One comparator, one sorted insert, one entry type — the rule-of-three
  duplication is removed and future commit-walk commands reuse the same helper.
- Decouples the primitive from `blame`; `describe`/`merge-base` no longer carry
  inline copies.
- Net suppression reduction: the two inline copies' `// Stryker disable`
  equivalent-mutant annotations disappear with the code; the shared logic is
  mutation-proven by blame's order-sensitive test with zero suppressions.

### Negative

- Introduces a new one-file `domain/commit/` directory before its second
  resident lands (mitigated: the queued commit-walk commands will populate it).

### Neutral

- No public-API change: the module is internal (imported by relative path, not
  re-exported through any barrel), so `reports/api.json` is unaffected.
- Behaviour-preserving: no SHA, ref, reflog, on-disk state, refusal, or output
  change; the `id` → `oid` rename in `merge-base` is internal.
