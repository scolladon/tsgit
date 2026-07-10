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
recommendation). The original ratification was contingent on the real post-ADR-468
`npm pack` measuring ≤ ~500 KiB, with a 1.1–1.15 scaling fallback if it landed
higher. At implement time the real pack measured **503.5 KiB (515 591 bytes)** —
marginally (0.7%) above the ~500 KiB threshold, which would scale the cap to
~576 KiB. Presented with that measurement, the user **elected to hold 550 KiB**
(9.2% headroom over the real pack) rather than loosen to the scaled value,
prioritising a tighter cap consistent with the "smallest dist" principle over the
extra buffer. 550 KiB still passes (515 591 < 563 200) and remains a 13.6×
tightening from the 7680 KiB temporary ceiling.

The `SIZE_CAP` comment is rewritten to explain the cap against the real
dual-format floor and carries **no** backlog/phase/ADR reference (repo rule: no
provenance refs in code — the commit and PR body are the join point).

The `SIZE_CAP` comment is rewritten to explain the cap against the real
dual-format floor and carries **no** backlog/phase/ADR reference (repo rule: no
provenance refs in code — the commit and PR body are the join point).

## Consequences

- The cap is a real guard again — a ~13.6× tightening that leaves ~9.2% headroom
  over the measured 503.5 KiB pack.
- The comment states the honest floor (~482 KiB, dual ESM+CJS) so a future reader
  sets the next cap against reality, not the unreachable ~220 KiB v1 number.
- The ~9.2% headroom is deliberately below the 1.1 scaling floor: a future change
  that adds ~47 KiB compressed will fire the guard and prompt a considered cap
  review rather than an automatic loosening — the tight-by-choice posture.
