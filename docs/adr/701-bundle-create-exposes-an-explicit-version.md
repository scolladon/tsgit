# 701 — `bundleCreate` exposes an explicit bundle version

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate N1) · **Refines:** ADR-249, ADR-683

## Context

Measured on git 2.55.0: `--version=3` is accepted on a **SHA-1** repository (writing
`@object-format=sha1`), and `--version=2` is **refused** on a SHA-256 one —
`fatal: cannot write bundle version 2 with algorithm sha256`, exit 128. So the version is not a
pure function of the object format in either direction.

`BundleCreateOptions` has no `version`, and `bundle-create.ts` pins `const VERSION = 2`.

## Options considered

1. **No option; derive the version from the algorithm** — pros: smallest surface / cons: the
   measured v2-on-SHA-256 refusal becomes permanently unreachable, so its interop row could only
   ever be half-asserted — git's side pinned, tsgit's side unreachable.
2. **`version?: 2 | 3`, defaulting to the derived value** — pros: both measured refusals become
   reachable and fully co-pinnable; the default keeps the common case argument-free.
3. **Thread the parameter internally without exposing it** — pros: no public surface / cons: the
   same unreachability as option 1 from a caller's perspective.

## Decision

**Option 2 — adopted as recommended (no user judgment).**

`BundleCreateOptions` gains `version?: 2 | 3`. Omitted, it derives from the repository's object
format (and from the other v3 triggers of ADR-683). Supplied, it is honoured, and the
v2-with-SHA-256 combination refuses as git refuses it.

This does **not** conflict with ADR-249. That rule forbids options whose only job is to steer
*rendered text*. A bundle version selects an **on-disk format** — the same category as
`objectFormat` itself — so it is a structural selector, not a cosmetic one.

## Consequences

- Both directions of the measured matrix become interop-testable from both sides, which option 1
  could not deliver.
- The default stays derived, so no existing caller changes behaviour.
- The refusal for an impossible combination is a new condition; it reuses the config/enum error
  family conventions rather than inventing a bundle-specific shape.
