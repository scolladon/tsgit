---
subjects:
  - src/repository/find-layout.ts
  - src/repository/resolve-layout.ts
  - src/repository/validate-options.ts
---
# 714 — unusable-`commonDir` handling is route-appropriate

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D6) · **Refines:** ADR-657

## Context

git validates a common dir structurally (`objects/` + `refs/` present; `HEAD` stays a
gitDir concern) and refuses an unusable one with exit 128, attributing the failure to the
**gitDir**, never naming the common dir. tsgit's explicit-`gitDir` route is deliberately
lenient (no candidate validation; refusals surface at first command), a documented
refusal-shape divergence. The new argument must slot into one of those postures.

## Options considered

1. **Route-appropriate** — the discovery walk feeds the override to `sharedDirsValid` so
   candidates fail and the walk climbs; the explicit route stays lenient (design
   recommendation) — pros: reproduces git's condition where it is observable; preserves
   the leniency `init`/`clone` bootstrapping depends on / cons: a typo'd `commonDir` on
   the discovery route means read commands throw `NOT_A_REPOSITORY` while `init()`/
   `clone()` bootstrap a new repository at `{cwd}/.git` — the pre-existing found-nothing
   contract, reachable by one more input.
2. **Eager structural refusal on both routes** with a dedicated code naming the common
   dir — pros: more informative; closes the typo'd-bootstrap edge / cons: diverges from
   the sibling `gitDir` argument and needs a bootstrap carve-out.
3. **No structural check** — cons: discards a check the walk already performs for free.

## Decision

**Option 1 — ratified by the user, as recommended.**

An unusable `commonDir` invalidates discovery candidates; the explicit-`gitDir` route
stays lenient and defers refusal to first command. The typo'd-value bootstrap edge is
accepted and must be stated in the option's JSDoc.

*Mechanism refined during review (within the ratified option):* the walk **refuses at
open** with `NOT_A_REPOSITORY` at the first valid-`HEAD` candidate the override
invalidates, rather than climbing — the same override invalidates every level equally, so
climbing can only end at the found-nothing bootstrap, which (when `cwd` is itself the
repository root) would adopt that very repository with the override silently dropped.
Refusing preserves git's exit-128 condition on both cwd shapes; the bootstrap remains
reachable only when discovery genuinely finds no valid-`HEAD` candidate anywhere, which
keeps ADR-716's ignore-on-bootstrap behaviour intact.

## Consequences

- `validateOptions` still refuses the empty string eagerly with `INVALID_OPTION` — the
  argument-tier posture (ADR-657) turning git's "empty string is an active, always-failing
  override" into an informative refusal.
- `GITFILE_INVALID_FORMAT` is not reused — an argument has no file to be malformed.
- The refusal interop pin asserts conditions co-pinned with git's exit-128 rows, with the
  documented shape divergence on the explicit route.
