# 659 — `HEAD` content is parsed at discovery (refines ADR-534)

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D7)
- **Refines:** docs/adr/534-is-git-directory-validation-both-branches.md

## Context

ADR-534 chose a stat-only `HEAD` check ("a malformed HEAD is rejected later by the
primitives tier"). That held while the `.git` *name* was required — bait had to be
deliberate. With cwd-is-a-gitdir discovery, any directory holding entries named
`HEAD` + `objects/` + `refs/` is a candidate at every walk level and can shadow an
enclosing repository. git's measured predicate accepts `HEAD` iff it is a symlink whose
link text begins `refs/`, or a hex object id of width 40 or 64, or `ref:` + a token
beginning `refs/`; tsgit's stat-only check accepts `HEAD = "garbage"` where git climbs
past — a faithfulness gap that is now also a threat-model widening.

## Options considered

1. **Parse `HEAD` content — hex oid of either width, or `ref:` + `refs/`-prefixed
   token; keep the following-`stat` for the symlink case (design recommendation)** —
   pros: closes the security-relevant half; SHA-256 width for free; pure parse, no ref
   store / cons: one residual delta — git accepts a `HEAD` symlink with a dangling
   target (link-text check), tsgit rejects it.
2. **Keep stat-only (ADR-534 as-is)** — the gap above, now reachable from any
   directory shape.
3. **Full `validate_headref` with a `readLink` on `LayoutProbe`** — closes the dangling
   symlink delta at the cost of widening the port ADR-535 deliberately kept to
   `stat` + `readUtf8`, for a shape no git tool creates.

## Decision

**Option 1 — ratified by the user.** The dangling-symlink delta is recorded as a known,
deliberate divergence; option 3 remains available if it ever bites.
