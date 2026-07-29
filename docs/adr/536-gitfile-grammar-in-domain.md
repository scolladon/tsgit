# 536 — Gitfile/commondir grammar lives in the domain beside its serializer

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** none

## Context

The `gitdir:` pointer and `commondir` byte grammars need a parser (the serializer
already exists in `src/domain/worktree/admin-files.ts`). Placement determines which
tier owns byte-level grammar and whether the parse/serialize round-trip can be
property-tested as a pair.

## Options considered

1. **Pure parsers in `src/domain/worktree/gitfile.ts`; path algebra + I/O in `src/repository/find-layout.ts`** (recommended) — pros: parser sits beside its serializer, enabling the round-trip property test; `repository/` stays free of byte grammar / cons: none.
2. **Everything in `src/repository/find-layout.ts`** — pros: one file / cons: byte grammar leaks out of the domain; no natural round-trip pairing.
3. **A new `application/primitives/` module** — pros: none / cons: violates the dependency rule — discovery runs before any `Context` exists.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: `parseGitfilePointer` and
`parseCommondir` are pure domain functions returning discriminated unions, placed next
to `worktreeGitfile`/`WORKTREE_COMMONDIR`. `find-layout.ts` owns the walk, path
resolution, and probing.

## Consequences

Property-test lens 1 (round-trip pair) and lens 3 (totality over the grammar) apply to
the new parsers; grammar rows from the pinned matrix become example tests asserting
variant + payload.
