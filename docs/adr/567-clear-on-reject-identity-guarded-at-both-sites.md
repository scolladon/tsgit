# 567 — Clear-on-reject, identity-guarded, at both memo sites

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** refines the ADR-042 clear-on-reject shape

## Context

A promise-memo must decide what a rejected initialization leaves behind. The house
precedents (`node-file-system.ts` `rootSetPromise`, `read-commit-graph.ts` — "Never
memoize a rejection: a transient fs failure must not permanently poison every later
commit walk") clear unconditionally; for them the worst case is a redundant re-resolve.
Here `refresh()` can null the slot mid-flight and a successor memo can be installed
before the predecessor settles — an unguarded clear then erases the successor, whose
packs become unreachable, reproducing the leak in a narrower window (pinned empirically:
P3/P4 in the design's async-semantics matrix).

## Options considered

1. **Clear on reject, identity-guarded (`if (slot === pending)`), at both sites**
   (designer's recommendation) — preserves today's retry semantics exactly (`cache` /
   `cachedTable` both stay unset after a throw) and closes the successor-clobber window.
2. **Clear at `loadAll` only; memoise `offsetTable` rejections** — two memos in one file
   with different rejection semantics, for no reason.
3. **Memoise rejections at both sites** — a behaviour change: one transient
   `EMFILE`/`ENOENT` during a scan would wedge the registry for the Context's life.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

Transient failures stay retryable; a rejection reaches exactly the callers that joined
the failed flight. The identity guard lives once, inside the ADR-566 helper, where a
clear-then-reinstall-then-reject unit case kills its mutants; consumer sites never
reimplement it.
