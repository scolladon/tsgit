# 534 — `is_git_directory` validation on both discovery branches

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-226 (git-faithfulness)

## Context

git validates a candidate git dir (`HEAD` present, `objects/` and `refs/` directories
exist, resolved through `commondir` when present) before accepting it. The design's
pinned matrix (§1g row 3) shows git *skipping* a `.git` directory that fails this
predicate and continuing the walk; today's tsgit accepts any `.git` directory and opens
a broken repository.

## Options considered

1. **Apply the predicate to both branches (file and directory)** (recommended) — pros: closes the measured divergence with the same predicate the file branch needs anyway; cost is two extra `stat`s only on levels that have a `.git` / cons: changes the fixture of one existing unit test.
2. **File branch only** — pros: smaller / cons: leaves the directory-branch divergence open.
3. **No validation (today)** — pros: none / cons: accepts non-repositories.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: `layoutFor` gates both branches
on the probe-level `is_git_directory` (`<gitDir>/HEAD` exists, `<commonDir>/objects` and
`<commonDir>/refs` are directories). tsgit checks `HEAD` existence only (ref parsing is
unavailable at discovery time); a malformed-`HEAD` repo is accepted here and rejected by
`assertRepository`/ref-store with their own structured error, never by walking up.

## Consequences

An invalid `.git` directory no longer shadows a valid enclosing repository. The
narrowed-predicate gap (malformed `HEAD` content) is documented in the design and
covered by later layers.
