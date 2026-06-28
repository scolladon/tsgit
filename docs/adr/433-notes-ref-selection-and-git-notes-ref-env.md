# 433 — notes-ref selection honors GIT_NOTES_REF via a new Context env capability

- **Status:** accepted
- **Date:** 2026-06-28
- **Design:** docs/design/notes.md · **Relates:** ADR-226 (git-faithfulness), ADR-431 (notes surface)
- **Decision class:** D-architecture (user judgment)

## Context

git selects the notes ref by precedence: an explicit argument, then the `GIT_NOTES_REF`
environment variable, then `core.notesRef` (config), then the default `refs/notes/commits`.
tsgit can already read git config, but its `Context` exposes **no environment accessor** today,
and the library is browser-portable (where process env is absent). Honouring `GIT_NOTES_REF`
therefore is not a free add — it requires widening a port surface.

## Options considered

1. **Explicit `ref` param + `core.notesRef`** — default + optional per-verb `ref` + config.
   Matches git's config behaviour with no new infra; `GIT_NOTES_REF` left unsupported (a
   documented divergence).
2. **Explicit `ref` param only** — caller passes the ref; ignore config and env. Most minimal;
   diverges from git's config + env behaviour.
3. **Also honor `GIT_NOTES_REF`** *(user choice)* — full git precedence; requires a new env
   capability on `Context`.

## Decision

**Option 3, ratified by the user.** Notes-ref precedence is **explicit `ref` arg → `GIT_NOTES_REF`
→ `core.notesRef` → `refs/notes/commits`**, matching git exactly.

This introduces a minimal **environment-read capability** on `Context` (a port): a narrow
accessor returning a single named env var (or undefined), implemented by the Node adapter from
`process.env`, and stubbed to "absent" by the browser and in-memory adapters (where there is no
process environment). The capability is scoped to what notes-ref selection needs — not a general
env bag — so the new port surface stays small and the browser portability invariant holds
(env is simply always-absent there, a faithful "unset" result).

A given `ref` (from any precedence source) is validated as a ref name before use; an invalid
value refuses with the existing ref-name validation error.

## Consequences

### Positive
- Full git-faithful notes-ref selection, including the env override real users rely on.
- The env capability is reusable by any later command that needs a specific env var, added once
  here behind a clean port.

### Negative
- A new port + three adapter implementations (node real, browser/in-memory stub) — more surface
  than options 1–2, and a new capability the architecture pass should sanity-check for minimality.

### Neutral
- On browser/in-memory adapters `GIT_NOTES_REF` is always unset, so precedence falls through to
  `core.notesRef`/default there — the faithful outcome for an environment with no process env.
