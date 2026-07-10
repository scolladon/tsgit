# 478 — write-command setup/command frame separation via parser denylist + setupShares

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/per-command-profile-capture.md · **Relates:** ADR-475, ADR-476

## Context

ADR-476 admits one-shot write commands (`commit`, `add`, `merge`) to the profiler registry,
each profiled against a fresh scratch repo built per iteration. It requires that a write
command's baseline "name the setup contribution explicitly … so the setup frames are not
mistaken for the command's own hot shares" — but names the *goal*, not the *mechanism*.
`node --prof` samples the whole child process, so the per-iteration fresh-repo build frames
land in the digest alongside the command under measurement. The mechanism that separates
them was surfaced as a new decision candidate by the write-command design revision.

## Options considered

1. **Parser partition via an explicit setup-frame denylist + a `setupShares` block in the
   committed artifact.** The `--prof-process` digest parser splits tsgit's own frames into
   `command` vs `setup` using a small, named denylist of the primitives the scratch build
   calls (`init`, index/blob/tree write on the build path — frames reached only through
   `build`, never through the command under measurement). Frames genuinely shared between
   build and command are attributed to `command` (conservative — never under-report the
   command's cost). The baseline records the command partition as `hotShares` and the setup
   partition as a sibling `setupShares` block. *(design recommendation)*
2. **Documented caveat only** — commit the raw combined `hotShares` and note in the markdown
   which top frames are setup. Simplest, but leaves the hot-path work to eyeball the split —
   exactly the ambiguity ADR-476 asked to remove.
3. **Separate setup-only calibration pass** — run the scratch build *without* the command
   under `--prof`, subtract its shares from the combined run. Most "accurate" in principle,
   but subtraction across two noisy low-sample runs is not stable (absolute ticks vary
   run-to-run per the ADR-475 pin), and it fabricates a derived number rather than reporting
   honest shares.

## Decision

**Adopted as recommended (no user judgment):** option 1 — a parser partition via an explicit
setup-frame denylist, with write-command baselines carrying a `setupShares` block alongside
`hotShares`. This is the only mechanism consistent with ADR-476's ratified goal, and the
alternatives are inferior for stated technical reasons, not for a user-judgment trade-off:
(2) ships a knowingly-ambiguous artifact (the gap ADR-476 exists to close); (3) is unstable
across low-sample runs and fabricates a subtracted number. The choice is therefore taken as
recommended rather than escalated.

Structurally, the harness also keeps setup and teardown off the sampled path where it can
(the sampled loop calls only the command; per-iteration teardown is deferred out of the loop
body, mirroring `clone-small-repo.bench.ts`), and runs a few untracked warm-up iterations to
stabilise JIT tiering — but because `--prof` samples the whole process, the parser denylist
is the *real* separator; the structural layers are supporting, not sufficient.

## Consequences

- The digest parser (`tooling/profile-digest.ts`) gains a small named `SETUP_FRAMES`
  denylist and a `command`/`setup` partition step for `kind: 'write'` workloads; read
  workloads are unaffected (they carry `hotShares` only).
- The committed baseline schema gains an optional `setupShares` array on write-command
  entries — documented, never merged into `hotShares`. The hot-path work reads `hotShares`
  (the clean command signal); `setupShares` is provenance, ignored by the regression gate.
- Shared frames (e.g. an object-write reached by both the build and the command) resolve to
  `command`, so the command's cost is never *under*-reported; the baseline markdown notes
  the shared frames per write command so the conservative attribution is auditable.
- The denylist is a reviewed constant, not a heuristic — adding a future write command
  (`checkout`/`reset`/…) is a registry edit + a `build<Cmd>Scratch` helper + a denylist
  extension.
