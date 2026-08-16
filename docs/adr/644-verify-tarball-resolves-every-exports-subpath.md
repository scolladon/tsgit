# 644 — verify-tarball resolves every exports subpath

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D6)

## Context

The broken `"./commands/*"` wildcard shipped through every existing gate:
`check:exports` (attw) validates the entries it can resolve and says nothing about a
wildcard with no matching files, so a subpath pattern that resolves to nothing is
invisible to the whole `validate` battery. With ADR-640 adding ~49 wildcard-matched
entries, the class gets larger, not smaller.

## Options considered

1. **Extend `tooling/verify-tarball.sh` to resolve every `exports` subpath — wildcards
   expanded against `dist/` — and fail on a miss (design recommendation)** — pros:
   already runs under `validate` via `check:tarball` and already has `dist/` in hand /
   cons: shell-script growth.
2. **A dedicated `check:exports-resolve` wireit task** — pros: cleaner in isolation /
   cons: a 23rd `validate` dependency for a check verify-tarball can host.
3. **None; rely on review** — pros: nothing to maintain / cons: the defect class already
   shipped once.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `verify-tarball.sh` gains a
step that enumerates the `exports` map, expands wildcard patterns against the packed
`dist/`, resolves every concrete specifier, and fails on any miss — so an entry that
resolves to nothing can never ship again.
