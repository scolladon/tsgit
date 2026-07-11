# 476 — profiler command registry: read-only + one-shot write commands

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/per-command-profile-capture.md · **Relates:** ADR-475, ADR-477

## Context

`npm run profile <cmd>` must resolve a command name to a representative unit of work
against a scaled fixture, replacing the hardcoded `HOT_PATHS = ['log','status','pack-read']`
triple. Read-only commands (`log`, `status`, `pack-read`, `describe`, `name-rev`, `blame`,
`diff`, `show`, `cat-file`, `rev-parse`) are idempotent-loopable — they can run N times in
place without mutating repo state, which is the premise of N-iteration profiling. Some read
commands additionally need an env-isolated, idempotent `setup(fixture)` preamble against the
shared cache-keyed fixture (the raw medium fixture has no tags, so `describe`/`name-rev`
cannot resolve a target without one — the bench suite already pays this with `tag -f` /
deterministic `commit-tree` preambles).

Write/network commands (`commit`, `add`, `merge`, `clone`, `fetch`, `push`, …) cannot loop
in place — each iteration mutates state or hits the network — so profiling them at all
requires a fresh-repo-per-iteration harness with teardown, whose per-iteration setup cost
is itself on the sampled path.

## Options considered

1. **Read-only registry only** — the idempotent read commands above; write/network
   excluded. No-arg profiles the whole registry; unknown → usage + exit 1. Simplest
   harness, idempotent-loopable throughout. *(design recommendation)*
2. **Read-only registry + one-shot write commands** — additionally profile write commands
   via a fresh-repo-per-iteration scratch factory + teardown (like the `clone-small-repo`
   one-shot bench). Broader coverage of the surface the hot-path work may optimise, at the
   cost of a materially more complex harness whose per-iteration setup pollutes the sample.
3. **Legacy triple as the no-arg default** — smallest diff to today; `<cmd>` opts into the
   wider read set. Leaves most commands unprofilable unless named and splits the meaning of
   `profile` from `profile <cmd>`.

## Decision

Adopt **option 2 — a read-only registry plus one-shot write commands** (user-ratified;
the user chose the broader coverage over the design's read-only-only recommendation,
because the hot-path work should be able to baseline write paths, not just read paths).

Registry structure:

- **Read-only commands** loop `CHILD_ITERATIONS` times in place against a resolved fixture;
  an optional per-command `setup(fixture)` preamble supplies any needed target (tag,
  commit-tree). Any `setup` that spawns `git` MUST be env-isolated (scrub `GIT_*`, pin
  author/committer/date, `GIT_CONFIG_NOSYSTEM=1`) and **idempotent** against the shared
  cache-keyed fixture (`tag -f` / deterministic `commit-tree` — never grow or corrupt the
  cache), exactly as the bench preambles are. This is the only new `git`-invocation surface.
- **Write commands** run one representative unit per iteration against a **fresh scratch
  repo** built (and torn down) each iteration by a scratch-repo factory. The per-iteration
  fresh-repo setup is not the command under measurement; the harness measures the command
  call, and the baseline for a write command names the setup contribution explicitly (via
  the frame filter and/or a documented caveat) so the setup frames are not mistaken for the
  command's own hot shares.
- **No-arg** `npm run profile` profiles the whole registry (superset of today's triple —
  backward compatible in coverage). `npm run profile <cmd>` narrows to one command and
  regenerates that slice for the tight findings loop. An unknown or unprofilable `<cmd>`
  prints `usage: profile <cmd> (one of: …)` and exits 1 — never a silent no-op.

## Consequences

- The harness gains a scratch-repo factory + per-iteration teardown for write commands,
  on top of the read-only in-place loop — a materially larger tool than the read-only-only
  path, which drives a design revision before planning (the design recommended, and was
  scoped around, read-only only).
- Write-command baselines carry a measurement caveat: fresh-repo setup is on the sampled
  path. The frame filter (ADR-475) drops non-tsgit frames, but tsgit's own setup work
  (repo init/object writes) can appear in a write command's shares; the baseline documents
  which frames are setup vs the command proper, so the hot-path work reads a clean signal.
- The registry is explicit and documented; adding/removing a command is a registry edit,
  and a command with no clean idempotent preamble (read) or no representative one-shot form
  (write) is simply omitted rather than half-supported.
- Network commands (`clone`/`fetch`/`push`) remain out — they need a live remote and are
  not deterministically loopable; they are not part of this registry.
