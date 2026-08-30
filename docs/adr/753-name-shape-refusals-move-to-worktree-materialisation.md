---
subjects:
  - src/domain/objects/tree.ts
  - src/application/primitives/internal/flatten-raw.ts
  - src/application/primitives/internal/resolve-tree-path.ts
  - src/application/primitives/materialize-tree.ts
  - src/application/primitives/build-index-from-tree.ts
---
# 753 — Name-shape refusals move to worktree materialisation

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D6) · **Supersedes/Refines:** none

## Context

tsgit refuses three name shapes — `.`, `..`, and an embedded separator — while parsing a
tree object. Probed against git 2.55.0 over hand-built trees, git refuses none of them
at parse:

| name | `ls-tree` | `rev-parse <tree>:<name>` | `read-tree` → index |
|---|---|---|---|
| `.` | lists it | resolves it | refuses: `error: invalid path '.'` |
| `..` | lists it | resolves it | refuses: `error: invalid path '..'` |
| `a/b` | lists it | resolves it | **accepts** — index entry at `a/b` |

git's `.`/`..` refusal lives at materialisation, not at parse; its embedded-separator
refusal exists only in `fsck`. tsgit refuses all three, at parse, on three sites.

## Options considered

1. **Move them to where git has them** — pros: faithful on every surface, consistent with the duplicate decision taken on identical evidence / cons: the refusal moves layers rather than vanishing, so materialisation and index construction gain a check they do not have today.
2. **Keep all three at parse, corrected to compare bytes** (designer's recommendation) — pros: preserves today's behaviour minus the byte bug / cons: leaves three now-pinned divergences by choice, and contradicts the duplicate ruling made on the same kind of evidence.
3. **Drop the separator refusal only** — cons: keeps the layer boundary blurred for two of the three.

## Decision

**Ratified by the user: option 1.** The object-parse layer stops refusing name shapes
entirely — `parseTreeContent`, `flatten-raw`'s name validation and `resolve-tree-path`'s
scan all drop the `.`/`..`/separator checks. Worktree materialisation and index
construction refuse `.` and `..` in git's shape, at the point where git refuses them.
The embedded-separator refusal is dropped outright; git indexes such a name as a path
and `fsck` is where it is reported.

Empty names are **not** covered here: git refuses those at parse, and ADR-754 keeps
them there.

## Consequences

### Positive

- Reading, listing and diffing a tree with an exotic name now behaves as git does, on every surface.
- The path-traversal shapes `.` and `..` are still refused before anything touches the filesystem — the guarantee moves layer, it does not weaken.

### Negative

- Two application primitives gain a refusal they did not carry, and the parse layer loses one, so the same fault surfaces with a different error at a different depth. Every row is pinned in the interop suite.
