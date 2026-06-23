# 414 — fsck gates on assertRepository only, not assertOperationalRepository

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/fsck.md · **Relates:** ADR-226 (git-faithfulness), ADR-346 (assertOperationalRepository gate)
- **Decision class:** D-GATE user-ratified

## Context

fsck's whole purpose is diagnosing a *broken* repository — one whose refs, objects, or even core
config may be corrupt. Other read commands (`log`, …) gate on `assertOperationalRepository`, which
asserts HEAD exists **and** core config is valid. The design doc provisionally carried that same
gate. But gating fsck behind core-config validity risks refusing exactly the repo a user runs
fsck on to find out *why* it is broken. **D7:** which assertion guards fsck?

## Options considered

1. **`assertRepository` only** (a repository / gitdir resolves) *(designer rec)* — pros:
   fsck runs on the broken repo it is meant to diagnose; matches git, which refuses only OUTSIDE
   a repository; cons: less consistent with the other read commands' gate.
2. **`assertOperationalRepository`** (HEAD + valid core config), like `log` — pros: surface
   consistency; cons: can refuse a corrupt-config repo that is precisely fsck's job to inspect.

## Decision

**Option 1 — gate fsck on `assertRepository` only (user-ratified).** fsck requires only that a
repository exists; it does **not** require valid core config or a born HEAD. It refuses only when
invoked outside a repository (git's "not a git repository", the sole fsck refusal). An
unborn/dangling HEAD symref is tolerated (clean, exit 0) — not a fault.

This deviates from the design's provisional `assertOperationalRepository` prose and from the other
read commands' gate; the deviation is intentional and faithful — fsck is the diagnostic that must
survive a repo the rest of the surface would reject.

## Consequences

- fsck runs on repos with broken refs/objects/config that `log` et al. would refuse.
- The only refusal path is non-repository; every in-repo fault becomes a finding, never a throw
  (consistent with the design's "in-repo faults are findings, never throws" rule).
- The design doc's Refusal & error semantics section and Requirement 6 are revised under the
  scope-fold rule to state `assertRepository`.
