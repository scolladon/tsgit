---
subjects:
  - src/application/primitives/internal/ref-store.ts
---
# 856 — The HEAD slot is keyed on Context identity, not on the session

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D4, DC-6) · **Supersedes/Refines:** refines ADR-722

## Context

Session-scoped caching is the established rule for per-repository derived state, so the natural
key for ADR-855's HEAD slot is the session token. The HEAD slot is different from the caches that
rule was written for: it holds **bytes read through `ctx.fs`**, and a derived Context built as a
spread with a proxied filesystem is a routine shape here. The ref store already documents having
hit exactly this failure and keys its own per-Context state accordingly.

A session-keyed slot would let a Context whose `fs` is a proxy be served HEAD bytes the proxy
never produced.

## Options considered

1. **`WeakMap<Context, HeadSlot>`** (recommended, chosen) — pros: correct under a proxied `fs` by
   construction; matches the ref store's existing rule for the same reason. Cons: a derived
   Context reads HEAD once more.
2. **`WeakMap<Context['session'], HeadSlot>`** — pros: follows the general session-scoping rule;
   derived Contexts share the slot. Cons: reintroduces the proxied-`fs` bug the ref store already
   documents.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1. The HEAD slot is keyed on Context
identity. The general session-scoping rule continues to hold for caches whose contents are not
read through `ctx.fs`; this refines it with the boundary — **state derived from a Context's own
filesystem is keyed on the Context, not the session** — rather than overturning it.

## Consequences

A derived Context, such as the one `listWorktrees` builds, reads HEAD once itself, exactly as it
does today. The cost is one read per derived Context and the benefit is that no proxy can be
bypassed, which is not a trade worth re-opening for a single filesystem call.
