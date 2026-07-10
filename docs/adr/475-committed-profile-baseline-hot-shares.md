# 475 — committed per-command profile baseline: normalised hot-function shares in docs/perf/

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/per-command-profile-capture.md · **Relates:** ADR-476, ADR-477

## Context

`npm run profile` today captures V8 CPU digests to `reports/profiles/*.txt` — git-ignored
and host-specific. The per-command profile item must **commit** a baseline the downstream
perf work builds on: the findings-driven hot-path work reads it as its optimisation
license (no speculative work), and the future CI regression gate diffs a fresh capture
against it within ±N% per scenario.

The load-bearing constraint, pinned empirically in a `mktemp` throwaway: a
`node --prof-process` digest is irreducibly host-specific — absolute tick counts vary with
CPU speed and sampling luck, shared-library + unaccounted noise dominates the low-sample
signal, and the digest embeds absolute home paths. So a committed baseline **cannot** be a
raw digest, a raw `bench-summarize` table, or a `snapshot.json` of absolute ms. It must be
a normalised, deterministic, structured extract, with any machine banner recorded as
metadata rather than as the compared value.

`.gitignore` ignores `reports/*` with the single exception `!reports/api.json`, so any
committed artifact needs either its own `!reports/…` exception line or a path outside
`reports/`.

## Options considered

**Content:**

1. **Normalised hot-function self-shares only** — parse the `--prof-process` digest into a
   `{ frame → self% }` map filtered to *tsgit's own* frames (drop shared-library /
   unaccounted / node-internal noise), self-normalised over the tsgit surface. Portable in
   rank/share across machines (that is exactly why shares, not ticks); directly actionable
   by the hot-path work ("frame X is 41 % of `log` → optimise it"). Absolute timing stays
   in the existing non-committed nightly/snapshot pipeline. *(design recommendation)*
2. **Shares + normalised wall-clock ratio** — additionally commit a per-command normalised
   timing ratio. Richer, but doubles the artifact and forces the regression gate to choose
   which metric trips it; timing carries the ±20 % runner variance `bench-summarize`
   itself warns about.
3. **Normalised timing only** — reuse `bench-summarize`'s ratio machinery, no digest
   parser. Simpler to build, but a coarser findings signal and the least-portable
   underlying measurement.

**Location:**

- **`docs/perf/` outside `reports/`** (e.g. `docs/perf/baseline.json` + sibling markdown)
  — no `.gitignore` surgery; reads as a deliberate, reviewed in-tree artifact.
  *(design recommendation)*
- **`!reports/perf-baseline.json` exception** — co-locates with other perf artifacts but
  sits inside the ignored noise zone; mirrors the `!reports/api.json` precedent.

## Decision

Adopt **option 1 (hot-function self-shares only)** committed to **`docs/perf/`** outside
`reports/`, as a structured JSON (`docs/perf/baseline.json`) plus a sibling human-readable
markdown, mirroring the 26.6 `memory.{json,md}` pair (user-ratified — the user chose the
shares-only content and the `docs/perf/` location, both as recommended, over the
timing-bearing and `reports/`-exception alternatives).

Shape: per command, the normalised tsgit-frame self-shares, with the machine banner
(`platform-arch`, Node version, CPU model) recorded as **metadata, never as a compared
value**:

```
{
  "generatedOn": "<platform-arch> / node vX / <CPU>",   // metadata, NOT compared
  "commands": {
    "log":    { "hotShares": [ { "frame": "walkCommitsByDate", "self": 0.41 }, … ] },
    "status": { "hotShares": [ … ] }, …
  }
}
```

Absolute ticks/ms are deliberately excluded (non-portable per the pin). The hot-path work
reads the top frames; the regression gate diffs `self` shares per frame within a ±N% band.

## Consequences

- The committed baseline survives a machine change: it is self-relative shares, not
  absolute measurements. Determinism is asserted in *shape* (frame set + share ordering),
  not in absolute value.
- A robust digest parser is required (the `--prof-process` bottom-up / summary sections),
  filtering to tsgit frames off the shared-library/unaccounted noise floor — the one new
  parsing surface.
- No `.gitignore` change: the artifact lives outside `reports/`.
- Committed timing is explicitly *not* provided here; if a future item wants a committed
  timing signal it extends this artifact rather than re-deriving portability.
- A trivially fast command whose digest shows no tsgit frame above the noise floor records
  an empty/short `hotShares` with a warning, never fabricated shares — a signal that the
  command may not belong in the registry (see ADR-476).
