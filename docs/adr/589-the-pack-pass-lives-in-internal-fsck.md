# 589 — The pack pass lives in internal/fsck

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-9)

## Context

The pack-health pass needs a home. The fsck command already composes two passes —
`runContentValidationPass` and `runRefsVerifyPass` — each in its own file under
`src/application/commands/internal/fsck/`, each returning `{ findings, exitBit }`.

## Options considered

1. **`internal/fsck/pack-health.ts` exporting `runPackHealthPass`** (designer's
   recommendation) — matches the two existing passes exactly; command-internal,
   invisible to `api.json`.
2. **Inline in `fsck.ts`** — the command is 104 lines and already at the limit of what
   reads as one function.
3. **A public Tier-2 primitive** — reusable and independently documented, but adds a
   public export, a doc-coverage page, and a surface commitment for a capability with
   exactly one caller.

## Decision

Adopted as recommended: the third sibling pass in `internal/fsck/pack-health.ts`,
composed by OR at the command's existing exit-code fold.

## Consequences

No new composition mechanism; no public surface from the pass itself.
