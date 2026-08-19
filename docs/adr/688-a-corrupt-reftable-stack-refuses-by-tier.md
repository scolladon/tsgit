# 688 — A corrupt reftable stack refuses by tier, and does not replicate git's crash

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-4) · **Refines:** ADR-226, ADR-680

## Context

The prime directive says replicate git's observable behaviour. On a corrupt reftable stack that
instruction has no faithful target: **git 2.55.0's own `fsck` dies on signal 11** against the
measured fixture. A segmentation fault is not behaviour to reproduce.

## Options considered

1. **Refuse precisely everywhere** — one refusal for any malformed stack — pros: simple, safe /
   cons: refuses reads git completes fine when only one table of several is damaged.
2. **Replicate git's silent-empty** where git degrades and crash where it crashes — excluded:
   reproducing a crash is not a behaviour tsgit can or should offer.
3. **Split by tier** (design recommendation) — structural damage the parser can localise
   degrades per-table the way git's readers do; damage that makes the stack unreadable refuses
   with a named code.

## Decision

**Option 3 — adopted as recommended (no user judgment), as a documented divergence.**

Where git crashes, tsgit refuses with a structured code. Where git degrades, tsgit degrades
identically. The divergence is confined to inputs on which git has no defined behaviour, so it
narrows rather than widens the faithfulness gap.

## Consequences

- This is a deliberate divergence from ADR-226 and is recorded as one: git's behaviour on this
  input class is a crash, and tsgit will not reproduce it.
- The interop suite cannot co-pin the crashing rows. It asserts git's exit signal and tsgit's
  structured refusal side by side, so the divergence is visible rather than silently untested.
- A future git release that defines behaviour here supersedes this ADR; the fixture is retained
  so the comparison can be re-run.
