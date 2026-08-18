# 655 — The pure config tokeniser moves to `domain/config/`

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D3)

## Context

Layout resolution must read `core.bare` / `core.worktree` / `extensions.*` from the
repository's own config before any Context exists. The char-wise config grammar lives in
`application/primitives/internal/config-ini.ts`, which `src/repository/` may not import
(the dependency rule is `repository → commands → primitives → domain`).

## Options considered

1. **Relocate the pure tokenising half (`tokenizeConfig`, `parseIniSectionsFromTokens`,
   `parseGitBoolean`, shared token types) to `src/domain/config/`; both tiers import it
   from there (design recommendation)** — pros: one grammar, no layering violation; the
   file is over the 800-line budget anyway and has no application-tier dependency /
   cons: a mechanical move touching three importers.
2. **Let `src/repository/` import from `application/primitives/internal/`** — inverts
   the dependency rule outright.
3. **Hand-roll a minimal three-key parser in `src/repository/`** — two config grammars
   whose refusals (`bare = banana`, valueless `worktree`) must agree by inspection.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Enforced by the hexagonal
dependency rule; a pure relocation with no behaviour change.
