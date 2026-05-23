# ADR-096: API coverage source-of-truth — `src/repository.ts` interface

## Status

Accepted (at `5cb6a6b`)

## Context

Phase 18.3's API coverage check needs a canonical enumeration of "every user-facing command and primitive that must have a docs page". Three candidates exist in the codebase:

1. **`src/repository.ts`** — the `Repository` interface, which lists every `repo.<command>` and `repo.primitives.<primitive>` binding the user touches.
2. **`src/index.{node,browser,default}.ts`** — the per-runtime entry shims; these re-export `openRepository` plus runtime-specific helpers.
3. **`src/application/{commands,primitives}/index.ts`** — the barrels that the `Repository` interface aliases.

`docs/BACKLOG.md` Phase 18.3 originally specified option 2 (`compares src/index.{node,browser,default}.ts exports against the API ToC`). When designing the check we found that this overcounts: the runtime shims export adapter detection helpers (`openRepository`, runtime-specific factories) that are not "commands" the docs surface in `docs/use/commands/` is meant to enumerate.

The split between Tier-1 commands and Tier-2 primitives is the source-of-truth for the `docs/use/` taxonomy — and that split lives precisely once in the codebase: the `Repository` interface in `src/repository.ts`.

## Decision

The API coverage check parses **`src/repository.ts`**. It extracts two name sets:

- **Tier-1 commands**: top-level `readonly <name>: ...` declarations directly inside `interface Repository { ... }`, excluding `primitives`, `ctx`, and `dispose`.
- **Tier-2 primitives**: top-level `readonly <name>: ...` declarations inside the nested `primitives: { ... }` block.

Each name kebab-cases to a required filename:
- `repo.<camelCase>` → `docs/use/commands/<kebab>.md` + a row in `docs/use/commands/README.md`
- `repo.primitives.<camelCase>` → `docs/use/primitives/<kebab>.md` + a row in `docs/use/primitives/README.md`

`src/index.{node,browser,default}.ts` and `src/application/{commands,primitives}/index.ts` are not consulted by the coverage check.

## Consequences

### Positive

- The check tracks the surface as users see it (`repo.*` bindings), not as the build system sees it (runtime-specific re-exports).
- One file owns the enumeration. A maintainer adding a new command edits `src/repository.ts` once and the check fires immediately.
- The kebab-case mapping is mechanical and reversible — no aliasing layer.

### Negative

- If we ever introduce a tier-3 (e.g. `repo.operators.*`) or expand the surface beyond the `Repository` interface, the check needs to be extended. Single-file parser; low cost.
- Internal-only re-exports from `src/application/{commands,primitives}/index.ts` are not enforced to have docs pages. Acceptable — those modules carry the implementation; users see them only via `repo.*`.

### Neutral

- The original backlog wording is now stale. 18.3's commit message + this ADR record the pivot; no further cleanup needed.
- A short allowlist (`scripts/check-doc-coverage.allowlist.json`) covers genuinely undocumented surface (none at land time). Empty by default; entries land with a justification comment.
