# Design — Rebuild the bench suite around hot paths

> Brief (backlog 27.4): "Perf — rebuild bench suite around hot paths. Hot-path
> list is NOT pre-frozen; it's derived from the Phase 26 perf-pass output. Once
> that list lands as an ADR, hot paths get small / medium / large fixtures;
> non-hot paths keep medium only. Bench gating only on hot paths."
> Status: draft → self-reviewed ×3 → **decision candidates open** (awaiting the
> ADR conversation).

This item confronts one central tension, stated up front so the rest of the doc
can resolve it: **the committed Phase-26 baseline (`docs/perf/baseline.json`) is
per-command *self-shares*, normalised *within* each command (they sum to ≈1 per
command) and deliberately *not* absolute wall-clock (ADR-475). So you cannot rank
operations against each other by comparing shares across commands** — a 0.30
`<anonymous>` share in `commit` and a 0.16 `exists` share in `log` say nothing
about which command is *slower*. Yet the brief asks for a cross-command "hottest
operations" list. The only cross-comparable absolute timing lives in the
**non-committed nightly bench artifact** (ADR-483). §"The crux" pins how a
defensible hot-path list is derived given that split; the picking methodology is
DC-1 (the user ratifies).

This is a **bench-suite + CI/tooling** feature. It adds **no** library or command
surface, and — per §Faithfulness — pins **no** git-observable behaviour.

## Context

### The current bench suite (read in full from the worktree)

`test/bench/` holds **11 `*.bench.ts` files** with an **ad-hoc, inconsistent**
size scheme — designing a consistent one is the core of this item. Verified
inventory (file → fixture → operation → competitor baseline):

| Bench file | Fixture (source) | Size today | Operation | iso-git baseline |
|---|---|---|---|---|
| `log.bench.ts` | `setupSmallRepo(50)` (`fixtures.ts`) | small, **loose** | `log` | yes |
| `log-scale.bench.ts` | `resolveScaledContext()` | medium / large | `log` | yes |
| `status.bench.ts` | `setupSmallRepo(50)` ×2 (clean + dirty-25) | small, **loose** | `status` | yes |
| `status-scale.bench.ts` | `resolveScaledContext()` | medium / large | `status` | yes |
| `read-blob.bench.ts` | `setupSmallRepo(50)` (cold + warm) | small, **loose** | `readBlob` | yes |
| `pack-read-scale.bench.ts` | `resolveScaledContext()` (cold + warm + large-spread) | medium / large | `readBlob` (pack) | yes |
| `delta-chain-read.bench.ts` | `DELTA_CHAIN_FIXTURE` (300-commit evolving) | delta-chain shape | `readBlob` (deep chain) | yes |
| `describe.bench.ts` | `resolveScaledContext()` + `git tag` preamble | medium | `describe` | tsgit-only |
| `name-rev.bench.ts` | `resolveScaledContext()` + `git commit-tree` preamble | medium | `nameRev` | tsgit-only |
| `blame-deep-ancestry.bench.ts` | `setupDeepAncestryRepo(200)` (`fixtures.ts`) | deep-ancestry shape | `blame` | tsgit-only |
| `clone-small-repo.bench.ts` | server-backed 5-commit `source.git` | small, network | `clone` | yes |

Three **incoherences** this item must resolve:

1. **No small/medium/large taxonomy.** "Small" means two different things —
   `setupSmallRepo` (50 commits, **loose** objects, tmpdir-per-run) *and*
   `setupDeepAncestryRepo` (200 commits, one stable + one churn file). "Medium/
   large" come from a *separate* generator (`fixture-generator.ts`,
   `MEDIUM_FIXTURE` = 5k commits / 20k blobs / ~50 MB **packed**; `LARGE_FIXTURE`
   = 50k / 200k / ~500 MB, env-gated `TSGIT_BENCH_LARGE`). So today "small" is
   loose + tmpdir, "medium/large" is packed + cached — **storage shape and size
   both vary**, which is exactly what a clean tier taxonomy must not do.
2. **The `-scale` split.** `log`/`status`/`readBlob` each have **two** files (a
   small `*.bench.ts` + a `*-scale.bench.ts`). One operation, two files, two
   fixtures.
3. **Shape ≠ size.** `blame` needs a *deep-ancestry* shape; `delta-chain-read`
   needs an *evolving-delta* shape; `describe`/`name-rev` need a *tag* preamble.
   These shapes are **orthogonal** to the size tier and must survive the rework.

### Operations benched vs profiled

- **Benched today (7 operations):** `log`, `status`, `readBlob`/`pack-read`,
  `blame`, `describe`, `name-rev`, `clone`.
- **Profiled in the Phase-26 baseline (13 commands, `baseline.json`):** `log`,
  `status`, `pack-read`, `describe`, `name-rev`, `rev-parse`, `cat-file`,
  `show`, `diff`, `blame`, `commit`, `add`, `merge`.
