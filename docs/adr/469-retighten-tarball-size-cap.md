# 469 — re-tighten the tarball size cap to 550 KiB

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/bundle-size-optimization.md · **Relates:** ADR-468

## Context

`tooling/verify-tarball.sh` enforces a compressed-tarball cap. It was relaxed 10×
to `7680 * 1024` (~7.5 MiB) as a generous temporary ceiling when the v2 feature
set grew the tarball, with a comment deferring the re-tightening to a later perf
pass. With source maps removed (ADR-468), the tarball projects to ~489 KiB
(`gzip -9` on the exact no-maps file set), so the temporary ceiling is now ~15×
looser than the real artefact and no longer a meaningful guard.

The honest floor while shipping a **dual ESM+CJS** package is code + types
≈ 482 KiB compressed — both are structurally required (dropping CJS or `.d.cts`
is a breaking change). The old ~220 KiB v1 floor is therefore **unreachable**:
v1 was smaller because it shipped fewer commands, not less redundancy. The cap
must be set against the real floor, not the nostalgic one.

## Options considered

Method: measure the post-optimization `npm pack`, set `cap = measured × ~1.1–1.15`
headroom, round to a clean KiB boundary.

1. **512 KiB (524 288 bytes)** — only ~4.7% over the ~489 KiB projected pack. Too
   tight; a single new command could bust it and force another cap bump.
2. **550 KiB (563 200 bytes)** — ~12% headroom; absorbs a few commits of growth
   before firing; still a 13.6× tightening from 7680 KiB. *(design recommendation)*
3. **600 KiB (614 400 bytes)** — ~23% headroom; safer buffer but loose enough that
   small regressions slip under it.

## Decision

Set `SIZE_CAP` to **550 KiB (563 200 bytes)** (user-ratified; matches the design
recommendation), **contingent on the real post-ADR-468 `npm pack` measuring
≤ ~500 KiB**. At implement time the real pack is re-measured; if it lands higher
than the ~489 KiB projection, the cap is scaled by the same 1.1–1.15 rule and the
number is reconciled (the 550 KiB target holds as long as the real pack is
≤ ~500 KiB).

The `SIZE_CAP` comment is rewritten to explain the cap against the real
dual-format floor and carries **no** backlog/phase/ADR reference (repo rule: no
provenance refs in code — the commit and PR body are the join point).

## Consequences

- The cap is a real guard again — a ~13.6× tightening that leaves ~12% headroom
  for near-term growth.
- The comment states the honest floor (~482 KiB, dual ESM+CJS) so a future reader
  sets the next cap against reality, not the unreachable ~220 KiB v1 number.
- The cap number is reconciled to the measured `npm pack` during implementation;
  the value here is the target, the measurement is the authority.
