# 477 — per-command profiler extends tooling/profile.ts; tooling-only, no library surface change

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/per-command-profile-capture.md · **Relates:** ADR-475, ADR-476

## Context

Two secondary choices sit under the per-command profile item: *where the tool lives*, and
*whether any of this touches the library's command surface or git-observable behaviour*.
Both had a single clear recommendation aligned with existing practice — captured here as
adopted-as-recommended so the decision trail is complete, with no user judgment invoked.

## Options considered

**Where the tool lives:**

1. **Extend `tooling/profile.ts` in place** — it already owns the `--prof`/`--prof-process`
   capture, the parent/child spawn, the `dist/`-import (a strip-only runtime cannot resolve
   `src/**`'s `.js`-suffixed specifiers nor parse parameter-property constructors), and the
   fixture graceful-degrade. The per-command generalisation is a registry swap + a digest
   parser + a baseline writer. *(design recommendation)*
2. **New `tooling/profile-baseline.ts`** — cleaner capture-vs-emission split, but duplicates
   the spawn / `dist`-import / fixture scaffolding (or forces extracting it first).
3. **Fold into `bench-summarize.ts`** — rejected: that script only knows wall-clock ms and
   keys on the `tsgit`/`isomorphic-git` bench names; CPU hot-shares are a different signal
   (26.6 kept `bench-memory.ts` separate for exactly this reason).

**Library-surface impact:**

- Tooling-only, or does anything touch the command surface / git-observable behaviour?

## Decision

**Adopted as recommended (no user judgment):**

- **Extend `tooling/profile.ts` in place** (option 1). Smallest surface, zero duplication,
  reuses every already-proven idiom. Aligns with DRY/KISS and the 26.6 precedent. Pure
  helpers (arg/command resolution, the digest parser, the baseline writer) are extracted
  into small sibling modules under `tooling/` to keep each file small (the file is ~150
  lines today and the additions are substantial), consistent with the many-small-files
  coding style; those helpers may carry optional, ungated `tooling/test/unit` tests, but
  nothing gates them (`tooling/**` is outside the coverage `include`, as `profile.ts` is
  today).

- **Tooling-only — ADR-249 (structured output) and ADR-226 (git-faithfulness) are
  confirmed unaffected.** No command gains a rendering/perf option; the profiler drives the
  existing structured `openRepository` API and asserts no git-observable behaviour, so no
  faithfulness matrix and no interop test are pinned. The only residual `git`-invocation
  surface is the read-command `setup` preamble and the write-command scratch-repo factory
  (ADR-476), which carry an **env-isolation** obligation (scrub `GIT_*`, pinned dates,
  `GIT_CONFIG_NOSYSTEM=1`, idempotent against the shared cache), not a faithfulness pin —
  they assert no git output.

## Consequences

- `tooling/profile.ts` remains the single profiler entry point; the `npm run profile`
  script is unchanged in shape (`npm run build && node --experimental-strip-types
  tooling/profile.ts [<cmd>]`).
- No `src/` change, no public API change, no `api.json`/README count change, no interop or
  parity test — this item cannot regress the library surface.
- The digest parser and command registry, if extracted as pure helpers, are the natural
  place for optional unit coverage; profile numbers themselves are host-specific artefacts,
  not assertable SUTs.
