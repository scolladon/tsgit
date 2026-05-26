# ADR-160: `TSGIT_SUPPRESS_DEPRECATIONS` env var + warn-once-per-callsite

## Status

Accepted (at `1c35bc3`)

## Context

ADR-152 ships deprecated walkers (`walkTree`, `walkWorkingTree`) as `@deprecated`
facades through the 2.x line. JSDoc `@deprecated` triggers IDE squiggles and
TypeScript build warnings, but runtime users (who don't see compiler output)
miss the signal entirely.

Two questions:

1. **Should there be a runtime warning?** Yes — silent deprecation is missed
   by users on CI-only or production-only paths. The point of the deprecation
   cycle is to *nudge* migration.
2. **How loud and how often?** Unconditional `console.warn` on every call is
   noise. Once-per-process is too sparse if the user has many call-sites.
   Once-per-call-site is the right granularity.

Plus: any runtime warning must be silenceable. CI logs, embedded contexts,
and library consumers who want to migrate on their own schedule need an
opt-out.

## Decision

**Warn-once-per-call-site**, gated by `TSGIT_SUPPRESS_DEPRECATIONS=1`.

Implementation sketch:

```typescript
// src/application/primitives/deprecation.ts
const WARNED = new Set<string>()
export const warnDeprecated = (callsite: string, message: string): void => {
  if (process.env.TSGIT_SUPPRESS_DEPRECATIONS === '1') return
  if (WARNED.has(callsite)) return
  WARNED.add(callsite)
  console.warn(message)
}
```

Call-site is captured from `new Error().stack` (file + line). Warning message
names the replacement API + docs link:

> `[tsgit] walkTree() is deprecated; use repo.snapshot.tree(oid).entries() (see docs/use/snapshots.md). Set TSGIT_SUPPRESS_DEPRECATIONS=1 to silence.`

## Consequences

### Positive

- One nudge per call-site per process — informative, not spammy.
- CI and silent-environment users have a clean opt-out via env var.
- Hard-to-miss for new users invoking the deprecated API by mistake.
- Pattern is reusable for future deprecations across the library.

### Negative

- Set membership grows with the number of distinct call-sites in a process.
  Bounded by source-file count; negligible.
- Browser adapter: `process.env` is undefined; the env-var check defaults to
  "not suppressed". A browser-side polyfill or guard reads `globalThis.process?.env`
  defensively; if undefined, warnings show. Documented in adapter wiring.

### Neutral

- The warning message text is part of the public surface for deprecation cycle.
  Updates to the replacement API must update the message.
- `RUNBOOK.md` documents the env var and its default behavior.
