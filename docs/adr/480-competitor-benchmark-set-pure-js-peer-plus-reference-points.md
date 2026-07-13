# 480 — Competitor benchmark set: isomorphic-git peer + labelled reference points

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/competitor-benchmarks.md · **Supersedes/Refines:** none

## Context

The published head-to-head must be fair and reproducible. The brief scopes it to
"isomorphic-git (and other pure-JS git libraries)," while `performance.md`'s roadmap line
enumerates four competitors: `isomorphic-git`, `simple-git`, `wasm-git`, `nodegit`. Those
two framings conflict — three of the four named are not pure-JS. An empirical install
matrix pinned in an isolated throwaway (`darwin-arm64`, Node 22.22.3) settles it:
isomorphic-git is pure-JS with a JS git API that reads tsgit's on-disk fixture; simple-git
shells out to the native `git` binary (no browser export); wasm-git ships libgit2 compiled
to WASM (contradicting tsgit's "Zero WASM" headline) with an emscripten MEMFS/OPFS virtual
filesystem, not a JS git API; nodegit is native libgit2 bindings that pull twelve
deprecated/vulnerable transitive deps and fail to load once npm's default policy blocks
their install scripts (`MODULE_NOT_FOUND`), so it would break CI's `npm ci`.

## Options considered

1. **isomorphic-git only** — pros: cleanest match to the literal "pure-JS" framing, one
   devDependency, no apples-to-oranges caveats. / cons: drops the "how fast is native git /
   libgit2" reference context a reader legitimately wants.
2. **isomorphic-git peer + simple-git & wasm-git as labelled reference points, nodegit
   excluded** (design recommendation) — pros: honest — the pure-JS peer is compared
   head-to-head, native-git and libgit2-WASM are cited with an explicit apples-to-oranges
   label so the reader gets context without a dishonest peer column; salvages the roadmap's
   intent. / cons: two extra prose measurements to maintain by hand.
3. **All four as peer columns** — pros: superficially "complete." / cons: dishonest — the
   matrix shows native/WASM are not pure-JS peers and nodegit does not install/load; a
   speedup column against the native git binary is meaningless (it *is* git).

## Decision

The **runnable comparison peer is isomorphic-git only** — the sole mature pure-JS git
library, compared head-to-head on the same tsgit-seeded on-disk fixture. **simple-git**
(native `git` binary) and **wasm-git** (libgit2-in-WASM) are **reference points, not
peers**: they are cited as prose numbers with an explicit apples-to-oranges label naming
what they actually measure, never rendered as a speedup column. **nodegit is excluded
outright** — it fails the installability bar (breaks `npm ci` without approving arbitrary
native install scripts) and drags deprecated/vulnerable deps. Any future competitor joins
the *runnable* set only if it is pure-JS-installable in CI without approving native install
scripts and runs deterministically on the shared fixture.

## Consequences

- The **runnable bench set stays at exactly two names** (`tsgit`, `isomorphic-git`), so the
  two-name hard-keying in `test/bench/support/bench-dsl.ts` and `tooling/bench-summarize.ts`
  needs **no change**; reference-point numbers are captured out-of-band and recorded as
  prose. (This is the mechanical consequence adopted for the DSL/summarizer question — no
  N-competitor renderer ships now.)
- `performance.md`'s roadmap line — which names the four competitors as a peer list — is
  **corrected** to name isomorphic-git as the peer plus the labelled reference points; the
  four-name enumeration is empirically wrong to publish as-is.
- Re-including nodegit or wasm-git in the runnable set later requires a fresh ADR clearing
  the installability/purity bar.
- No faithfulness matrix is pinned: a benchmark measures wall-clock time and asserts no
  git-observable behaviour (see [ADR-226](226-git-faithfulness-prime-directive.md)); the
  matrix pinned in the design is a competitor-installability matrix, evidence for this
  decision, not a behaviour pin.
