# 643 — The `./commands` barrel subpath is exported

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D4)

## Context

Pinned during design, and not in the perf review that seeded it:
`@scolladon/tsgit/commands` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on 3.3.0. The
commands barrel is built (`dist/*/commands/index.*`) and documented, but the `exports`
map carries only the `"./commands/*"` wildcard, which the bare `./commands` specifier
does not match. The only working specifier for the barrel is the undocumented
`./commands/index`.

## Options considered

1. **Add a `"./commands"` entry pointing at `dist/*/commands/index.*` (design
   recommendation)** — pros: one additive map entry; correct under any resolution of the
   wildcard question (ADR-640) / cons: none identified.
2. **Leave it; `./commands/index` keeps working** — pros: zero change / cons: the
   documented import form of the barrel stays broken.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The `exports` map gains a
`"./commands"` entry with the same import/require/types shape as the other subpath
entries, resolving to the built barrel.
