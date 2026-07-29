# 532 — Linked-worktree conformance: full write-surface sweep in one change

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-294 (read-layer threading), ADR-296 (discovery deferral)

## Context

Making `openRepository` resolve a `.git` gitdir pointer file exposes every remaining
`ctx.layout.gitDir` call site to Contexts where `commonDir !== gitDir`. ADR-294 threaded
only the read layer; the design's audit found ~20 write-side sites (object writes,
ref/reflog writes, config writes via `remote`/`clone`/`submodule`, `shallow`, hooks dir)
that would land bytes in the per-worktree admin dir where no git can see them.

## Options considered

1. **Full sweep — discovery plus every per-worktree/shared site, in this change** (recommended) — pros: no silent-corruption window; the library works end-to-end in the environment the brief targets / cons: larger diff (~20 one-line call-site changes over existing helpers).
2. **Discovery + read surface only; refuse mutating commands when `commonDir !== gitDir`** — pros: smaller diff / cons: ships a read-only library for the target environment, and the blanket refusal would break `worktree add`'s own materialise step.
3. **Discovery only; document the write divergence** — pros: minimal / cons: `repo.commit()` from a worktree writes objects into `<admin>/objects/` — silent corruption, a prime-directive breach.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: the discovery fix and the
complete per-worktree/shared conformance sweep (every ⇒C/⇒P site in the design's §4
audit) land in the same change. A partial split is a corruption trap, not a partial
feature.

## Consequences

Commits us to auditing all `ctx.layout.gitDir` sites against the pinned
`git rev-parse --git-path` split and to interop proof that writes from a worktree land
where git lands them. Forecloses any intermediate release where `commonDir !== gitDir`
Contexts exist but write incorrectly.
