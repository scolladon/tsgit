# Plan — snapshot source accessors (23.4k)

Decision (ADR-274): **decline all four accessors.** The deliverable is the weigh
itself, so this is a **docs-only** change — no source, no new test.

## Why no code / no new test

The top-level `repo.*` surface is **already exhaustively pinned** by
`test/unit/repository/repository.test.ts` ("Then they exactly match the
documented surface" — an `Object.keys(sut).sort()).toEqual([...])` over the full
37-key list). Adding `repo.tree` / `repo.index` / `repo.workdir` would break that
assertion, so the "declined" decision is **regression-enforced by the existing
test**. A dedicated guard test asserting `repo.tree === undefined` would be
redundant double-coverage of the same surface — declined under DRY.

No production code is touched, so the TDD implement phase and mutation phase are
no-ops (nothing to red/green, nothing to mutate).

## Slices

### Slice 1 — explain the decision where users look

`docs/use/snapshots.md` lists the factory methods but does not say *why* sources
are reached through `repo.snapshot.*` rather than top-level `repo.*`. Add a short
"Why sources live on the factory, not `repo.*`" note so the natural question
("why no `repo.index`?") is answered at the point of use. No ADR/phase reference
in the prose body of user docs beyond a normal cross-link.

### Slice 2 — flip the backlog

`docs/BACKLOG.md`: `23.4k` `[ ]` → `[x]` with a one-line summary recording the
weigh outcome (declined; cohesion + altitude + reversibility; ADR-274).

## Validation

`npm run validate` (lint/format/types/full test suite + cspell). Expectations:

- The existing facade-surface test stays green (surface unchanged).
- cspell: watch the known British-spelling gap — full validate catches what the
  commit hook may miss.

## Review / refactor / mutation phases

- **Review ×3** — scoped to a docs diff; expect light/no findings (no types,
  no security surface, no test logic).
- **Architecture refactor** — anticipated **no-op**: nothing structural changes;
  the decision *removes* the temptation to fragment the snapshot namespace.
  Justification recorded even if nothing changes.
- **Mutation** — nothing to mutate (no production code).
