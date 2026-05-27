# ADR-158: `excludes` alongside `paths` on WorkdirSnapshotOptions

## Status

Accepted (at `1c35bc3`)

## Context

Two filtering grammars exist in the codebase, with different semantics:

1. **Pathspec** (`src/domain/pathspec/`, from 14.2) — flat include/exclude
   patterns with `:(exclude)`, `:(literal)`, `:(icase)` magic. Used by `add`,
   `rm`, `checkout`.
2. **Gitignore** (`src/domain/ignore/`, from 14.3) — per-directory cascade
   with `!` re-inclusion, file-location-aware, last-match-wins. Used by
   `add --all`, `status` untracked enumeration.

`WorkdirSnapshot` needs both. Pathspec answers "what paths is the user
asking about?" (e.g., `src/**`). Gitignore answers "which paths should be
excluded regardless?" (e.g., `node_modules/`, `.env`, anything in
`.gitignore`).

Pathspec's `:(exclude)` magic can express simple exclusion, but it does NOT
implement `.gitignore` semantics — no per-directory cascade, no `!`
re-inclusion, no last-match-wins. Trying to make pathspec subsume gitignore
would warp the grammar.

## Decision

`WorkdirSnapshotOptions` carries BOTH:

```typescript
interface WorkdirSnapshotOptions extends SnapshotOptions {
  readonly paths?: Pathspec                                  // inclusion + :(exclude)
  readonly excludes?: WalkIgnorePredicate                    // .gitignore cascade
  // ...
}
```

**Composition contract:**

- `paths` AND `excludes` compose with logical AND.
- A path is emitted iff INCLUDED by `paths` AND NOT EXCLUDED by `excludes`.
- Evaluation order is pathspec first (cheap tree-pruning during enumeration),
  then ignore (per-directory cascade evaluated as the walker descends). This
  is purely an optimization; the result is identical either-first.
- Omitted `paths` ⇒ all paths included. Omitted `excludes` ⇒ no paths excluded.

`excludes` is the existing `WalkIgnorePredicate` signature from 14.3.
`repo.ignoreMatcher()` builds one from the `.gitignore` cascade.

## Consequences

### Positive

- Single mental model: two named knobs, each native to its concern. Users
  don't have to choose "should I express this as pathspec or gitignore?"
- Free reuse of 14.3's `MatcherStack` and the gitignore parser.
- AND composition reads naturally — `status` becomes `join({index, workdir({
  excludes: ignore})})`.

### Negative

- Two filter knobs to learn. Mitigated: `repo.ignoreMatcher()` is the standard
  builder for `excludes`; users rarely hand-roll the predicate.
- TreeSnapshot / IndexSnapshot don't have `excludes` — they pre-date `.gitignore`
  in the conceptual hierarchy (working-tree-only concern). Documented.

### Neutral

- Composition order (pathspec first) is an implementation detail; users
  shouldn't write code dependent on it.
- Property test in `*.properties.test.ts` covers the four quadrants
  (in/out × ignored/unignored).
