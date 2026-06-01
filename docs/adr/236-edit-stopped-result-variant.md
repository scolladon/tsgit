# ADR-236: `edit` is a conflict-free `stopped` result variant resumed by `continue`

## Status

Accepted (at `2e17819f`)

## Context

The `edit` instruction applies its commit (fast-forward or cherry-pick) and then
**stops** so the caller can amend the tree and/or message, resuming with
`continue`. This stop is conflict-free — the index is clean. The existing
`RebaseResult.conflict` variant carries `conflicts: ReadonlyArray<...>` and means
"the working tree has unmerged paths you must resolve"; an `edit` stop has none.

Verified against git 2.54: an `edit` stop writes the full `.git/rebase-merge/`
set **plus** an `amend` file containing the produced commit's oid. On
`--continue`, git reads `amend` to decide: index unchanged vs HEAD → no new
commit (resume the todo, trailing commits may fast-forward, keeping oids); index
changed → amend (new commit, `rebase (continue): <subject>`), resume.

Options for surfacing the stop:

1. **New `stopped` variant** — `{ kind: 'stopped'; commit; remaining }`,
   distinct from `conflict`.
2. **Reuse `conflict`** with `conflicts: []` and a `reason` discriminator.

## Decision

**Option 1 — a new `stopped` result variant.**

```ts
type RebaseResult =
  | { kind: 'rebased'; commits }
  | { kind: 'up-to-date' }
  | { kind: 'conflict'; commit; conflicts; remaining }
  | { kind: 'stopped';  commit; remaining };   // edit (conflict-free)
```

`continue` resumes both `conflict` and `stopped`. The resume path reads the
on-disk `amend` file (added to `RebaseState`, see the design) to choose
amend-or-skip; the `stopKind` (`'conflict' | 'edit'`) is derived from the
`amend` file's presence. `skip`/`abort` behave identically for both stop kinds.

A dedicated variant keeps `conflicts` meaning "paths to resolve" (never empty
when present) and lets callers branch on `kind` without inspecting an array's
length — clearer types over a runtime check (project style).

## Consequences

### Positive

- Honest types: `conflict` always carries real conflicts; `stopped` is the
  voluntary, clean pause. Callers discriminate on `kind`.
- Additive to the union — non-interactive callers never receive `stopped`.

### Negative

- One more variant for consumers to handle; documented as "resume with
  `continue` after amending, or `skip`/`abort`".

### Neutral

- The `amend` file is the single source of truth for amend-vs-skip on continue,
  matching git; it doubles as the in-flight marker during squash/fixup melds.