- **Profiled but NOT benched (7):** `rev-parse`, `cat-file`, `show`, `diff`
  (reads) + `commit`, `add`, `merge` (writes). (`clone` is benched but *not*
  profiled — it is network-bound, deliberately excluded from the CPU-share
  profiler per ADR-476.)

### What Phase 26 empirically optimised (the "revealed hot paths")

Phase 26 did not just measure — it *acted* on the measurements. The operations it
spent optimisation effort on (each justified at the time by absolute wall-clock
evidence from the nightly artifact) are the strongest empirical hot-path signal:

- **26.4** → `log` + `status` (`checkContainment` gate + `parentRealpath` cache).
- **26.4a** → `describe` (early-termination).
- **26.4b** → `name-rev` (date cutoff).
- **26.4c** → `blame` (TREESAME) + `log` (tree-walk / `lookupPackIndex`).
- The profiler's original hardcoded `HOT_PATHS` triple → `log`, `status`,
  `pack-read`.

Union: **{ `log`, `status`, `pack-read`, `blame`, `describe`, `name-rev` }** — and
these are *exactly* the operations the bench suite already tiers or shape-covers.
That convergence is the backbone of the DC-1 recommendation.

### The current regression gate (the surface DC-5 narrows)

- **`tooling/bench-check.ts`** — exports the pure `compareToBaseline(base,
  current, policy)` and `gatedEntries(entries)`, which today filters to entries
  whose key ends `" > tsgit"` (`TSGIT_KEY_SUFFIX`, ADR-490). `DEFAULT_THRESHOLD_PCT
  = 10`. `main()` takes two `raw.json` argv paths, flattens both via
  `toSnapshotEntries`, gates, compares, emits a table + PR comment, exits non-zero
  on a flagged regression. Unit-tested in `tooling/test/unit/bench-check.test.ts`
  (runs in `test:unit`, coverage-excluded).
- **`tooling/bench-to-snapshot.ts`** — `toSnapshotEntries(raw)` flattens every
  `(group, bench)` pair into `{ name: '<group.fullName> > <bench.name>', unit:
  'ms', value: median ?? mean }`. `group.fullName` is
  **`<relative-bench-file-path> > <full describe title>`** (empirically pinned in
  `bench-regression-gate.md` §Context) — so **the bench-file path is embedded in
  every gate key**, which is what makes a file-basename-keyed hot-path filter
  possible (§D5).
- **`.github/workflows/ci.yml` → `benchmark-compare`** (PR, `continue-on-error:
  true`): checks out base, `build + test:bench → /tmp/base-bench.json`; checks out
  head, `build + test:bench → /tmp/pr-bench.json`; runs `node … bench-check.ts
  /tmp/base-bench.json /tmp/pr-bench.json` with `REGRESSION_THRESHOLD: "10"`.
  Runs `test:bench` with `TSGIT_BENCH_LARGE` **unset**, so it builds **small +
  medium** fixtures (not large). ADR-490 scopes the gate to `tsgit`-named
  entries; **27.4 narrows it further to hot-path benches only** (§D5).

### Governing prior art (read, not summarised from memory)

- **ADR-475** — committed baseline = normalised hot-function **self-shares** in
  `docs/perf/`; **intra-command, not cross-comparable**; absolute ticks/ms
  deliberately excluded. *This is the tension DC-1 resolves.*
- **ADR-483** — benchmarks are ±20 % noisy on GHA runners; a personal host is
  load-biased; **the CI nightly (`bench.yml`) is the clean absolute reference**;
  cross-environment comparison is the uncitable case. *The nightly is the only
  cross-command absolute-timing source.*
- **ADR-486** — same-host before/after ratio is load-independent; the profile
  baseline is a documentation artifact with **no CI gate**.
- **ADRs 487–491** — the regression gate: same-runner base-vs-PR (487), advisory/
  non-blocking (488), median-ms asymmetric global-N (489), **scope = `tsgit`-named
  benches** (490), extracted pure `compareToBaseline` (491). **ADR-490 explicitly
  rejected a hand-maintained allow-list on the iso-git axis** — DC-5 must argue
  why a hot-path registry on *our own* axis is a different smell.
- **ADRs 471–474** (`memory-pressure-bench-scenarios.md`) + `fixture-generator.ts`
  — the deterministic scaled-fixture generator (`FixtureSpec`, `MEDIUM_FIXTURE`,
  `LARGE_FIXTURE`, `DELTA_CHAIN_FIXTURE`, `ensureScaledFixture`), version-keyed
  cache, `gitEnv()` scrub idiom. The taxonomy (D2) extends this, not `fixtures.ts`.
- **`per-command-profile-capture.md`** (26.3) — produced `baseline.json`; its
  house-style crux/DC layout is the template this doc follows.

## The crux — ranking "hottest operations" when the committed baseline can't cross-rank

