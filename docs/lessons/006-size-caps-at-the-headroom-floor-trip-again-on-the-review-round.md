---
subjects:
  - .size-limit.json
  - tooling/verify-tarball.sh
  - docs/design/bundle-size-optimization.md
phases: [implementation, review, validation]
kind: gotcha
trigger: check:size is red on a branch whose caps were already raised earlier on the same branch
evidence:
  - .size-limit.json
  - docs/design/bundle-size-optimization.md
  - tooling/verify-tarball.sh
source: { run: gc-size-lying-loose-blob, phase: review, date: 2026-10-21 }
status: active
supersedes: []
last-verified: 2026-10-23
---
# 006 — Size caps at the headroom floor trip again on the review round

## Context

The size caps are raised by convention to the measurement rounded up to the next 0.1 kB, which
leaves 3 to 40 bytes of headroom. The feature crossed four caps and the user approved a raise;
the review round then added two small helpers (+155 B gzip on the full library) and crossed
three caps a second time within two hours, costing a second approval. A stale `dist/` can fake
the same red by hundreds of kilobytes, so the first question is always whether the build is
clean.

## Lesson

With the headroom the convention leaves, any code a review round adds will cross a cap again.
The raise belongs after the review round, in one approval that lists every failing row, unless
the feature is already over by far more than a review round can add. A clean build
(`rm -rf dist .wireit`) is the measurement; a `main` baseline built the same way attributes the
delta.

## How to apply

Before any cap question, rebuild from a clean `dist/` and `.wireit`, and measure `main` the same way.
Raise once, after the review round converges, unless the feature is over by hundreds of bytes.
List every failing row in the one question; expect ~50 B gzip per small helper and ~30 B per error-union member.
Record each raise in the design's raise section and the tarball cap's comment, with the attribution.

## Evidence

`.size-limit.json` — the rows raised twice on this branch.
`docs/design/bundle-size-optimization.md` — the two raise blocks of the gc size-lying change.
`tooling/verify-tarball.sh` — the cap block's attribution lines.
`docs/design/bundle-size-optimization.md` — the pathspec-glob-dialect raises: a plan part raised the caps before the review round, and the review fixes crossed three rows again by 26–47 B ("Size-limit raise — the embedded-repository review fixes").
