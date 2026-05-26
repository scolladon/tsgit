# ADR-148: Pathspec engine reused at the snapshot level

## Status

Accepted (at `1c35bc3`)

## Context

Phase 14.2 ships `src/domain/pathspec/` (`compilePathspec`, `matchesPathspec`,
`compileGlob`). Phase 20.1 introduces snapshots (`TreeSnapshot`, `IndexSnapshot`,
`WorkdirSnapshot`) — each needs an optional inclusion filter for path-level
pruning.

Two options:

1. **Reuse the existing pathspec engine** — `SnapshotOptions.paths: Pathspec`.
2. **Introduce a simpler glob subset for snapshots** — `paths: ReadonlyArray<string>`,
   ignore pathspec magic, do basic glob matching only.

Option 2 was floated in spike review as a way to avoid coupling 20.1 to 14.2,
but 14.2 is already shipped, so the coupling is paid. Option 2 would create
TWO filtering grammars in the library — one for `add`/`rm`/`checkout`/`ignore`
(full pathspec) and one for snapshots (glob subset). Every user would have to
learn which API takes which.

## Decision

`SnapshotOptions.paths` is typed as `Pathspec` and resolved via `compilePathspec()`
from `src/domain/pathspec/`. The same engine that powers `add`, `rm`, `checkout`,
and the existing `internal/resolve-pathspec.ts` powers snapshot filtering.

`:(exclude)` magic, `:(literal)`, `:(icase)`, and the rest of git's pathspec
grammar work at the snapshot level uniformly with the other commands.

## Consequences

### Positive

- Single filtering grammar across every command surface.
- Free reuse of the existing parser, matcher, fuzz tests, and property tests
  built for 14.2.
- Git porcelain examples paste 1:1 into tsgit (`'src/**'` and
  `':(exclude)src/legacy/**'` already work).
- No new domain code, no new tests, no new edge cases.

### Negative

- Pathspec's magic prefix grammar is more than a casual user wants. Mitigated:
  plain globs `'src/**'` are valid pathspec — magic prefixes are optional.

### Neutral

- WorkdirSnapshot additionally accepts an `excludes: WalkIgnorePredicate` for
  `.gitignore`-style cascade evaluation. Pathspec and ignore are different
  algebras and compose with AND (see ADR-158).