The brief wants a *cross-command* hot-operation list. The committed evidence
(`baseline.json`) is *intra-command* shares. These are different questions, and
conflating them is the trap this section defuses.

**What the self-shares *can* and *cannot* say (ADR-475, verified against the
committed `baseline.json`):**

- They **can** answer *"within `status`, which frame dominates?"* → `containmentVerdict`
  0.17, `lstat` 0.10, … (they sum to ≈1 over `status`'s own surface). This is the
  drill-down the 26.4-style optimisation work consumes.
- They **cannot** answer *"is `status` slower than `log`?"* — both tables sum to
  ≈1 regardless of absolute cost. A command that runs in 2 ms and one that runs in
  2 s can have identical share tables. **Cross-command ranking from shares is
  meaningless**, and any methodology that ranks operations by comparing their
  committed shares is unsound.

**Where cross-command absolute timing *does* live:** only in the **nightly bench
artifact** (`bench.yml`, ADR-483) — median-ms per scenario on a clean dedicated
runner. It is **not committed** (host/run-specific), and it **only times operations
that have a bench** (the un-benched profiled commands — `commit`/`add`/`merge`/
`show`/`diff`/`cat-file`/`rev-parse` — have *no* absolute timing anywhere, only
self-shares).

**Three consequences that shape every downstream decision:**

1. The hot-path ranker **must** be absolute wall-clock (nightly), never shares.
2. Only **benched** operations can be ranked, so the hot set is a subset of the
   benched set. An un-benched profiled command is "non-hot by absence of evidence"
   — nobody has measured it slow — and gets a medium-only bench (§D4), not a
   hot-path tiering.
3. Because the ranker (nightly) is ephemeral, the list must be **frozen into the
   ADR** with the snapshot it was derived from, and **re-derived each major
   version** (DC-1 cadence) from that version's nightly artifact — not drifted
   silently.

Cross-checking the nightly ranking against **Phase 26's revealed optimisation
effort** (the 26.4* ADRs) lands the same six operations (§Context), which is the
independent corroboration that makes the initial list defensible rather than a
single ephemeral measurement.

> Isolation note: this section reasons from committed artifacts (`baseline.json`)
> and code already in the tree — it ran **no** state-mutating probe. The one
> place a throwaway probe would apply (re-running the nightly to snapshot the
> absolute ranking) is deferred to the ADR conversation, and when run must live in
> a `mktemp` throwaway per the injected contract, never the worktree.

## Requirements

When this ships:

1. A **hot-path operation list** is derived from Phase-26 output by a documented,
   defensible methodology (DC-1) that uses absolute nightly timing as the ranker —
   never cross-command self-shares — and names its refresh cadence.
2. The list is **committed as a single reviewable source** (a registry) that both
   the fixture-tiering and the gate read, so the two cannot drift.
3. A **consistent small / medium / large size taxonomy** is defined with concrete
   commit/blob counts, generated by **one** generator, varying **only size** (not
   storage shape) between tiers, and accommodating the shape axes
   (multi-file / deep-ancestry / evolving-delta) orthogonally (DC-3).
4. **Hot-path operations run at all three size tiers**; the `-scale` two-file
   split collapses to **one tiered file per hot operation**.
5. **Non-hot operations keep medium only** (DC-4); the un-benched profiled reads
   gain medium coverage per DC-4's ratified scope.
6. **`bench:check` gates only hot-path benches** (DC-5), narrowing the existing
   `> tsgit` filter, without reintroducing the hand-maintained-allow-list smell
   ADR-490 rejected — and gating a stable tier, not the sub-ms small tier.
7. The gate-scoping logic is **pure and unit-tested** (extends
   `bench-check.test.ts`); benches themselves are validated by **running**
   `test:bench` green.
8. **No library/command surface change**; **no faithfulness matrix** (§Faithfulness).
9. The nightly (`bench.yml`), the `benchmark-snapshot` trend job, and `gh-pages`
   are **untouched** except where a bench file is renamed or re-tiered.

## Design

The sections describe the shape **as the DCs would resolve on the recommendation**;
each open fork is called out and deferred to the ADR conversation.

### D1 — Hot-path list + the registry (DC-1, DC-2)

**Derivation (DC-1 recommendation).** Rank the **benched** operations by absolute
median-ms from the **nightly `bench.yml` artifact** at freeze time; take the
operations above a documented floor; cross-check against Phase 26's revealed
optimisation effort (26.4*). The initial frozen list is expected to be:

```
hot = [ "log", "status", "pack-read", "blame", "describe", "name-rev" ]
```

The **self-shares are explicitly not the ranker** — they remain the *within-command
drill-down* the 26.4-style work consumes. **Cadence:** re-derive each major version
from that version's nightly artifact; the ADR records the snapshot used.

**Granularity (DC-2 recommendation): per-command operation.** The registry is a
set of **operation names** (`log`, `status`, …), matching `baseline.json`'s keying
and how a caller invokes the library. Per-*primitive* is rejected — the hot frames
(`checkContainment`, `isContainedInEitherRoot`) are cross-cutting across
`log`/`status`/`describe`/`name-rev`/`blame` and map to no single bench;
per-*scenario* is rejected as duplicative (an operation has cold/warm/clean/dirty
scenarios that share one hotness verdict).

**The registry — single source of truth.** A committed
**`docs/perf/hot-paths.json`**, beside `baseline.json` in the already-tracked
`docs/perf/` tree (no `.gitignore` surgery — verified `docs/perf/` is not ignored):

```
{
  "generatedFrom": "nightly bench.yml artifact <run-id/date>",   // provenance, not compared
  "majorVersion": "<current major, for the per-major-version refresh cadence>",
  "hotOperations": ["log", "status", "pack-read", "blame", "describe", "name-rev"]
}
```

Both consumers read this one file: the **gate** (`bench-check.ts`, via `fs`) and a
**consistency check** (§Test strategy) that asserts the registry ⟷ the tiered
bench files agree. Keeping the operation↔bench-file mapping by **file basename**
(`log.bench.ts` → `log`) means the gate needs only the registry + the key's
embedded file path (§D5), no second mapping table.

### D2 — Size taxonomy (DC-3): one generator, size-only variation, shape orthogonal

**Three size points**, defined as commit/blob counts, generated by the **one**
`fixture-generator.ts` (extend `FixtureSpec`, do **not** add a parallel path in
`fixtures.ts`):

| Tier | commits | blobs | ~size | storage | runs in |
|---|---|---|---|---|---|
| **small** | ~50 | ~200 | <1 MB | **packed** | every run + PR gate |
| **medium** | 5 000 | 20 000 | ~50 MB | packed | nightly + PR gate |
| **large** | 50 000 | 200 000 | ~500 MB | packed | `TSGIT_BENCH_LARGE` (nightly/manual) |

`medium` and `large` are today's `MEDIUM_FIXTURE`/`LARGE_FIXTURE` **unchanged**.
The **new work is a first-class `SMALL_FIXTURE` in the scaled generator** so all
three tiers share one topology and cache mechanism, isolating *size* as the only
variable. This is the deliberate departure from today's loose-tmpdir `setupSmallRepo`.

**Small-tier storage-shape sub-choice (folded into DC-3).** Today's small benches
read **loose** objects; medium/large read **packed**. Making `SMALL_FIXTURE`
packed makes the tiers differ only in size (the point of tiering) but **drops the
loose-object read path** the current `read-blob.bench.ts` cold scenario exercises.
Recommendation: `SMALL_FIXTURE` is **packed** (size-only tiering) and the
loose-object read path is preserved as **one explicitly-named non-tiered
micro-scenario** (a fresh small loose repo), so no coverage is silently lost. The
ADR ratifies whether the loose micro-scenario is retained or dropped.

**Shape axis stays orthogonal.** A hot operation is tiered **in its representative
shape**: `log`/`status`/`pack-read` use the plain multi-file shape; `blame` uses
the **deep-ancestry** shape; `describe`/`name-rev` use the multi-file shape **plus
their `git` tag/`commit-tree` preamble**. So "small/medium/large" scales the
commit/blob *count* within whichever shape the operation needs. Concretely,
`FixtureSpec` gains a `size: 'small' | 'medium' | 'large'` dimension crossed with
the existing `strategy`/`label`; `blame`'s deep-ancestry becomes
`deep-ancestry × {small,medium,large}` rather than a hardcoded 200. The
`delta-chain` evolving fixture stays a single memory-pressure shape (§D4).

### D3 — Bench-file restructuring (collapse `-scale`, tier hot paths)

Per hot operation, **one** `<operation>.bench.ts` that registers the operation at
all size tiers via a shared helper — replacing the current small-file + `-scale`-file
pair. A new `test/bench/support/tiered-bench.ts` helper wraps
`resolveScaledContext` across the tier set:

```
tieredScenario(operation, whenThen, build)   // registers small + medium (+ large under TSGIT_BENCH_LARGE)
```

- **Files removed/merged:** `log-scale.bench.ts` → folds into `log.bench.ts`;
  `status-scale.bench.ts` → `status.bench.ts`; `pack-read-scale.bench.ts` +
  `read-blob.bench.ts` → one `pack-read.bench.ts` (cold/warm scenarios × tiers,
  loose micro-scenario retained per D2).
- **`blame-deep-ancestry.bench.ts`** → `blame.bench.ts`, deep-ancestry shape × tiers.
- **`describe.bench.ts` / `name-rev.bench.ts`** → tier the multi-file fixture,
  keep their `git` preambles verbatim (env-scrubbed, idempotent `tag -f` /
  `commit-tree` — no change to that surface).
- **`fixtures.ts`** (`setupSmallRepo`, `setupDeepAncestryRepo`,
  `setupDirtyWorkingTree`) is superseded by the generator's small tier for the
  tiered operations; retained only for any scenario the generator cannot express
  (e.g. the dirty-working-tree `status` variant — a mutation on top of a tier).

Bench key format is **unchanged** (`<file-path> > <describe title> > tsgit`) — the
gate keeps keying on it (§D5). The two `bench()` names stay exactly
`tsgit` / `isomorphic-git` (`bench-dsl.ts` invariant).

### D4 — Non-hot coverage (DC-4)

"Non-hot paths keep medium only." Concretely:

- **Hot operations** (registry): small + medium + large. Done in D3.
- **`clone`**: stays its **single network-bound scenario** (fixed 5-commit remote;
  network dominates, not repo size — size-tiering it would measure the server, not
  tsgit). Not gated, not tiered. Unchanged.
- **`delta-chain-read`**: a **shape** variant of the hot `pack-read` operation, not
  a size tier. Keep as a **medium-only** memory-pressure scenario. Sub-choice: is
  it *gated* (as part of `pack-read`'s hot coverage) or a non-gated shape probe?
  Recommendation: **non-gated** (it is a worst-case shape stressor, inherently
  higher-variance than the representative medium read).
- **Un-benched profiled commands** — the DC-4 scope lever:
  - **Reads** (`show`, `diff`, `cat-file`, `rev-parse`): **add medium-only benches**
    — cheap, loop-in-place on the medium fixture (like `log`/`status`). This
    realises "non-hot paths keep medium only" for the profiled surface.
  - **Writes** (`commit`, `add`, `merge`): a medium write-bench needs a
    **fresh-scratch-repo-per-iteration** harness (each mutates state — cannot loop
    in place), at medium scale, i.e. the 26.3 `profile-scratch-repo.ts`
    (`buildCommitScratch`/`buildAddScratch`/`buildMergeScratch`) pattern adapted to
    a bench. That is materially heavier than a read loop. **Flagged for the user**
    (DC-4): include write benches now (reusing 26.3's scratch factory) or defer.
    Recommendation: **add the reads now; surface the writes as an explicit
    decision** rather than silently bundling or dropping them (repo default: no
    silent follow-ups, but warn-and-ask on an item that genuinely inflates scope).

### D5 — Gate scoping: only hot-path benches (DC-5)

**Mechanism (recommendation): the `docs/perf/hot-paths.json` registry, read by the
gate.** `gatedEntries` gains a second filter after the `> tsgit` filter: keep an
entry only if the **operation** it belongs to is in `hotOperations`. The operation
is recovered from the key's embedded bench-file path (`toSnapshotEntries` keys on
`<relative-bench-file-path> > … > tsgit`; the basename `log.bench.ts` → `log`).

```
hotGatedEntries(entries, hot) =
  entries
    .filter(e => e.name.endsWith(' > tsgit'))                 // ADR-490 (unchanged)
    .filter(e => hot.includes(operationOf(e.name)))           // NEW — hot-path scope
```

`operationOf` is a small pure helper (parse the leading `<path>.bench.ts` segment
→ basename without `.bench.ts`) — the new **unit-tested** surface (§Test strategy).
`compareToBaseline` is unchanged; only the pre-filter narrows.

**Which tier does the gate compare (sub-choice, recommended: medium).** The PR job
builds small + medium (large is env-gated off). Small is ~50 commits / sub-ms —
inside the noise floor the gate must not cry wolf on. Recommendation: the gate
compares the **medium tier of hot operations**; small still *runs* (trend/summary/
iso-git comparison) but is excluded from the gate by matching the `medium` token
the tier phrase (`givenPhrase` → "Given a medium repo (5000 commits, …)") already
carries in the describe title. Two consequences to make explicit:

- The medium-tier filter is a **prose-title substring match** — the tier lives in
  the human title, not a structured key field (the key format `<path> > <title> >
  tsgit` is fixed). That is a mild ADR-249-adjacent smell *in tooling* (not the
  library); the simpler fork is **gate all CI-run tiers (small + medium)** and lean
  on the advisory posture (ADR-488) to absorb small's noise. The ADR ratifies
  medium-only vs all-CI-tiers.
- **Only scenarios registered through `tieredScenario` carry the tier phrase**, so
  the non-tiered scenarios (dirty-`status`, the loose read micro-scenario,
  `delta-chain-read`) naturally fall outside the gate — a clean consequence, not a
  special case. A dirty-`status` scenario is gated only if its `Given` is
  explicitly phrased at the medium tier.

**Reconciling with ADR-490's rejected allow-list.** ADR-490 refused a
hand-maintained allow-list **on the iso-git axis** — *which external competitors to
include* — because that set is open-ended, arbitrary, and about code we do not
control. A hot-path registry is a **different axis and a different smell**:

- it lists **our own operations**, not third-party tools;
- it is the **ratified output of a defined methodology** (DC-1) with a **defined
  refresh cadence** (per major version), not ad-hoc maintenance drudgery;
- it is **closed and small** (≈6 entries), backed by an ADR and a nightly
  measurement, not an ever-growing list of arbitrary inclusions;
- a **consistency check** (§Test strategy) prevents silent drift between the
  registry and the tiered benches.

So the registry is a *decision artifact*, the very thing ADR-490 wanted decisions
to be — not the maintenance liability it rejected. (Alternatives — a key-naming
marker, a `test/bench/hot/` directory convention — are DC-5's other forks.)

### Pre-chewed context blocks (files the planner will part into TDD slices)

**Part A — `test/bench/support/fixture-generator.ts` (extend).**
- Add `SMALL_FIXTURE` (~50 commits / ~200 blobs, packed) and a `size` dimension on
  `FixtureSpec` (`'small' | 'medium' | 'large'`) crossed with the existing
  `strategy`/`label`. Bump `FIXTURE_GENERATOR_VERSION` — this invalidates **all**
  cached tiers (medium/large included, not just the new small), so the next nightly
  regenerates the ~500 MB large fixture once; `bench.yml`'s `actions/cache` key
  follows the file hash, so the bump propagates the invalidation there too.
- Add a `deep-ancestry` scaled strategy (stable file + churn file at
  `size` scale) so `blame` tiers, replacing the ad-hoc `setupDeepAncestryRepo(200)`.
- `gitEnv()` scrub + atomic-rename cache mechanics reused unchanged.

**Part B — `test/bench/support/tiered-bench.ts` (new).**
- `tieredScenario(operation, whenThen, build)` resolves each in-scope tier via
  `resolveScaledContext(spec)` and registers one `benchScenario` per tier; skips
  cleanly when a fixture is unavailable (mirror `scaled-bench.ts`). Large tier only
  under `TSGIT_BENCH_LARGE`.

**Part C — hot-path bench files (restructure).**
- Collapse the `-scale` pairs into one tiered file each (`log`, `status`,
  `pack-read`, `blame`); keep `describe`/`name-rev` preambles; retain the loose
  read micro-scenario + the `status` dirty variant.

**Part D — non-hot medium benches (new).**
- `show`/`diff`/`cat-file`/`rev-parse` medium-only read benches (loop-in-place on
  `MEDIUM_FIXTURE`); write benches (`commit`/`add`/`merge`) per DC-4 ratification.

**Part E — `docs/perf/hot-paths.json` (new) + `tooling/bench-check.ts` (edit).**
- Commit `hot-paths.json` (D1 shape). In `bench-check.ts`: add `operationOf(key)`
  and `hotGatedEntries(entries, hot)`; `main()` reads the registry (`fs`) and the
  medium-tier filter; `readReport` swaps `gatedEntries` → `hotGatedEntries`.
  Missing/unreadable registry → hard error (no swallow), same `main().catch` idiom.
- **Import gotcha:** `bench-check.ts` imports only from `bench-to-snapshot.ts`
  (tooling-local) — strip-types safe; a `docs/perf/hot-paths.json` read is `fs`,
  not an import, so no cross-tree import edge.

**Part F — `tooling/test/unit/bench-check.test.ts` (extend).**
- Unit-test `operationOf` + `hotGatedEntries` (the new pure surface). Coverage-
  excluded, but runs in `test:unit` (same posture as `compareToBaseline`).

**Part G — consistency check (new small test).**
- Assert `hot-paths.json.hotOperations` ⟷ the set of tiered bench files (every
  hot operation has a tiered bench; no tiered bench is absent from the registry).
  Lives where it can see both trees (a `tooling/test/unit` or `test/bench/support`
  test) — location is a planner detail; the invariant is the point.

**Part H — CI + docs (edit).**
- `.github/workflows/ci.yml` `benchmark-compare`: no structural change — the tool
  now self-scopes to hot paths via the registry; update the informative comment
  prose to say "hot-path-scoped, medium-tier". `bench.yml`, `benchmark-snapshot`,
  `gh-pages` untouched (beyond bench-file renames the `files` globs already cover
  via `test/bench/**`).
- `docs/understand/performance.md`: a line that the gate is hot-path-scoped and
  how the hot list is derived/refreshed (points at `hot-paths.json`).

### Error semantics / edge behaviour

- **Registry missing / unreadable / malformed JSON** → `bench-check.ts` throws a
  clear message (no swallowed error), non-zero exit (tolerated by
  `continue-on-error` in CI but surfaced loudly). No silent "gate everything" or
  "gate nothing" fallback — an unreadable registry is a hard configuration error.
- **A hot operation with no bench key in `raw.json`** (fixture skipped — no `git`,
  Stryker sandbox) → the operation simply contributes no gated row; the gate does
  **not** fabricate a `missing` regression (same posture as ADR-490's set-mismatch
  handling — `missing` warns, never flags).
- **A gate key whose file segment matches no registry operation** → dropped by
  `hotGatedEntries` (non-hot), never errored — new non-hot benches are silently
  out of gate scope by design.
- **Consistency drift** (registry lists an operation with no tiered bench, or a
  tiered bench absent from the registry) → the Part-G check fails **at test time**,
  before CI ever runs the gate — the drift is caught in the PR, not in production.

## Decision candidates

Every load-bearing choice not pre-decided by an existing ADR. **The designer does
not decide these; the user ratifies them in the ADR phase.** ADR numbers are
assigned at ratification (next free ≈ **501**).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | Hot-path picking methodology + source-of-truth + cadence | (a) **Absolute nightly wall-clock ranker**, frozen into the ADR + cross-checked against Phase-26 revealed effort; re-derived per major version. (b) Cross-command self-share ranking from `baseline.json`. (c) Freeze exactly the 26.4* revealed set, no fresh measurement. | **(a)** | (b) is **unsound** — self-shares are intra-command and cannot cross-rank (the crux). (a) uses the only cross-comparable absolute source (nightly, ADR-483), corroborated by (c)'s revealed effort, with an explicit refresh cadence. |
| **DC-2** | Hot-path granularity | (a) **Per-command operation.** (b) Per-primitive/frame. (c) Per-bench-scenario. | **(a)** | Matches `baseline.json` keying and how callers invoke the library; (b) hot frames are cross-cutting and map to no bench; (c) duplicative across cold/warm/clean/dirty scenarios. |
| **DC-3** | Size taxonomy (small/medium/large) + small-tier storage shape | (a) **One generator, packed small ~50c/~200b + medium 5k/20k + large 50k/200k, size-only variation; shape orthogonal; loose read kept as a named micro-scenario.** (b) Keep loose-tmpdir small (storage differs across tiers). (c) Only two tiers (medium/large), no small. | **(a)** | Isolates *size* as the tier variable (the point of tiering) via the existing scaled generator; preserves the loose path explicitly; brief mandates three tiers so (c) is out. |
| **DC-4** | Non-hot coverage: which get medium benches | (a) **Add medium reads (`show`/`diff`/`cat-file`/`rev-parse`) now; surface write benches (`commit`/`add`/`merge`) as an explicit include-or-defer decision; `clone`/`delta-chain` stay as-is (non-gated).** (b) Add all 7 profiled-un-benched (reads + writes) now. (c) Reads only; writes out of scope entirely. | **(a)** | Reads are cheap loop-in-place; writes need the 26.3 fresh-scratch-per-iter harness at scale (materially heavier) — a genuine scope lever the user should weigh, not silently bundle (b) or drop (c). |
| **DC-5** | Gate-scoping mechanism + which tier is gated | (a) **`docs/perf/hot-paths.json` registry read by the gate + a consistency check; gate the medium tier.** (b) Key-naming marker token in describe titles. (c) `test/bench/hot/` directory convention, filter by path prefix. | **(a)** | Single source shared with tiering (no drift), ADR-ratified with a defined refresh cadence (rebuts the ADR-490 allow-list smell — different axis, closed set, our own ops); (b) couples human titles to gate logic; (c) is a large file move that hides the tier in the path, not the data. Medium tier gated because small is sub-ms noise and large is env-gated-off. |

## Test strategy

- **No coverage/mutation obligation.** `tooling/**` and `test/bench/**` are outside
  `vitest.config.ts` coverage `include` (`src/{domain,ports,adapters/node,
  adapters/memory,operators}/**` only) — same precedent as `bench-check.ts` /
  `bench-to-snapshot.ts` today. Stated so review does not raise a false-positive
  coverage flag on the new tooling.
- **Unit tests for the new pure gate surface** (Part F, extends
  `tooling/test/unit/bench-check.test.ts` — runs in `test:unit`, coverage-excluded):
  - `operationOf(key)` — given `test/bench/log.bench.ts > … > tsgit` → `log`;
    given a key with no `.bench.ts` segment → a defined result (throw or `''`, not
    a silent mismatch). Test the parse boundary explicitly.
  - `hotGatedEntries(entries, hot)` — an entry whose operation ∈ `hot` **survives**;
    ∉ `hot` is **dropped**; an `isomorphic-git` entry is dropped by the retained
    `> tsgit` filter *before* the hot filter (both filters proven independently, per
    CLAUDE.md guard-isolation — do not prove both in one test); the medium-tier
    filter keeps `medium` and drops `small`.
  - Assert the **kept/dropped set**, not just a boolean — a set-membership assertion
    kills the StringLiteral/filter-predicate mutants a length-only check would miss.
- **Consistency check** (Part G) — registry ⟷ tiered benches, so a drift fails in
  the PR, not in CI's gate run. Deterministic, no bench run.
- **Property-test lens (CLAUDE.md).** `hotGatedEntries` is a compositional filter
  (lens 2). A property is *marginally* defensible — filtering is idempotent
  (`gate(gate(x)) ≡ gate(x)`); an entry with a hot operation always survives; a
  non-hot one never does. For a thin two-predicate filter a **parameterised example
  sweep reads clearer** (the existing `gatedEntries` ships examples only), so:
  **examples required, property optional** — the planner adds a
  `bench-check.properties.test.ts` sibling only if the sweep proves unwieldy; if
  added, it must state invariants, not re-implement the filter as its own oracle
  (tautology).
- **Benches validated by running, not asserting.** `npm run test:bench` green =
  every tiered/new scenario registers and runs. During development a scratch run
  with a deliberately-lowered threshold proves the fail path (not committed). The
  `raw.json` key format is already empirically pinned in `bench-regression-gate.md`
  §Context — reused here, not re-pinned.
- **State-mutating probes in `mktemp`.** Any DC-1 nightly-ranking snapshot re-run in
  the ADR conversation runs in a `mktemp` throwaway; fixture caches live under
  `~/.cache/tsgit-bench` (existing generator behaviour), never the worktree.

## Faithfulness

**N/A — pinned deliberately, not by omission (per the design-phase faithfulness
context + ADR-226).** 27.4 is bench-suite infrastructure. The benches *build* real
repos, but via **two paths already faithfulness-pinned elsewhere**: (1) `git
fast-import`/`repack` in `fixture-generator.ts` (git building its own on-disk
layout — nothing tsgit asserts), and (2) tsgit's own write path in `fixtures.ts`
(`repo.init/add/commit`), which is pinned by the command interop suites. Adding a
`SMALL_FIXTURE` tier, a `deep-ancestry` scaled strategy, and non-hot read/write
benches **produces no new git-observable state, refusal condition, or message** —
the fixtures are *inputs* to a wall-clock measurement, and the gate compares
median-ms. So this change pins **no faithfulness matrix** and adds **no interop
test**, exactly as `bench-regression-gate.md` and `competitor-benchmarks.md` do.
If the ratified taxonomy ever changes a fixture's *observable on-disk layout* in a
way a command surface reports, that specific layout gets pinned then — not
pre-emptively here.

**ADR-249 (structured output) N/A to the library.** All new logic is in
`tooling/**`, `test/bench/**`, `.github/workflows/**`, and `docs/perf/`; no
`openRepository`/command gains an option or a rendered string.

## Risks

- **Bench-file renames reset `gh-pages` trend lines.** `github-action-benchmark`
  keys each trend series on the snapshot entry `name` (`<file-path> > <title> >
  bench`). Collapsing `log-scale.bench.ts` → `log.bench.ts` (and every other
  rename or re-tier) **changes those names**, so the `benchmark-snapshot` trend history
  starts fresh series and orphans the old ones on `gh-pages`. This is **cosmetic to
  the trend chart, not a CI failure** (the job is `fail-on-alert:false`), and it is
  a one-time discontinuity at the rework's landing. Called out so it is an expected
  reset, not a mystery gap. `gh-pages` itself is not deleted or repurposed.
- **Small-tier noise if "gate all CI tiers" is chosen** (DC-5 sub-fork). A ~50-commit
  sub-ms scenario can flag ≈10 % on pure jitter. Mitigation: the gate is advisory
  (ADR-488) — a flag is a prompt-to-look; the medium-only recommendation avoids it
  entirely.
- **Inherited double-build cost.** The `benchmark-compare` PR job already builds the
  medium fixture twice (base + head); adding the small tier (cheap) and the non-hot
  medium reads (reuse the same cached medium fixture) adds little. No new large-tier
  cost — large stays env-gated off in the PR job.
- **Registry/bench drift** — mitigated by the Part-G consistency check, which fails
  in the PR before the gate ever runs (§Error semantics).

## Out of scope

- **The 26.4-style hot-path *optimisations* themselves** — this item rebuilds the
  *measurement* surface; acting on a newly-surfaced hot frame is separate work.
- **Making the gate blocking** — inherited from ADR-488, the gate stays advisory
  (`continue-on-error: true`); flipping it is a future one-line change.
- **Re-deriving the committed `baseline.json` self-shares** — 27.4 consumes the
  Phase-26 baseline; regenerating it is the 26.3 `npm run profile` path, untouched.
- **`gh-pages` / `benchmark-snapshot` trend history** — untouched load-bearing
  infra (deleting `gh-pages` breaks every main CI run at the snapshot step).
- **Network-command size-tiering** (`clone`) — network dominates; a size tier would
  measure the server, not tsgit.
- **Write benches for `commit`/`add`/`merge`** *if* DC-4 ratifies deferral — their
  fresh-scratch-per-iter harness is called out for the user, not silently dropped.
- **Any library/command surface change** — CI/tooling/bench only.
