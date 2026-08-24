---
subjects:
  - src/repository/resolve-layout.ts
---
# 712 — a supplied `commonDir` suppresses `core.bare`

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D4) · **Refines:** ADR-226

## Context

Measured on git 2.55.0: setting `GIT_COMMON_DIR` **at all** — even to a value equal to the
gitDir — makes git ignore `core.bare` and keep a work tree, on both the discovery and the
explicit-`GIT_DIR` routes. The cwd-is-gitdir (`BARE_DIR`) route is measured unaffected.
tsgit's `isLinkedWorktreeAdmin` encodes the bypass for the discovery route only, and its
doc comment asserted no measured row extends it to an explicit gitDir. That row now
exists.

## Options considered

1. **Extend the bypass to `DISCOVERED` and `EXPLICIT`** (design recommendation) — pros:
   measured on both routes, prime directive binds; `resolveWorkTree`'s existing
   fall-through rows already return exactly the work tree git reports / cons: none — the
   `BARE_DIR` route is inert either way.
2. **Leave `isLinkedWorktreeAdmin` untouched** — cons: a knowing divergence with no
   upside.
3. **`DISCOVERED` only** (what falls out of doing nothing) — cons: bareness of an opened
   repository would depend on whether the caller also passed `gitDir` — an invisible
   coupling.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

Supplying `commonDir` suppresses `core.bare` on the `DISCOVERED` and `EXPLICIT` routes;
the `BARE_DIR` route follows `core.bare` alone, as measured.

## Consequences

- `isLinkedWorktreeAdmin`'s doc comment must be rewritten — the measured row it denies now
  exists.
- Because ADR-713 normalises a degenerate value away, the bypass cannot key on
  `outcome.commonDir !== undefined`; it needs an explicit "the caller supplied one"
  marker, carried beside the value and never emitted onto the layout.
- The bareness interop pin (design scenario G) covers all three routes.
