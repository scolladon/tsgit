# Plan — perf remediation 2026-08

> Source: design doc `docs/design/perf-remediation-2026-08.md` · ADRs `718–733`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Ordering and why it cannot be permuted

```text
 1–2   P0 harness honesty        every later oracle reads it; MUST be first
 3–4   P1 concurrency seam       parts 15/17/18/19/23–25 consume `limitFor`
 5–7   P2 quick wins             independent; lands before P5 (the sync fast path rides in P5)
 8–9   P3 pack                   part 23+ reads every object out of a pack — needs the lazy successor
10–11  P4 blame
12–14  P5 read policy            ADR-718 flip; parts 23–25 opt back IN explicitly
15–16  P6 status/add/index       consumes P1
17–19  P7 checkout/clone         consumes P1
20–21  P8 structural             part 20 re-keys the caches parts 14 and 16 added
22–25  P9 maintenance            new command surface, two new on-disk formats, the only destructive command
```

## Standing rules — every part, no exceptions

- **Green gate before commit.** Never commit on a red `npm run validate` / part gate.
  Never `--no-verify`.
- **No suppression directives**: no `@ts-ignore`, `v8 ignore`, `stryker-disable` (except
  re-proved equivalence comments this plan names explicitly), `biome-ignore`, no
  `eslint-disable`. Refactor to pass the rule honestly.
- **No provenance refs in source or test code** — no `§`, `Phase`, `ADR-nnn`, `P9`,
  backlog ids inside `src/**` or `test/**`. The commit message is the join point.
- **Test conventions**: `describe('Given …')` > `describe('When …')` > `it('Then …')`
  (2-level shortcut allowed when one expectation lives under the When); AAA body with
  section comments; the system under test is the variable `sut` (never the result —
  the result goes in `result`). Error assertions assert `.data` (code/reason/value),
  never `toThrow(ErrorClass)` alone. Guard clauses `if (A || B) throw` need one test
  per condition triggered alone.
- **Property tests** live in `<module>.properties.test.ts` beside the example test, with
  generators in the directory's `arbitraries.ts`; `numRuns` 200 (cheap round-trip) /
  100 (composition) / 50 (filter-heavy). Never commit a seed. Never delete an example
  test to make room for a property.
- **Serena is already activated** on this worktree — do NOT call `activate_project`.
  Serena symbol tools are the default for TS read/navigate/edit; `Read`/`Grep` only for
  markdown/JSON/generated artefacts. Run `get_diagnostics_for_file` after each source
  edit; diagnostics are advisory, `npm run check:types` is ground truth.
- **State-mutating git probes run in a `mktemp -d` throwaway** with an isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed and signing OFF — **never** in this
  worktree, which shares `.git/config` with the main checkout through the common dir.
  `-C <path>` does NOT override an inherited `GIT_DIR`.
- **"Pre-existing failure" claims are verified against `main`**, never against an
  earlier commit on this branch.
- **Measurement**: every perf claim is an absolute wall-clock `main`-vs-branch A/B
  through `tooling/bench-ab.ts` (part 2 builds it), reported with both absolute columns.
  Never a self-share delta. Nothing measured locally is citable.
- **Poll, don't wait**: never end your turn waiting on a background notification. If you
  start a long command in the background, poll it yourself until it finishes.
- **Escalate, never spin**: a blocker is `{ part, reason, ≤3 options }`.

## Gate vocabulary

- **Part gate** (every part, verbatim):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`
- **Phase gate** (phase boundary, not per part): `npm run validate`
- **Targeted extras** are named per part. The ones that exist:
  `npm run check:architecture` (dep-cruiser boundaries), `npm run check:tarball`
  (the `node:`-free default-entry guard), `npm run check:size` (size-limit),
  `npm run check:doc-coverage`, `npm run check:test-pyramid`, `npm run check:spelling`,
  `npm run docs:json` (regenerates `reports/api.json` — a **prepush** gate that
  `validate` does not catch), `npm run test:integration` (interop suites).
- `dist/` is **not built in this worktree**. Before trusting any `check:size` /
  `check:tarball` failure: `rm -rf dist .wireit` and rebuild — a stale chunk inflates
  the reading.
- ⚠️ A wireit-**cached** green `validate` can precede a **red** prepush. Before any push,
  re-run `npm run check:spelling` fresh and regenerate `reports/api.json`.

## A/B measurement without touching repo state

Every part that claims a perf effect runs `tooling/bench-ab.ts` (Part 2). The driver takes
**two paths as arguments** — it does not create them. Obtain the base side as a **`mktemp -d`
clone of `main`**, not via `git worktree add`: adding a worktree writes `.git/worktrees/…` in
the shared common dir, which is repo-wide state a part must not change. Remove the temp clone
when the run finishes; if a worktree is unavoidable, `git worktree prune` afterwards and say so
in the commit body.

## Deliberate cross-part file overlaps

`plan-lint` warns whenever two parts' context blocks name the same file. All of the following
are intentional; none is a merge candidate.

| File | Parts | Why separate |
|---|---|---|
| `reports/api.json` | 3, 4, 15, 20, 23, 25, 26, 27 | Shared infrastructure. Every part that moves public surface regenerates it **in that part** — `check:doc-typedoc` is a **prepush** gate `validate` does not catch, so deferring it to one part guarantees a rejected push |
| `docs/understand/performance.md` | 1, 3 | Part 1 adds the tick-total / under-sampled convention; Part 3 adds the `UV_THREADPOOL_SIZE` integrator note that ADR-719 requires **in-part**. Different sections, different ADRs |
| `docs/understand/security.md` | 12, 21 | Part 12 amends the **object-integrity** claim (ADR-718); Part 21 amends the **path-containment** claim (ADR-721). Merging would couple a read-policy flip to a security-adjacent containment change |
| `src/application/primitives/object-resolver.ts` | 6, 9, 12, 14 | Four independent concerns on one hot file: loose-cache population, the offset-keyed delta cache, the verify flip + sync fast path, the parsed-commit memo. Each has its own oracle and its own revert boundary |
| `src/domain/storage/lru-cache.ts` | 7, 9, 14 | **Only Part 7 modifies it** (the head fast path); Parts 9 and 14 are consumers whose context must state its drop/throw behaviour |
| `src/application/primitives/pack-registry.ts` | 8, 9, 24, 25, 26 | Lazy offset table → offset cache → `settleRefresh` → two consumers. Sequential, each independently gated |
| `src/application/primitives/config-read.ts` | 5, 24 | Part 5 repairs the scoped-cache invalidation defect; Part 24 adds the `gc` section across its seven sites. Unrelated edits to a 1307-line file |
| `test-pyramid-budgets.json` | 4, 15 | Part 4 may **add** an allowlist entry; Part 15 **removes** `createWorkingTreeStatMap`. Opposite directions |
| `test/bench/support/fixture-generator.ts` | 1, 2 | Part 1 only **reads** it; Part 2 may bump `FIXTURE_GENERATOR_VERSION`, which invalidates the nightly fixture cache and must be a deliberate, isolated decision |
| `src/index.ts` | 3, 20 | Neither **edits** it — both must verify a type did **not** leak onto the public barrel |
| the two `625-*` ADRs | 8, 21 | **Different files sharing a number** (`625-one-shared-pack-offset-sort-for-idx-and-rev.md` vs `625-git-parity-containment-posture.md`). Cite by filename, never by number |
| `src/application/primitives/path-layout.ts` | 22, 25 | Read-only in both (`commitGraphPath` vs `packsDir` / `multiPackIndexPath`) |

## What this plan does NOT own

- **The `docs/BACKLOG.md:429` tick.** F11 un-parks the `gc / repack / prune` entry, but the
  checkbox flip and its reference-link suffix are the **documentation phase's** job, under
  guard — not an implementer's. **No part edits `docs/BACKLOG.md`.**
- **Follow-ups.** The delta-capable pack writer that would retire ADR-732's size trade is
  recorded in the design as the follow-up. The repo default is **no follow-up entries**; raise
  it with the user rather than filing or dropping it silently.

---

## Part 1 — Profiler honesty: tick totals, hoisted setup, regenerated baseline

### Context

Design §P0 (defects 1–3, shapes P0.1–P0.4, P0.7) · **ADR-729** (the baseline schema change is
ratified; the artifact stays ungated). Tooling-only part — **no `src/` delta**, so it is a
legitimate standalone part.

**Anchors (re-verified in this worktree, HEAD `cd991133`).**

| Thing | Anchor |
|---|---|
| profiler driver | `tooling/profile.ts` (219 lines). Read child `runReadChild` **L49–75** (loop L60, per-iteration `openRepository` L62); write child `runWriteChild` **L77–93** — `iterations` resolved L80, `for (let i = 0; i < iterations; i += 1)` L83, **`const scratch = await workload.build(profileEnv());` L84 — inside the sampled loop**. `partitionWriteDigest` imported L31 |
| ⚠️ corrected anchor | **`SETUP_FRAMES` is NOT in `profile.ts`.** It is `tooling/profile-digest.ts:18–22` (`export const SETUP_FRAMES: ReadonlySet<string>`), consumed as `partitionWriteDigest`'s defaulted second parameter |
| digest parser | `tooling/profile-digest.ts` (80 lines): `FrameShare` **L5** (`{ frame: string; self: number }`), `DigestPartition` **L7–10** (`{ hotShares; setupShares? }`), `SETUP_FRAMES` L18–22, `NOISE_FLOOR_SELF = 0.01` L24, `TSGIT_FRAME_LINE` declared L34 with the regex literal on **L35**, `normaliseShares(frames: ReadonlyArray<{ frame: string; ticks: number }>): FrameShare[]` **L57–66** (this is where raw ticks are discarded), `parseDigest(digestText): ReadonlyArray<FrameShare>` **L68–69**, `partitionWriteDigest(digestText, setupFrames = SETUP_FRAMES): DigestPartition` **L71–80** |
| baseline writer | `tooling/profile-baseline.ts` (66 lines): types L10–15 (`CommandBaseline = DigestPartition`), `machineBanner()` L22–23, `renderBaselineJson(baseline): string` **L25–26**, `frameTableRow` L28, `frameTable` L30–31, `setupSection` L33–44, `commandSection` L46–54, `renderBaselineMarkdown` L56–59, `writeBaseline(baseline, root)` **L61–66** |
| workload registry | `tooling/profile-registry.ts` (262 lines): `READ_ITERATIONS = 100` **L22**, `FAST_READ_ITERATIONS = 2000` **L28**, `HEAVY_READ_ITERATIONS = 2` **L32**, `WRITE_ITERATIONS = 100` **L37**; `ReadWorkload` **L51–58** (`kind/fixture/setup?/run/perIterationRepo?/iterations?`), `WriteWorkload` **L60–65** (`kind/build/run/iterations?`), `READ_WORKLOADS` **L127–207** (10 entries), `WRITE_WORKLOADS` **L209–236** (commit, add, merge), `WORKLOADS` L238–241, `resolveWorkloads` L251–262 |
| write scratch | `tooling/profile-scratch-repo.ts`: module-private `newScratch(_env)` **L50–56** (`mkdtemp → openRepository → repo.init()`), `buildCommitScratch` L59, `buildAddScratch` L67, `buildMergeScratch` **L79** (3 adds + 3 commits + branch + 2 checkouts) |
| fixtures | `test/bench/support/fixture-generator.ts`: `MEDIUM_FIXTURE` L85, **`MEDIUM_FIXTURE_WITH_COMMIT_GRAPH` L94**, `ensureScaledFixture` L657–691 |
| tooling tests to move with the schema | `tooling/test/unit/profile-digest.test.ts` — top-level `describe('parseDigest')` **L15**, `describe('partitionWriteDigest')` **L195**; fixture const `BUNDLE = 'file:///repo/dist-profile/esm/index.node.js'` L8. `tooling/test/unit/profile-registry.test.ts` — `describe('resolveWorkloads')` **L25** with four Given blocks (L26/L41/L57/**L79** `Given the registry`), pinning `READ_KEYS` L10–21, `WRITE_KEYS` L23, `blame.iterations === HEAVY_READ_ITERATIONS` L104, `log.iterations === undefined` L112 |
| committed artifacts | `docs/perf/baseline.json` + `docs/perf/baseline.md` — **both are already modified-uncommitted in this worktree** (current-tree numbers, old schema). Current JSON shape: `{ generatedOn, commands: { <cmd>: { hotShares: [{frame,self}], setupShares?: [...] } } }`; markdown is `## <cmd>` / `### hotShares` / `| frame | self |` table |
| perf doc | `docs/understand/performance.md` — headings at L1 `# Performance`, L5 `## Current measured numbers`, L41 `## Methodology`, L98 `## Reproduce locally` |

**What the part changes.**

1. **Schema (P0.1, ADR-729).** `FrameShare` gains `readonly ticks: number`; `DigestPartition`
   gains `readonly totalTicks: number` and `readonly underSampled: boolean`. Add
   `export const UNDER_SAMPLED_TICK_FLOOR = 500;` to `profile-digest.ts`. `normaliseShares`
   already receives `{ frame, ticks }` — carry `ticks` through instead of dropping it, and
   return the surviving tick sum as `totalTicks` (the denominator the shares were computed
   from — **not** the raw `--prof-process` total, which includes the excluded
   `Builtin:`/`Stub:`/`RegExp:`/`GC`/`Unaccounted`/`[Shared libraries]` rows). `baseline.md`
   renders a `totalTicks: <n>` line per command and an explicit `under-sampled` marker for
   any command below the floor.
2. **Iterations (P0.2).** Raise **per-workload** `iterations` in the registry (never the shared
   defaults at L22/L28/L32/L37) until every command clears the floor; record the measured tick
   total in a comment beside each chosen count. `blame` (`HEAVY_READ_ITERATIONS = 2` over a
   ~200-commit ancestry) is the hard case — a smaller fixture is allowed instead of more
   iterations. **`profile-registry.test.ts:104` pins `blame.iterations === HEAVY_READ_ITERATIONS`
   and `:112` pins `log.iterations === undefined`** — both move with this change.
3. **Setup out of the sampled region (P0.3).** Hoist `workload.build(...)` (`profile.ts:84`) out
   of the `for` at L83: build **all** scratch repos first, then run the sampled loop over them.
   This changes `merge` most (`buildMergeScratch` is 9 library calls). Where a workload genuinely
   cannot be pre-built, keep the per-iteration build and widen `SETUP_FRAMES`
   (`profile-digest.ts:18–22`) to the transitive open set — but **prefer the hoist**: a name list
   is fragile, and today all three `setupShares` arrays are empty while `add`'s `hotShares` is
   dominated by layout-discovery frames (`runFs`, `isContainedIn`, `findLayout`, `dirChain`,
   `createSingleFlightIndexResolver`, `normalizeSeparators`).
4. **New workload (P0.4).** Register a `log-commit-graph` `ReadWorkload` over
   `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH` (`fixture-generator.ts:94`) — the profiler samples the
   commit-graph read path nowhere today. `tooling/gen-bench-fixture.ts` cannot pre-warm that
   fixture, so the first run pays generation; say so in the registry comment.
5. **Regenerate + commit the baseline (P0.7).** `npm run profile` after the schema and sampling
   changes, then commit `docs/perf/baseline.{json,md}` **in this part** — the artifact and its
   schema move once. The already-uncommitted regeneration in this tree is the *old* schema and is
   superseded by this run; do not commit it as-is.
6. **ADR housekeeping owed by this part.** `docs/adr/652-no-staleness-guard-for-the-perf-baseline.md`
   currently reads `- **Status:** accepted` with no forward pointer; ADR-729 refines it (the
   baseline stays ungated but becomes self-describing). Add `· **Refined by:** ADR-729` to that
   header bullet. The convention is prose only — a header bullet and/or a leading blockquote;
   there is **no `refines:` front-matter key** and no tooling reads ADR front-matter, so this is
   checklist-enforced, not gate-enforced.
7. **Documentation.** `docs/understand/performance.md` §Methodology gains: the tick-total /
   under-sampled convention, and the stated asymmetry that `add.bench.ts`, `commit.bench.ts` and
   `merge.bench.ts` still build their scratch repo **inside `sut`** (accepted, advisory — the
   bench and the profiler have independent framings; this part only stops the *profiler*
   conflating them).

**Traps.**

- The share vector is *exact values rounded to 2 decimals*, which is how the design recovered the
  smallest consistent tick totals (`show` 2, `pack-read` 7, `add` 7, `commit` 16, `log`/`status`/
  `merge` ≈80). Do **not** re-derive ticks from shares — read them from the digest.
- `check:spelling` covers `docs/**/*.md`; new frame names in `baseline.md` may need `cspell.json`
  entries. **Never** an inline suppression.
- `npm run profile` is long-running: start it in the background and **poll**.

### TDD steps

1. **RED** — `tooling/test/unit/profile-digest.test.ts`, new `describe('Given a digest with
   known tick counts', …)`: `Then it reports each frame's raw tick count` and `Then it reports
   the surviving tick total as totalTicks`. Fails: `FrameShare` has no `ticks`, `DigestPartition`
   has no `totalTicks` (type error, then assertion failure).
2. **RED** — same file: `Given a digest whose surviving tick total is below the floor` /
   `Then the partition is marked under-sampled`, and its sibling one tick **above** the floor
   proving the boundary is strict (`>= floor ⇒ not under-sampled`). Two separate tests — a single
   two-sided test lets the boundary mutant live. Fails: no `underSampled` field.
3. **GREEN** — carry `ticks` through `normaliseShares` (L57–66), add `totalTicks`/`underSampled`
   to `partitionWriteDigest` (L71–80) and `parseDigest` (L68–69), add
   `UNDER_SAMPLED_TICK_FLOOR = 500`.
4. **RED** — `tooling/test/unit/profile-baseline.test.ts` (extend if present, else create):
   `Given a command baseline below the tick floor` / `Then the markdown marks it under-sampled`
   and `Then the JSON carries totalTicks`. Fails: renderer emits neither.
5. **GREEN** — `frameTable` (L30–31), `commandSection` (L46–54), `renderBaselineJson` (L25–26).
6. **RED** — `tooling/test/unit/profile-registry.test.ts`: update the two pinned expectations
   (L104, L112) to the new per-workload counts and add `Then log-commit-graph is a read workload`.
   Fails: the workload does not exist.
7. **GREEN** — per-workload `iterations` + the `log-commit-graph` registration.
8. **GREEN** — hoist `workload.build(...)` out of `profile.ts:83–93`; assert nothing here (the
   profiler driver has no unit seam) — the oracle is step 10.
9. **REFACTOR** — keep `parseDigest`/`partitionWriteDigest` signatures source-compatible for
   every other caller; no function over 20 lines; no `any`.
10. **Oracle** — `npm run profile` (background + poll) completes; every command in the
    regenerated `baseline.json` carries `totalTicks >= 500` **or** is marked under-sampled;
    commit `docs/perf/baseline.{json,md}`.

### Gate

- Part gate: `npx vitest run tooling/test/unit/profile-digest.test.ts tooling/test/unit/profile-registry.test.ts tooling/test/unit/profile-baseline.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/profile-digest.ts tooling/profile-baseline.ts tooling/profile.ts tooling/profile-registry.ts tooling/test/unit`
- Targeted extra: `npm run check:spelling` (new frame names in `baseline.md`; add `cspell.json`
  entries rather than suppressing) and a completed `npm run profile`.
- ⚠️ `biome.json`'s `files.includes` is a **whitelist** — a new file under `tooling/` may be
  silently unlinted. If you add one, confirm it is covered.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(tooling): record absolute tick totals and take setup out of the sampled region`

---

## Part 2 — Local A/B driver and a pack-offset bench fixture that measures two paths

### Context

Design §P0.5, §P0.6 · **R10**, **R12**. Test-infra/tooling only — **no `src/` delta**.
Everything downstream in this plan reports through this driver, so it lands before the first
perf-bearing part.

**Anchors.**

| Thing | Anchor |
|---|---|
| comparator to reuse | `tooling/bench-check.ts` (260 lines): `compareToBaseline(base, current, { thresholdPct })` **L86–101**; `bestOfRounds` **L132**; `gatedEntries` L23; `operationOf` L29; **`hotGatedEntries` L35**; `splitRounds` L207–211; `main()` reads `process.argv[2]`/`[3]` (L214–222) and loads `docs/perf/hot-paths.json` at **L225–231** |
| ⚠️ the filter to bypass | `hotOperations` in `docs/perf/hot-paths.json` is currently `["log","status","pack-read","blame","describe","name-rev","diff-recursive"]` — it excludes `add`/`commit`/`merge`/`checkout`, which is exactly why `bench-check.ts` is unusable as a local A/B driver. **`bench-ab.ts` must not apply this filter** |
| bench raw output | `reports/benchmarks/raw.json` is the wireit `test:bench` output (`vitest bench --run --config vitest.bench.config.ts`). CI copies it per round (`.github/workflows/ci.yml:699` → `/tmp/${tag}-bench-${round}.json`) and passes comma-joined round lists as argv |
| bench fixture count | `test/bench/fixtures.ts:143` — `export const MANY_OBJECT_COUNT = 3_000;` |
| the threshold it must clear | `src/application/primitives/internal/pack-offset-table.ts:68` — `export const REV_INDEX_MIN_OBJECTS = 5_000;` (retired in Part 8, still live on `main`) |
| generator cache | `test/bench/support/fixture-generator.ts`: `FIXTURE_GENERATOR_VERSION = 3` **L25** (module-private), `cacheRoot()` L243–247 (`$XDG_CACHE_HOME`/`~/.cache` + `tsgit-bench`), `cacheDirFor(spec)` L249–250 (`<label>-v<VERSION>`), `ensureScaledFixture` L657–691 |

**P0.5 — `tooling/bench-ab.ts` (new).** Implements the CI recipe locally, per **R10**:
pre-warm fixtures → take two worktrees (base and head) → intersect their bench-file lists →
alternate `base, head, base, head, …` rounds, copying each round's `reports/benchmarks/raw.json`
out to `/tmp/{base,head}-<round>.json` → feed both comma-joined lists to `compareToBaseline` →
print **absolute `Base (ms)` / `Current (ms)` columns**. Reuse `bestOfRounds` and
`compareToBaseline` from `bench-check.ts`; do **not** reuse `hotGatedEntries`. Register it as an
npm script beside the existing tooling scripts (match their wireit/`tsx` shape).

**P0.6 — the pack-offset bench fixture.** `MANY_OBJECT_COUNT = 3_000` is below
`REV_INDEX_MIN_OBJECTS = 5_000`, so `resolveSortedOffsets` returns `sortAscending(raw)` *before
reading the artefact* and the bench's "`.rev` present" and "`.rev` deleted" scenarios exercise the
**identical** code path today. Raise the count **once, to ~8 000**. Two reasons, both binding:
it keeps the before/after A/B comparable on `main` (where the threshold still exists), and it
keeps the fallback tier large enough for the O(N) build to be measurable against the O(log N)
path. **Do not add a second below-crossover tier** — after Part 8 there is no crossover and it
would measure nothing.

⚠️ **Cache coupling.** Verify first whether the many-object fixture is produced through
`ensureScaledFixture` (`fixture-generator.ts:657`) or built inline in `test/bench/fixtures.ts`.
If it goes through the generator, bump `FIXTURE_GENERATOR_VERSION` (`:25`) **deliberately** and
budget one slow nightly — the CI cache key is a hash of `fixture-generator.ts`, so editing that
file invalidates the nightly's whole fixture cache inside its 30-minute timeout. If the fixture
is built inline, no bump is owed; say which in the commit body.

### TDD steps

1. **RED** — `tooling/test/unit/bench-ab.test.ts`: `Given two bench-file lists that differ` /
   `When the driver intersects them` / `Then only files present in both are run`. Fails: module
   does not exist.
2. **RED** — same file: `Given four alternating rounds` / `Then the base and head round paths
   alternate and each side gets two entries` (the interleaving is the part most likely to be
   written as "all base then all head", which measures machine drift instead of the change).
3. **RED** — same file: `Given a comparison result` / `Then the table carries absolute Base (ms)
   and Current (ms) columns` and `Then an operation absent from hot-paths.json is still
   reported` — the second is the regression test for the filter bypass.
4. **GREEN** — `tooling/bench-ab.ts`: pure helpers (list intersection, round interleaving, table
   rendering) exported for the unit test; the worktree/spawn shell kept thin and out of the
   assertions.
5. **RED** — `test/bench/pack-offset-table.bench.ts` (existing): assert nothing new; instead
   raise `MANY_OBJECT_COUNT` and record, in the commit body, the measured medians of both rows
   **before** the raise (identical, the defect) — this is documentation, not an assertion.
6. **GREEN** — `MANY_OBJECT_COUNT = 8_000` (+ the version bump decision above).
7. **Oracle (R10)** — run `bench-ab` on a no-op branch (head == base): the table prints both
   absolute columns and every delta sits inside the noise band. Record `node --version`,
   `git --version` and the core count beside the numbers.

### Gate

- Part gate: `npx vitest run tooling/test/unit/bench-ab.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/bench-ab.ts tooling/test/unit/bench-ab.test.ts test/bench/fixtures.ts`
- Targeted extra: one `bench-ab` no-op run (background + poll) as the R10 oracle; if the
  generator version was bumped, note the one slow nightly in the commit body.
- ⚠️ `biome.json` `files.includes` is a whitelist — confirm `tooling/bench-ab.ts` is covered or
  it is silently unlinted.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(tooling): add an absolute wall-clock A/B driver and split the pack-offset bench tiers`

---

## Part 3 — The concurrency-policy seam

### Context

Design §P1 (What exists today · The mechanism · Proposed shape 1–3) · **ADR-719** · **R18**,
**R20**. This is the one place the change introduces new architecture, and it is the part the
user named explicitly. Parts 4, 15, 17, 18, 19 and 23–25 consume it.

**Public-surface decision, made here — and it settles a stale line in the design.**
`ConcurrencyLimits` and `MachineFacts` are **internal**: re-exported from `src/ports/index.ts`
(so `knip` does not call them dead) and **never** from `src/index.ts`. The design's constraint
table (§Context, the `reports/api.json` row) speaks of "a `ConcurrencyPolicy` port re-exported
from `src/ports/index.ts`" entering `api.json`; that phrasing predates the ratification and
contradicts both ADR-719's **rejected** option 2 and the design's own §P1 Gates paragraph.
**The ratified reading binds: the type stays internal.** `src/ports/index.ts` is not the public
barrel — `src/index.ts` is — so the re-export satisfies `knip` without publishing anything.
The **only** public delta is the widened `RepositoryConfig.parallelism` type, which trips the
`reports/api.json` **prepush** gate; regenerate and commit it **in this part**, and verify
`ConcurrencyLimits` does **not** appear in the regenerated report.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| Context interface | `src/ports/context.ts` **L162–222** (members: `fs` L163, `hash` L164, `compressor` L165, `transport` L166, `progress` L167, `layout` L169, `cwd` L177, `runtime` L179, `hashConfig` L181, `deltaCache` L183, `config?` L185, `logger?` L187, `signal?` L189, `hooks?` L191, `command?` L197, `env?` L202, `ssh?` L207, `promisor?` L212, `worktreeFs?` L221) |
| the knob | `src/ports/context.ts:131` — `readonly parallelism?: number;` (doc L130: "Bounded parallelism for fan-out work. 1..32, default 8") |
| context factory | `CreateContextParts` **L224–242**, `createContext(parts): Context` **L245–247** |
| validation | `src/repository/validate-options.ts`: `PARALLELISM_MIN = 1` **L22**, `PARALLELISM_MAX = 32` **L23**, dispatch `validateParallelism(config.parallelism)` **L50** inside `validateOptions` L37–56, validator body **L117–125** — `invalidOption('parallelism','must be an integer')` L120, `invalidOption('parallelism', \`must be in 1..32 (got ${value})\`)` L123 |
| the facade's real Context | `src/repository.ts`: required-field literal `const baseCtx = { … }` **L621**; optional-field assembler `buildOptionalCtxFields` **L528** (input type `OptionalCtxInputs` **L513**); the frozen result `const ctx: Context = Object.freeze({ ...baseCtx, ...buildOptionalCtxFields({…}), promisor })` **L654** |
| raw context factories | `createNodeContext` **`src/adapters/node/node-adapter.ts:55`** (parts literal L71–88, `createContext(parts)` L89); `createMemoryContext` **`src/adapters/memory/memory-adapter.ts:41`** (`createContext` L88); `createBrowserContext` **`src/adapters/browser/browser-adapter.ts:33`** (`createContext` L57) |
| node entry | `src/index.node.ts` (351 lines): `openRepository` L53–141, the adapter **`fallback` object L101–130** forwarded to `openRepositoryCore` L140. ⚠️ that object is **not** `CreateContextParts` — a new field must be threaded through `repository.ts`'s `AdapterSet`/fallback type too |
| current consumers of the knob | exactly two, both `ctx.config?.parallelism ?? DEFAULT_PREFETCH_CONCURRENCY`: `src/application/primitives/walk-commits.ts:50` (feeding `createBoundedReader(bound, …)` L51) and `src/application/primitives/internal/commit-date-walk.ts:91` (feeding L97). `DEFAULT_PREFETCH_CONCURRENCY = 8` is `src/application/primitives/internal/read-commit-graph.ts:33` |
| ports barrel | `src/ports/index.ts` (35 lines, one re-export per line, alphabetical) — a new type is a one-line addition |
| machine properties in `src/` today | **none.** `os.availableParallelism` / `os.cpus` / `navigator.hardwareConcurrency` / `UV_THREADPOOL_SIZE` appear nowhere in `src/`. `src/adapters/node/node-adapter.ts:1` already imports `homedir` from `node:os`, so `node:os` is an existing node-adapter dependency |
| the `node:`-free guard | `tooling/verify-tarball.sh:246-276` walks the packed tarball's transitive static import graph from `dist/esm/index.default.js` and fails on the first `node:` specifier. A sibling grep guards the CDN bundle |
| docs that state the knob | `docs/design/repository-facade.md:222` (`readonly parallelism?: number; // 1..32, default 8`) and `:595`; `docs/design/commands.md:554` and `:1497`; `docs/understand/performance.md` (§Methodology L41) |

**What lands.**

1. **Pure domain selector** — `src/domain/concurrency/derive-limits.ts`:
   ```ts
   export interface MachineFacts { readonly cores?: number; readonly threadpoolWidth?: number; }
   export interface ConcurrencyLimits { readonly cpuBound: number; readonly ioBound: number; }
   export function deriveLimits(facts: MachineFacts): ConcurrencyLimits;
   ```
   Derivation, exactly as ADR-719 ratified it — named constants, no magic literals:
   ```text
   cpuBound = clamp(1, min(cores, threadpoolWidth), CPU_CAP)        // Node: min(11, 4) = 4
   ioBound  = clamp(1, threadpoolWidth * IO_OVERSUBSCRIBE, IO_CAP)  // Node: 4 * 8 = 32
   ```
   Unknown facts fall to the floor `{ cpuBound: 1, ioBound: 4 }`. **The floor must be a *safe*
   answer, never a fast one — workerd always takes it.** Pure, total, zero platform imports.
2. **Capability on the Context** — `readonly concurrency?: ConcurrencyLimits;` on
   `Context` (`context.ts` L162–222, place it beside `deltaCache` L183) and on
   `CreateContextParts` (L224–242), filled by `createContext` (L245–247). **It must stay
   optional**: 215 test files construct a Context and a required field is a 215-file change.
3. **Platform bindings, node-only import graph** — `src/adapters/node/node-concurrency.ts`
   exporting `nativeMachineFacts(): MachineFacts` (`os.availableParallelism()` and
   `Number(process.env.UV_THREADPOOL_SIZE) || 4`), imported from
   `src/adapters/node/node-adapter.ts` **and** `src/index.node.ts` — **never** from
   `src/index.default.ts`. `src/adapters/browser/browser-concurrency.ts` reads
   `navigator.hardwareConcurrency ?? 4` with `threadpoolWidth = cores` (streams are native, no
   libuv) and **no `node:` import**. Memory/workerd pass nothing and take the floor.
4. **`limitFor`** — `src/application/primitives/internal/concurrency.ts`:
   ```ts
   type Bucket = 'cpuBound' | 'ioBound';
   const limitFor = (ctx: Context, bucket: Bucket): number => …;
   ```
   Absence is a first-class case: with `ctx.concurrency` undefined it resolves the derivation of
   `{}` — the floor. **`RepositoryConfig.parallelism` always wins over the derived value.**
5. **Widen the knob** — `parallelism?: number | { cpu?: number; io?: number }` (`context.ts:131`).
   A bare `number` keeps meaning what it means today and applies to **both** buckets. The
   1..32 range and both `invalidOption('parallelism', …)` refusals (`validate-options.ts:120`,
   `:123`) extend to **both members** of the object form. This is a deliberate behaviour
   *widening* — a caller who sets `parallelism: 2` affects two sites today and every pool
   afterwards; ADR-719 ratifies the widening, and `validate-options.test.ts` must cover it.
6. **Re-point the two existing consumers** to `limitFor(ctx, 'ioBound')` as the fallback in place
   of the literal `DEFAULT_PREFETCH_CONCURRENCY` (`walk-commits.ts:50`,
   `commit-date-walk.ts:91`). Commit-body prefetch is object reads → **`ioBound`**.
7. **Integrator documentation is part of the part, not a follow-up** (ADR-719):
   `docs/understand/performance.md` gains the note that raising `UV_THREADPOOL_SIZE` is the host
   application's job, **before the first threadpool use**, and that tsgit never sets it (mutating
   `process.env` is hostile and, past first use, inert). Non-Node runtimes that accept but may
   not honour the variable (Deno, Bun) are treated as "threadpool width unknown" → floor. Update
   the `parallelism` type in `docs/design/repository-facade.md:222`/`:595` and
   `docs/design/commands.md:554`/`:1497`.

**Gate obligations specific to this part.** New `src/domain/**` and `src/ports/**` files are
inside the **100 % coverage** gate (`vitest.config.ts:80-98`) — as are the node and memory
adapters. A new port file lands in the **`infra`** mutation bucket (break 90 / low 95); the
domain selector lands in **`domain`** (break 99 / low 100). `check:architecture` must stay green
(`tsPreCompilationDeps: true` — **type-only imports count as edges**; `ports ✗→ adapters`,
`ports ✗→ application`, `domain ✗→ *`). `check:tarball`'s `node:` guard must stay green.

### TDD steps

1. **RED** — `test/unit/domain/concurrency/derive-limits.test.ts`, the **R18 matrix**.
   ⚠️ The design's R18 (§Requirements) lists only `UV_THREADPOOL_SIZE` *unset* and *=1*;
   **ADR-719 ratified the full grid and the ADR wins**: `Given <n> cores and a threadpool width
   of <w>` / `Then cpuBound is …` / `Then ioBound is …` for **cores {1, 2, 11, 128} ×
   `UV_THREADPOOL_SIZE` {unset, 1, 4, 64}** — sixteen cases — **plus the no-facts floor case**,
   plus `cores` known with width unknown and the reverse. Each expectation is its own `it`; a
   table-collapsed single assertion lets the clamp mutants live. Fails: module missing.
2. **RED** — same file: `Given a machine that reports zero cores` / `Then the floor is returned`
   (the clamp's lower bound triggered alone) and `Given a machine that reports more cores than
   the cap` / `Then the cap is returned` (upper bound alone). Separate tests per bound.
3. **GREEN** — `derive-limits.ts` with named constants (`CPU_CAP`, `IO_CAP`,
   `IO_OVERSUBSCRIBE`, `CPU_FLOOR`, `IO_FLOOR`).
4. **RED** — `test/unit/adapters/node/node-concurrency.test.ts`: `Given UV_THREADPOOL_SIZE is
   unset` / `Then the width defaults to 4`; `Given UV_THREADPOOL_SIZE=1` / `Then the width is 1`;
   `Given UV_THREADPOOL_SIZE is not a number` / `Then the width defaults to 4`. Fails: module
   missing. Mirror for the browser reader with `navigator.hardwareConcurrency` absent/present.
5. **RED** — `test/unit/ports/context.test.ts` (or the existing context test): `Given parts
   without concurrency` / `Then the Context omits the field`; `Given parts with concurrency` /
   `Then createContext carries it`. Fails: field does not exist.
6. **RED** — `test/unit/application/primitives/internal/concurrency.test.ts`: `Given a Context
   with no concurrency` / `Then limitFor returns the floor for each bucket`; `Given a Context
   with derived limits` / `Then limitFor returns the bucket's value`; `Given config.parallelism
   as a number` / `Then it overrides both buckets`; `Given config.parallelism as { cpu }` /
   `Then only cpuBound is overridden` (and the `{ io }` mirror). Fails: `limitFor` missing.
7. **RED** — `test/unit/repository/validate-options.test.ts`: `Given parallelism { cpu: 0 }` /
   `Then it refuses with option 'parallelism' and reason 'must be in 1..32 (got 0)'`; the same
   for `{ io: 33 }`, for a non-integer member, and for the bare-number forms that already pass
   today. Assert `.data` (option + reason), never the error class alone.
8. **GREEN** — widen the type at `context.ts:131`, extend `validateParallelism`
   (`validate-options.ts:117–125`) over both members, wire `ctx.concurrency` through
   `repository.ts:621`/`:528`/`:654` and the three raw factories, thread the fallback field
   through `AdapterSet`/the `index.node.ts:101–130` fallback object.
9. **GREEN** — re-point `walk-commits.ts:50` and `commit-date-walk.ts:91`.
10. **REFACTOR** — every bound is a named constant; no function over 20 lines; no `any`;
    `src/ports/index.ts` gains one alphabetically-placed `export type` line.
11. **Surface gate (pre-pay it here)** — `npm run docs:json`, commit `reports/api.json`
    (the widened `parallelism` type is public; the typedoc-id churn is normal).
12. **Oracle (R18, R20)** — the matrix above; `check:architecture` green;
    `check:tarball` green (no `node:` reachable from `index.default.js`); the runtime-parity jobs
    (deno/bun/workerd) still green with workerd taking the floor.

### Gate

- Part gate: `npx vitest run test/unit/domain/concurrency test/unit/adapters/node/node-concurrency.test.ts test/unit/application/primitives/internal/concurrency.test.ts test/unit/repository/validate-options.test.ts test/unit/ports && npm run check:types && ./node_modules/.bin/biome check src/domain/concurrency src/adapters/node/node-concurrency.ts src/adapters/browser/browser-concurrency.ts src/ports/context.ts src/ports/index.ts src/repository.ts src/repository/validate-options.ts src/application/primitives/internal/concurrency.ts`
- Targeted extras (all required, this part trips all of them):
  `npm run check:architecture` · `npm run check:tarball` · `npm run check:size` ·
  `npm run docs:json` + commit `reports/api.json` · `npm run test:coverage` scoped to the new
  domain/ports/adapter files (100 % required).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(ports): derive concurrency limits from the limiting resource`

---

## Part 4 — One pool authority: every bound comes from a bucket

### Context

Design §P1 (Proposed shape 4 · "Pools nest, and the nesting multiplies" · "What P1 changes
behaviourally") · **ADR-719** · **R18**. Consumes Part 3's `limitFor`. Behaviour-preserving in
*results*, **not** in *bound values* — every re-pointed pool must be A/B'd, not assumed neutral.

**Public-surface decision, made here:** `JoinOptions.concurrency`
(`src/application/primitives/snapshot/join.ts:9`, interface L8–11) is **declared and never
read** — the only `opts.` reads in the file are `opts.signal` (L61) and the pass-throughs at
L54/L73 — and `JoinOptions` is publicly re-exported from `src/index.ts:7`. ADR-719 requires
"wired or removed, not the status quo". `join` has **no fan-out to bound**, so wiring it would
invent behaviour nobody measured: **remove the field**. Runtime behaviour is unchanged (it was
never read); it is a type-only public delta, so regenerate and commit `reports/api.json` **in
this part** and update any `docs/use/snapshots.md` mention.

**The verified inventory this part re-points.**

| # | Site | Today | Bucket |
|---|---|---|---|
| 1 | `src/application/primitives/internal/bounded-map.ts:3` | `export const MAX_CONCURRENT_OBJECT_LOADS = 32` | `ioBound` |
| 2 | `src/application/primitives/internal/raw-subtree-prefetch.ts:55` | `PRESCAN_WINDOW = MAX_CONCURRENT_OBJECT_LOADS * 2` | `ioBound` |
| 3 | `src/application/primitives/internal/read-commit-graph.ts:33` | `DEFAULT_PREFETCH_CONCURRENCY = 8` | `ioBound` (Part 3 already re-pointed its two readers) |
| 4 | `src/application/commands/merge.ts:619` | `MAX_CONCURRENT_PATH_WRITES = 32` ("so a 10k-path merge doesn't exhaust file descriptors") | `ioBound` |
| 5 | `src/application/commands/range-diff.ts:51` | `MAX_CONCURRENT_COMMITS = 16`, consumed L100 (`Math.min(…, commits.length)`, Stryker comment L99) | `ioBound` |
| 6 | `src/adapters/node/node-file-system.ts:65` | `REMOVE_TREE_CONCURRENCY = 8`, sole caller L863 | `ioBound`, **constructor argument** |
| 7 | `src/application/primitives/snapshot-operators/hash-slot.ts:25` | `opts.concurrency ?? 4` (magic literal; `concurrency` declared L23) | `cpuBound` — **`opts.concurrency` keeps winning** |
| 8 | `src/application/primitives/snapshot-operators/load-blob.ts:72` | `opts.concurrency ?? 4` (L70; `maxInflightBytes` L73) | `ioBound` — **`opts.concurrency` keeps winning** |
| 9 | `src/application/primitives/snapshot/join.ts:9` | dead option | **removed** (above) |

**Unbounded `Promise.all` fan-outs this part bounds** (verified): `commit.ts:441`,
`merge.ts:511`, `ref-store.ts:769`, `internal/fsck/roots.ts:106`, `bundle-create.ts:218` — all
`ioBound`. **`status.ts:202` and `status.ts:351` are deliberately NOT in this part** — Part 15
reshapes them wholesale together with the index cache and the `mapStat` rebuild; touching them
twice is churn.

**Helpers to consolidate** (all verified):

| Helper | Anchor | Semantics that must survive verbatim |
|---|---|---|
| `boundedMap` | `internal/bounded-map.ts:10–29` | results in **input order**; `Promise.all` rejection semantics; **no cancellation**; `items` must be a dense array. Carries a Stryker `ArrayDeclaration` equivalence proof on the `new Array<R>(items.length)` line |
| `createConcurrencyLimiter` | `internal/concurrency-limiter.ts:14–51` (interface L10–12, `acquire` L18–26, `release` L32–39, `run` L42–49) | counting semaphore for streaming walkers; **one instance threaded through a whole recursion**. Default-parameter construction sites: `walk-raw-subtree.ts:119`, `flatten-raw.ts:112`, `diff-trees.ts:245` and `:544`; type-only in `raw-subtree-prefetch.ts` (params L60/L83/L96). Already in the pyramid allowlist |
| `createBoundedReader` | `internal/bounded-reader.ts:19–68` (interface L4–11: `start`, `forget`) | semaphore + per-id memo. Consumers `walk-commits.ts:51`, `commit-date-walk.ts:97`. **Not** in the pyramid allowlist today |
| `mapConcurrent` | `node-file-system.ts:107–128` (doc L90–106, Stryker comments **L112** and **L120**) | "workers keep draining the queue after a rejection" — documented and different from `boundedMap`. **Lives in the adapter and may not import from `application/`** — it keeps its own copy and takes its limit as a `NodeFileSystem` constructor argument (ctor **L464–483**) |
| `runBounded` | `merge.ts:663–669`, calls L648/L654 | result-discarding wrapper over `boundedMap` |

**Not in scope:** the close-only `Promise.allSettled` drain in `pack-registry.ts` (`:379–402` is
the `readSlice` handle acquisition) — a *shutdown* fan-out, not a work pool.

**The nesting bug this makes visible.** `detect-similarity-renames.ts:394` is a 2-arity
`Promise.all` whose *each* arm runs `hydrateIds → boundedMap(…, 32)` — **64 object loads in
flight, not 32**. A stage-named policy makes it visible; fix it by sharing one limiter across
both arms rather than nesting two pools.

**Mutation obligations moving with this part:** `bounded-map.ts`'s `ArrayDeclaration` proof and
`mapConcurrent`'s two proofs (`node-file-system.ts:112`, `:120`) sit on lines this part rewrites
— **re-prove each against the new structure or remove it**; a proof carried forward across a
structural change is falsified by construction. `range-diff.ts:99`'s proof likewise.

**Pyramid budget:** `test-pyramid-budgets.json` (repo **root**, not `tooling/`) —
`heuristics.sutBindsResult.allowlist` already names `createConcurrencyLimiter`; if this part
introduces or renames a factory whose tests bind its result to `sut`, add it in the same commit
or `check:test-pyramid` reddens.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/concurrency.test.ts`: `Given a Context
   and the ioBound bucket` / `Then the pool runs at most that many tasks concurrently`, proved by
   a max-in-flight counter (not by timing). Fails: the bucket-taking entry points do not exist.
2. **RED** — same file, per surviving semantic: `Then results come back in input order`
   (`boundedMap`); `Then a rejection propagates and in-flight tasks are not cancelled`;
   `Then the adapter pool keeps draining after a rejection` (`mapConcurrent`'s documented and
   *different* contract — its own test, in the adapter's suite). Three separate tests: one
   combined test cannot kill the mutants on each clause.
3. **RED** — `test/unit/application/primitives/snapshot-operators/hash-slot.test.ts` and
   `load-blob.test.ts`: `Given opts.concurrency is set` / `Then it wins over the derived bound`;
   `Given opts.concurrency is absent` / `Then the derived bound is used`. Fails: still `?? 4`.
4. **RED** — `test/unit/application/primitives/internal/detect-similarity-renames.test.ts`:
   `Given both rename-detection arms run` / `Then the total object loads in flight never exceed
   the ioBound limit` (a max-in-flight counter across both arms). Fails: 2 × the limit today.
5. **RED** — the newly-bounded fan-outs: one max-in-flight test each for `commit.ts:441`,
   `merge.ts:511`, `ref-store.ts:769`, `internal/fsck/roots.ts:106`, `bundle-create.ts:218`.
6. **GREEN** — consolidate the helpers behind the bucket-taking module; re-point sites 1–8;
   pass `REMOVE_TREE_CONCURRENCY`'s replacement into `NodeFileSystem`'s constructor
   (L464–483) with the existing value as the default so no caller changes behaviour by accident.
7. **GREEN** — remove `JoinOptions.concurrency` (`join.ts:9`) and its doc mention.
8. **REFACTOR** — delete the now-duplicated helpers; no site retains a bare numeric bound;
   re-prove or remove the three Stryker equivalence comments named above.
9. **Surface gate** — `npm run docs:json`, commit `reports/api.json` (`JoinOptions` shrank).
10. **Oracle** — A/B through `tooling/bench-ab.ts` on `log`, `status`, `merge`, `diff` and
    `range-diff`: bound **values** change (32 → `ioBound`, which is 32 on an 11-core/4-wide
    machine and 8 under `UV_THREADPOOL_SIZE=1`), so report absolute base/current columns and
    state the machine. A regression here is a real finding, not noise.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/internal test/unit/application/primitives/snapshot-operators test/unit/adapters/node/node-file-system.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/range-diff.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal src/application/primitives/snapshot src/application/primitives/snapshot-operators src/application/commands/merge.ts src/application/commands/range-diff.ts src/adapters/node/node-file-system.ts`
- Targeted extras: `npm run check:test-pyramid` (allowlist) · `npm run docs:json` + commit
  `reports/api.json` · `npm run check:architecture` (the adapter must still not import from
  `application/`).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`refactor(primitives): route every bounded fan-out through the concurrency policy`

---

## Part 5 — Memoise the per-command gate verdict, and fix the scoped-cache invalidation it depends on

### Context

Design §P2 → F5 (+ its rider) · §0.1 invariant-route checklist, row 1. Behaviour-preserving,
no ADR, no new public surface.

**Anchors (re-verified — several design anchors are corrected here).**

| Thing | Anchor |
|---|---|
| source of truth | **`src/application/primitives/internal/repo-state.ts`** (355 lines). `src/application/commands/internal/repo-state.ts` is a **15-line deprecated re-export shim** and does **not** re-export `assertAcceptedRepository` |
| the gate chain | `assertOperationalRepository` **275–279** → `assertAcceptedRepository` **260–266** → `assertRepository` **97–104** → `hasUsableHead` **116–126** (**2 fs calls**) → `assertDiscoveryBooleansValid` **79–86** (2 token walks) → `assertTrusted` **241–249** (sync, zero I/O) → `assertEagerConfigValid` **193–226** (**6 token finders in one `Promise.all`**) |
| ⚠️ corrected | **`formatRefusal` does not exist** — the nearest symbol is the private `throwFormatRefusal(refusal: RepositoryFormatRefusal): never` at **228–231** |
| ⚠️ corrected | **`pickLowerLine` is `internal/repo-state.ts:61–68`**, not `config-read.ts`: `<T extends { readonly line: number }>(a: T \| undefined, b: T \| undefined) => T \| undefined` |
| ⚠️ corrected count | **95 gate call sites in `src/`**, not 88: `assertOperationalRepository` **80** across 49 command files; `assertAcceptedRepository` **11** (`remote.ts` 117/132/172/229/299/322, `config.ts` 153/182/217/244/269); `assertRepository` **4** (`config.ts` 47/67/94/123). `openRepository` does not run the gate, so nothing amortises it |
| `hasUsableHead` verbatim | `116–126`: `readlink(headPath).catch(() => undefined)` → `isRefsLinkText(linkText)`; else `readUtf8(headPath).catch(() => undefined)` → `head !== undefined && isValidHeadContent(head)`. Carries a "discovery-tier" comment: it runs **before a ref backend exists**, so it stays a raw files-layout probe |
| the finders | `src/application/primitives/config-read.ts`: `findFirstValuelessEntry` **269**, `findFirstValuelessInSection` **311**, `findFirstInvalidCompression` **372**, `findLastInvalidMaxTreeDepth` **438**, `findFirstRejectedBoolean` (private) **1216**, `findFirstInvalidBoolean` **1249**, `findFirstInvalidBooleanInSection` **1265**, `findFirstInvalidLogAllRefUpdates` **1284**, `findFirstInvalidPushGpgSign` **1299**. Each opens with `await readConfigEntry(ctx)` |
| the config cache they read | `config-read.ts:156` — `let cache: WeakMap<Context, Promise<ConfigCacheEntry>> = new WeakMap();` (`ConfigCacheEntry` 147–150, `readConfigEntry` **179–185**, `__resetConfigCacheForTests` 188–190). So the finder walks are **in-memory array scans, not I/O** |
| invalidation | `invalidateConfigCache` **201–203** — body is only `cache.delete(ctx);`. Docstring **193–200** claims it also drops the per-scope sections cache; **it does not, and `config-read.ts` does not even import `config-scoped-read.js`** |
| the scoped cache | `src/application/primitives/config-scoped-read.ts`: WeakMap **16–19**, `invalidateScopedConfigCache` **31–33**, `readSingleScopeUncached` **45–64** with the catch at **60** (`FILE_NOT_FOUND` **or** `PERMISSION_DENIED` → `[]`, everything else rethrown), `readConfigSections` 110–127. False docstrings at **14–15**, **28** and **100–102** |
| ⚠️ corrected path | the writers are **`src/application/primitives/update-config.ts`** (721 lines), not `commands/`. **`:434`** (inside `updateConfigEntries` 421–435) and **`:561`** (inside `updateConfigOperations` 552–562) call `invalidateConfigCache(ctx)` **alone**; `:622/:623`, `:689/:690`, `:719/:720` and `update-config-sections.ts:262/:263`, `:293/:294` correctly call **both**. Both invalidation helpers are re-exported from `primitives/index.ts:21` and `:28` |
| the interop pin | `test/integration/max-tree-depth-config-interop.test.ts` |

**What lands.**

1. **The gate-verdict memo.** A tenth per-Context `WeakMap<Context, Promise<FilePath>>`
   memoising the **config-derived** half of the verdict — `assertDiscoveryBooleansValid` +
   `assertEagerConfigValid` + `assertTrusted` + the returned `FilePath`. It is a pure function of
   the token stream plus `ctx.layout`, both immutable for a Context's life.
2. ⚠️ **`hasUsableHead` stays per-command and is NOT memoised.** It is what notices an
   externally deleted or rewritten HEAD between two commands on the same Context. What changes is
   its *cost*: collapse the two reads into **one `lstat`-discriminated read** — **not** a single
   `readUtf8`. The `readlink`-then-`readUtf8` order mirrors git's `validate_headref` (a symlinked
   HEAD is judged by link text, a regular file by content), and the `.catch(() => undefined)`
   arms deliberately collapse absent/EACCES/EISDIR/EIO into one verdict; both properties survive.
3. **The memo must be invalidated wherever `invalidateConfigCache` fires**, or a mid-session
   `git config core.sparseCheckout=bogus` write stops refusing.
4. **Rider — a real defect found while verifying.** Fix the two writers
   (`primitives/update-config.ts:434`, `:561`) to call `invalidateScopedConfigCache` as well, and
   correct the four false docstrings (`config-read.ts:193–200`,
   `config-scoped-read.ts:14–15`, `:28`, `:100–102`).

**Traps.**

- `assertEagerConfigValid`'s `core.maxTreeDepth` ordering is **pinned against measured git**:
  thrown **before** the five-way `pickLowerLine` reduction, and **last-wins** where every other
  key is first-wins. Any merge-the-walks refactor must preserve which of two malformed keys
  refuses first — `test/integration/max-tree-depth-config-interop.test.ts` is the pin.
- `pickLowerLine`'s tie-freedom rests on the tokenizer invariant that distinct keys occupy
  distinct physical lines.
- **ADR-351 already records that the tempting "skip the gate when `ParsedConfig.core` is absent"
  short-circuit is unsound.** Do not reintroduce it.
- **Invariant-route walk (design §0.1, record it in the commit body):** all 95
  `assert*Repository` call sites; all 7 `invalidateConfigCache` callers **plus** the 2 that
  currently forget the scoped cache; external mutation between commands; repository re-open;
  worktree and submodule derivation.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/repo-state.test.ts`:
   `Given two commands on one Context` / `When both run the gate` / `Then the config token
   finders run once`. Prove it with a finder spy or a `readConfigEntry` call counter, not with
   timing. Fails: the finders run per command today.
2. **RED** — same file: `Given a config write between two commands` / `Then the second command
   re-runs the gate and still refuses` (write `core.sparseCheckout=bogus` through
   `updateConfig`, assert the refusal `.data` — code **and** reason). Fails once the memo exists
   without invalidation; this is the test that must be written **before** the memo.
3. **RED** — same file: `Given HEAD is deleted between two commands` / `Then the second command
   refuses`. This is the test that forbids memoising `hasUsableHead`. Fails if the whole verdict
   is memoised.
4. **RED** — `hasUsableHead` behaviour matrix, one `it` per case: symlinked HEAD pointing at
   `refs/…`; symlinked HEAD pointing elsewhere; dangling symlink; regular file with valid
   content; regular file with invalid content; absent; `EACCES`; `EISDIR`. Assert the fs call
   **count** is 1 in the regular-file case. Fails: 2 calls today.
5. **RED** — `test/unit/application/primitives/update-config.test.ts` (and the sections sibling):
   `Given a config entry written through updateConfigEntries` / `Then a subsequent scoped read
   sees the new value`; the same for `updateConfigOperations`. Fails: the scoped cache is stale.
6. **GREEN** — the memo + its invalidation hook; the `lstat`-discriminated `hasUsableHead`; the
   two missing `invalidateScopedConfigCache` calls.
7. **REFACTOR** — correct the four docstrings; no function over 20 lines; early returns.
8. **Oracle** — `max-tree-depth-config-interop`, `config-boolean-interop` and
   `missing-value-refusal-interop` unchanged and green; A/B `log`, `rev-parse`, `status` through
   `bench-ab` (the `findFirstRejectedBoolean` frame is the target).

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-scoped-read.test.ts test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config-sections.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/primitives/config-read.ts src/application/primitives/config-scoped-read.ts src/application/primitives/update-config.ts`
- Targeted extra (faithfulness — refusal ordering moves under this refactor):
  `npx vitest run test/integration/max-tree-depth-config-interop.test.ts test/integration/config-boolean-interop.test.ts test/integration/missing-value-refusal-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(primitives): memoise the repository gate verdict and repair scoped-config invalidation`

---

## Part 6 — Parallel parent reads on the date walk, and loose reads that populate the object cache

### Context

Design §P2 → F12 and F2.3 · **R5** · §0.1 invariant-route checklist, row 2.
Behaviour-preserving; both changes sit on the object-read path, which is why they share a part.

**Anchors (re-verified; several design anchors corrected).**

| Thing | Anchor |
|---|---|
| the walk | `src/application/primitives/internal/commit-date-walk.ts` (159 lines): bound `ctx.config?.parallelism ?? DEFAULT_PREFETCH_CONCURRENCY` **:91** (Part 3 already re-pointed this to `limitFor`), `createBoundedReader(...)` **:97**, `enqueueSeeds` 125–130, **`enqueueParents` 132–138**, **`enqueueCommit` 140–159** |
| the serial edge | `enqueueParents:136` — `await enqueueCommit(ctx, walk, parent)` **inside the `for`**, one read in flight |
| the pinned graph-present path | `enqueueCommit` **143–150**: guard 143, `walk.heap.push({ oid, date: header.committerDate, value: bodyPromise })` **148**, `return` **149** — its comment states the push must happen **without awaiting the body**. Keep that arm body-await-free |
| the contrast | `src/application/primitives/walk-commits.ts:149–158` calls `bodies.start(id)` **without** awaiting — a FIFO queue needs no date at enqueue time, so the topo walk is already concurrent graph-absent. **Only the date walk is concurrency-1** |
| ⚠️ corrected | the heap is **`src/domain/commit/binary-heap.ts`** (77 lines), not `domain/storage/`. **There is no `frontier()` method** — the reference-returning accessor is **`entries()` at 74–76** (`return this.values;`, documented zero-copy). `frontier` is a `DateWalkStep` **field**: declared `commit-date-walk.ts:21`, populated `:116`. `push` 48–51, `pop` 53–63, Stryker equivalence comment **:54** |
| the comparator | `src/domain/commit/priority-queue.ts:21–22` — `precedes = (a, b) => a.date > b.date \|\| (a.date === b.date && a.oid < b.oid)`, a strict total order over `(date, oid)`; `walk.seen` guarantees distinct oids |
| the rejection pin | `test/unit/application/primitives/internal/commit-date-walk.test.ts:295–346` asserts `OBJECT_NOT_FOUND` propagation **in parent order** |
| the loose gap | `src/application/primitives/object-resolver.ts` (479 lines): `resolveObjectBytes` 40–77, deltaCache probe **56–60**, loose branch **61–66** (returns at **65**), `tryLoose` **184–188**, `readLooseCompressed` 196–208, `cacheEntry` definition **475–479**, populated only at **342** (`resolvePackChain`, `targetId`) and **432** (`resolveBaseForRefDelta`, REF_DELTA base) |
| aliasing hazard | `RawObject.content` may alias the cached buffer (`src/application/primitives/types.ts:87–88`) |
| ⚠️ corrected | **`test/parity/scenarios/read-pipeline.scenario.ts` does NOT assert call counts.** Its only `expected` block (37–52) is result shape (`readTreeEntryCount: 1`, `walkCommitsCount: 1`, `walkTreeCount: 1`, `walkWorkingTreeCount: 1`, `readIndexEntryCount: 1`, `commitId: 'fa8b886e…'`). The design's "watch the parity scenario's call counts" is wrong — **that scenario cannot pin this change**; write the cache-population assertion as a unit test with an inflate spy instead |

**What lands.**

1. **F12.** Start every selected parent's body read, **then** await, **then** push.
   Three traps the "5-line diff" framing misses:
   1. Pop order is safe (`precedes` is a strict total order over distinct oids), **but
      `entries()` returns the unsorted backing array by reference**, so sibling *push* order
      becomes completion order. **Resolve all parents first, then push in parent-array order.**
   2. `Promise.all` rejects with the first-in-**time** rejection; today a missing parent throws
      in **parent order**. Use `allSettled` + rethrow in array order (**R5**).
   3. Keep the graph-present early return (143–150) body-await-free.
2. **F2.3.** Call `cacheEntry(ctx.deltaCache, id, loose)` before returning at `object-resolver.ts:65`.
   Consequences to own: the cached buffer is now handed to consumers that may alias it
   (`types.ts:87–88`) — it must be treated as **immutable** by every consumer; and the 16 MiB
   delta-cache budget is now shared with loose bytes, so **demand goes up before it goes down**.
   That is exactly why Part 9's `(pack, offset)` cache lands in a different part with an A/B
   between them.
3. **Invariant-route walk (§0.1 row 2, record in the commit body):** every `writeObject` path
   (the loose fanout cache is invalidated only by tsgit's own writes, so a test or peer process
   writing via real `git` needs a **fresh Context**); `refresh()`; `dispose()`.

**Mutation.** `binary-heap.ts:54`'s equivalence proof is only owed a re-proof **if this part
rewrites that line**; the push/`entries()` reference-return semantics are load-bearing either way
and must be asserted, not assumed.

### TDD steps

1. **RED** — `commit-date-walk.test.ts`: `Given a commit with three parents` / `When the walk
   enqueues them` / `Then all three body reads are started before any is awaited` (a read spy
   recording start order and max-in-flight ≥ 2). Fails: strictly one in flight.
2. **RED** — same file: `Given two parents whose reads both fail, the second failing first in
   time` / `Then the rejection is the first parent's` — the `allSettled`-ordering test. Extend
   `:295–346` rather than replacing it. Fails: `Promise.all` surfaces the faster rejection.
3. **RED** — same file: `Given siblings whose reads complete out of order` / `Then the heap
   receives them in parent-array order` (assert against `entries()`, which returns the backing
   array by reference and therefore exposes push order).
4. **RED** — same file: `Given a commit-graph-present repository` / `Then the parent is pushed
   without awaiting its body` — the pinned 143–150 arm, asserted by resolving the body promise
   only after the push is observed.
5. **RED** — `test/unit/application/primitives/object-resolver.test.ts`: `Given a loose object
   read twice on one Context` / `When the second read runs` / `Then the compressor inflates
   once` (inflate spy). Fails: every read re-inflates.
6. **GREEN** — the parallel-then-ordered enqueue; the `cacheEntry` call at the loose return.
7. **REFACTOR** — no nesting over 2; early returns; the enqueue helper stays under 20 lines.
8. **Oracle** — `commit-graph-walk-interop` and `log-interop` unchanged and green; A/B `log`,
   `cat-file`, `show` through `bench-ab`, reporting absolute columns. **Expect the delta-cache
   hit rate to move both ways** — record it, do not tune it here.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/domain/commit/binary-heap.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/commit-date-walk.ts src/application/primitives/object-resolver.ts`
- Targeted extra: `npx vitest run test/integration/log-interop.test.ts test/integration/commit-graph-walk-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(primitives): overlap parent body reads and cache loose object bytes`

---

## Part 7 — The micro batch

### Context

Design §P2 → F15, **less two deferred riders**: the sync delta-cache-hit fast path ships in
**Part 12** (it reads ADR-718's flip) and the size-gated callback zlib ships in **Part 19**
(where it has a consumer). Behaviour-preserving, no ADR, no new surface. Every item below was
verified in place.

| Item | Anchor | What lands |
|---|---|---|
| LRU head fast path | `src/domain/storage/lru-cache.ts`: `createLruCache(maxSizeBytes, maxEntries = +Infinity)` **20–23**, `get` **78–86** (unconditional `removeNode` + `addToHead` even when the node is already head), `removeNode` 29–42, `addToHead` 44–54 | a one-line head check in `get`. Hot consumer: `NodeFileSystem`'s `parentRealpathCache` (`node-file-system.ts:446`, 128 KiB / 512 entries; cleared :730 and :783, read :910, set :915) |
| `mapStat` rebuild | `src/adapters/node/node-file-system.ts:342–374` — 11 `Number(...)` coercions (358–365), 3 predicate calls (366–368), a conditional nanosecond spread (370–372). Called at :332, :676, :682 | build the object **once**. ⚠️ **Keep `bigint: true`** — `matchesMtime` treats a missing nanosecond field as a match, so dropping it *loosens* the racy-clean guard |
| encoder singleton | `object-resolver.ts:353` — `new TextEncoder()` per call inside `prependHeader` (346–358). The singleton already exists at `src/domain/objects/encoding.ts:60–61` with `encode` 63–65 | use the existing singleton |
| path-validation pre-screens | `stepEntry` `src/application/primitives/walk-working-tree.ts:92` (called :185); `verifyPath` `src/domain/path/verify-path.ts:184`; `validateIndexPath` `src/domain/git-index/path-validator.ts:96` (call sites `index-parser.ts:118`, `synthesize-tree-from-index.ts:87`, `apply-changeset.ts:149`, `build-index-from-tree.ts:114`, `add.ts:457`, `stash.ts:393`) | character-code pre-screens on the hot path — **identical verdicts**, proved by a differential test over a hostile-path corpus |
| `resolveWrite` prefilter | `node-file-system.ts`: `resolveRead` **972–986** has the `..` prefilter at **:979** (`absolute.indexOf('..') === -1 ? absolute : this.pathPolicy.resolve(absolute)`, Stryker comment **:978**); `resolveWrite` **998–…** resolves unconditionally at **:1004** | give `resolveWrite` the same prefilter. ⚠️ if you touch :978's line, its equivalence proof must be **re-proved against the new structure or removed** |
| `requireWorkTree` hoist | definition `internal/repo-state.ts:291–296`; in `status.ts` at **:130** (once) and **:368** (`joinPath(requireWorkTree(ctx,'status'), path)` — **inside a per-path lstat**) | hoist the per-entry call out of the loop |
| promisor guard | `assertValidPromisorRemoteConfig` `src/application/primitives/internal/boolean-config-guard.ts:45`; called at **`add.ts:417`**, i.e. **inside the per-file write path** (immediately before the per-file `lstat` at :418). Every other caller hoists it to command entry (`status.ts:132`, `commit.ts:105`, `diff.ts:57`, `show.ts:124`, `fetch-missing.ts:90`, `fsck.ts:159`) | lazy-once per `add` invocation |
| async-generator layer | `commands/log.ts:58` (`walkCommitsByDate(...)`) / `:61` (`for await`); the middle layer is `primitives/walk-commits-by-date.ts:22–30` — `assertValidSeeds` (:26) then `for await (const step of commitDateWalk(...)) yield step.commit;` (27–29). **Three stacked async generators for a pure field projection** | collapse one layer, keeping `assertValidSeeds` and the public `walkCommitsByDate` signature intact |

**Do not** change `matchesMtime`'s semantics, `verifyPath`'s rejection reasons, or any error
`.data`. Every item here is a cost change with an identical verdict; a differential test over a
hostile corpus is the proof, and the assertion is on **verdict equality**, not on internals.

### TDD steps

1. **RED** — `test/unit/domain/storage/lru-cache.test.ts`: `Given the most-recently-used key` /
   `When it is read again` / `Then the list is not relinked` (assert through an observable:
   ordering across a subsequent eviction is unchanged, plus a spy on the internal move if the
   seam allows). Fails only as a perf assertion — if there is no honest observable, assert the
   **eviction order invariant** instead and record the A/B in the commit body.
2. **RED** — `test/unit/adapters/node/node-file-system.test.ts`: `Given a stat with nanosecond
   precision` / `Then mapStat preserves mtimeNs` and `Given a stat without nanoseconds` /
   `Then mapStat omits the field` — two tests, because the conditional spread's key **presence**
   is what a `toEqual` cannot see (assert `'mtimeNs' in result`).
3. **RED** — a differential test for each pre-screened validator: `Given a hostile path corpus` /
   `Then the pre-screened verdict equals the unscreened verdict` over every corpus entry
   (`.`, `..`, embedded `/`, NUL, backslash, `.git` case variants, Win32 `'.. '` / `'...'`,
   non-ASCII, empty). Fails: the pre-screen does not exist yet.
4. **RED** — `test/unit/application/commands/add.test.ts`: `Given add stages three files` /
   `Then the promisor-remote config guard runs once`. Fails: once per file.
5. **RED** — `test/unit/application/commands/status.test.ts`: `Given status over N tracked
   paths` / `Then requireWorkTree is called once`. Fails: once per path.
6. **RED** — `test/unit/application/primitives/walk-commits-by-date.test.ts`: assert the public
   iteration contract (order, values, early-`break` cleanup) still holds so the layer collapse
   is provably behaviour-preserving.
7. **GREEN** — each item, smallest change first.
8. **REFACTOR** — no magic values; named constants for any threshold; re-prove or remove
   `node-file-system.ts:978`'s equivalence proof if its line moved.
9. **Oracle** — A/B `status`, `add`, `log` and `merge` through `bench-ab`.

### Gate

- Part gate: `npx vitest run test/unit/domain/storage/lru-cache.test.ts test/unit/adapters/node/node-file-system.test.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/git-index/path-validator.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/status.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/lru-cache.ts src/adapters/node/node-file-system.ts src/application/primitives/object-resolver.ts src/domain/path/verify-path.ts src/domain/git-index/path-validator.ts src/application/primitives/walk-working-tree.ts src/application/primitives/walk-commits-by-date.ts src/application/commands/add.ts src/application/commands/status.ts src/application/commands/log.ts`
- Targeted extra: none beyond the part gate — no refusal, no on-disk byte and no public surface
  moves. If a verdict-equality test cannot be written for an item, **drop that item** rather
  than shipping it unproved.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(core): trim allocation and repeated work off the status, add and log hot paths`

---

## Part 8 — Lazy `.rev`-first pack successor lookup, threshold retired

### Context

Design §P3 → F1 · **ADR-720** · **R12**. Part 23 onward reads every object out of a pack, which
is why this lands first. In-memory strategy only — **no faithfulness surface moves**, but one
refusal-layering constraint is load-bearing and is spelled out below.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| the eager build | `src/application/primitives/pack-registry.ts` — `buildOffsetTable` closure **354–370** inside `loadPack` (280–447), memoised at **:371** (`createPromiseMemo(buildOffsetTable).get`). It does `indexMemo.get()` → **`ctx.fs.stat(packPath)`** → `entryOffsets(index)` → `resolveSortedOffsets(...)` → `trailerStart = packFileSize - ctx.hashConfig.digestLength` with `invalidPackIndex('pack file too small to contain a trailer')` |
| the boxed pass | `src/domain/storage/pack-index.ts` — **`entryOffsets` 144–150** builds a boxed `number[]` with one `push` per object; private `readOffset` **126–142** (handles the MSB-set large-offset indirection); private `searchIndexPosition` **157–187** (fanout binary search) |
| ⚠️ corrected path | `gatherByRevIndex` is **`src/application/primitives/internal/pack-positions.ts:60–72`** (there is no `src/domain/storage/pack-positions.ts`); it is a second O(N) pass gathering into a `Float64Array` with a bounds bail at **:68**. `packPositionMap` **18–26**, `revIndexPositions` **36–44** |
| the threshold | `src/application/primitives/internal/pack-offset-table.ts` — `REV_INDEX_MIN_OBJECTS = 5_000` **:68** with a 24-line docstring justifying it by a **gather-vs-sort crossover table**; `resolveSortedOffsets` **88–111**; `bisectLeft` 113–125; `nextOffsetForEntry` **127–138**; `sortAscending` 37–41; `PackOffsetTable` 16–28 |
| the `.rev` surface | `src/domain/storage/rev-index.ts` — `revIndexPositionAt(rev, p)` **173–181** (bounds-checks `p`, deliberately not the stored value); `REV_HEADER_SIZE = 12` :18; `REV_MAGIC` :16 |
| the two consumers | **exactly two, both single-entry**: `object-resolver.ts:261` (`const table = await hit.pack.offsetTable();` inside `collectDeltaChain` 249–311, hoisted out of the chain loop because `hit.pack` is invariant) and `internal/blob-source.ts:106` (a single successor lookup in `openBlobSource` 74–…, not in a loop) |
| the bulk appetite is elsewhere | `RegisteredPack.packPositions` (**:141**, memo **333–341**) returns a `Uint32Array` consumed by the bitmap tier (`internal/pack-bitmap-binding.ts:59–80`); fsck's rev-index pass calls `packPositionMap(await pack.index())` directly (`internal/fsck/rev-index-health.ts:66`). **The two memos are already structurally independent — making `offsetTable()` lazy touches two call sites and no bulk path** |
| refusal layering | `src/application/primitives/internal/pack-shared.ts` — docstring **15–19** states `INVALID_PACK_INDEX` is deliberately **absent** from `isSkippablePackFault` (**24–29**) *because* `nextOffsetForEntry`/`buildOffsetTable` throw it for mid-read corruption, and folding it in "would turn a detected corruption into a silent miss after the gate passed". `isSkippableIdxFault` (**37–41**) *does* admit it, at the scan layer |
| the three strings to preserve | `'offset not in pack index: corrupt index'` — **`pack-offset-table.ts:132`**; `'next offset exceeds pack file size: corrupt index'` — `object-resolver.ts:267`; `'slice length ≤ 0: next offset not beyond entry offset'` — `object-resolver.ts:401`. All three via `invalidPackIndex(...)` |
| the stat-count pin | `test/unit/application/primitives/pack-registry.test.ts` — `expect(statCallCount).toBe(1)` at **:2101** ("stat called exactly once across both `offsetTable()` calls", sut `pack2.offsetTable` :2094), and **2133–2173** `Given a cold pack obtained from all() with the stat counter reset` > `When 8 offsetTable() calls run under Promise.all` > `Then ctx.fs.stat was called exactly once and all 8 results are the same object reference` (:2167–2170). **The contract is: exactly one `ctx.fs.stat` per pack, single-flight, identical object to every caller** |
| the Stryker proof this falsifies | `pack-offset-table.ts:130` — a `ConditionalExpression,EqualityOperator` equivalence written **specifically about `bisectLeft` over a `Float64Array`**. Replacing the structure falsifies it by construction |

**What lands.**

1. **The lazy successor.** With a usable `.rev`, `p ↦ readOffset(index, revIndexPositionAt(rev, p))`
   is monotonic, so the successor of an entry at byte offset `o` is found by binary-searching `p`
   and reading `p+1` — **O(log N) `DataView` reads, zero allocation**. `readOffset` is private, so
   add a domain function `offsetAtPackPosition(index, rev, p)` in `pack-index.ts` rather than
   exporting `readOffset` (keeps the large-offset indirection in one place).
2. **Keep the memoised table as the no-`.rev` fallback**, but build it **straight into a
   `Float64Array`** — drop the boxed `number[]` intermediate (`entryOffsets` stays for its other
   callers; the fallback stops going through it).
3. **Retire `REV_INDEX_MIN_OBJECTS`** (ADR-720). **Delete the constant and its docstring** rather
   than setting it to zero, so the next reader does not go looking for a trade-off that no longer
   exists. After this part the discriminator is **artefact presence, not object count**: a
   present, loadable `.rev` always wins; a missing or unreadable one falls back. An out-of-range
   `.rev` value **degrades the pack to the fallback** exactly as the gather's bounds check
   (`pack-positions.ts:68`) does today — the degrade path is preserved, only its trigger moves.
4. **Still owe the stat.** A lazy design still needs `packFileSize`/`trailerStart`, so the
   `ctx.fs.stat(packPath)` stays — and the single-flight, one-stat-per-pack contract above must
   stay green **unchanged**.
5. **Midx repos fix themselves transitively**: `PackLookupHit` is `{ pack, offset }` with no midx
   provenance, so a midx hit pays the owning pack's full `.idx` parse **and** table build today.
6. **ADR housekeeping owed by this part.**
   `docs/adr/625-one-shared-pack-offset-sort-for-idx-and-rev.md` currently reads
   `- **Status:** accepted — **adopted-as-recommended (no user judgment)**` with no forward
   pointer; ADR-720 refines it (the shared sort shrinks to the no-`.rev` fallback). Add
   `· **Refined by:** ADR-720` to that header bullet. ⚠️ **Two files are numbered 625** — cite by
   filename, never by number.

**Invariant-route walk (§0.1 row 3, record in the commit body):** `registry.refresh()` (offsets
are only meaningful within a generation), `dispose()`, midx rebind, and a pack file replaced
under a live handle.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/pack-offset-table.test.ts`:
   `Given a pack with a usable .rev` / `When the successor of an entry is requested` /
   `Then no sorted-offset table is built` (spy the fallback builder / assert `entryOffsets` is
   not called). Fails: the table is built eagerly today.
2. **RED** — same file: `Given a pack whose .rev is absent` / `Then the fallback table answers
   the same successor offset`; and `Given a pack whose .rev holds an out-of-range position` /
   `Then the pack degrades to the fallback` (not a throw). Separate tests.
3. **RED** — `Given a pack with large offsets (MSB set in the .idx)` / `Then the successor is the
   large offset` — the `readOffset` indirection, which a naive `getUint32` reimplementation gets
   wrong silently.
4. **RED** — corruption layering, one test each: `Given an offset absent from the pack index` /
   `Then it throws INVALID_PACK_INDEX with reason 'offset not in pack index: corrupt index'`;
   `Given a successor beyond the pack file size` / `Then reason is 'next offset exceeds pack file
   size: corrupt index'`; `Given a successor not beyond the entry offset` / `Then reason is
   'slice length ≤ 0: next offset not beyond entry offset'`. Assert `.data` (code **and**
   reason), never the class.
5. **RED** — `Given a corrupt .idx at the lookup layer` / `Then INVALID_PACK_INDEX is NOT
   swallowed as a skippable pack fault` and its sibling `Given the scan layer` / `Then it IS
   skippable`. This pair is what stops a corrupt `.idx` becoming a silent `OBJECT_NOT_FOUND`.
6. **RED** — a property test (lens 3): `Given an arbitrary pack layout` / `Then the lazy
   successor equals the sorted-table successor for every entry` — the two implementations are
   independently derived, so this is an invariant, not a tautology.
7. **GREEN** — `offsetAtPackPosition` in the domain; the lazy path in `pack-offset-table.ts`;
   the `Float64Array`-direct fallback; delete `REV_INDEX_MIN_OBJECTS` and its docstring.
8. **REFACTOR** — re-prove `pack-offset-table.ts:130` against the new structure **or remove it**;
   likewise `pack-index.ts:167` and `:238` if `searchIndexPosition`/`readOffset` move. Never
   carry a proof forward across a structural change.
9. **Oracle (R12)** — `test/bench/pack-offset-table.bench.ts` (Part 2 raised its fixture to
   ~8 000): the many-object scenario shows a strictly lower median ms, **and** the `.rev`-present
   and `.rev`-absent rows now exercise different code paths. A/B `pack-read`, `cat-file` and
   `midx-lookup` through `bench-ab`.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/internal/pack-offset-table.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/domain/storage/pack-index.test.ts test/unit/domain/storage/rev-index.test.ts test/unit/application/primitives/internal/pack-positions.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/pack-offset-table.ts src/application/primitives/internal/pack-positions.ts src/application/primitives/pack-registry.ts src/domain/storage/pack-index.ts src/domain/storage/rev-index.ts`
- Targeted extra (faithfulness — corrupt-pack refusals are in the blast radius):
  `npx vitest run test/integration/packfile-interop.test.ts test/integration/rev-write-interop.test.ts test/integration/midx-interop.test.ts test/integration/fsck-interop.test.ts test/integration/sha256-object-format-interop.test.ts test/integration/large-object-pack-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(pack): answer successor lookups from the reverse index instead of a sorted table`

---

## Part 9 — An offset-keyed delta base cache

### Context

Design §P3 → F10 · **R13** · §0.1 invariant-route checklist, row 3. Lands after Part 8 so the
A/B between them is readable, and after Part 6 so the loose-cache demand shift is already priced
in.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| the gap, documented in-source | `src/application/primitives/object-resolver.ts:322–326` — mid-chain intermediates have no known `ObjectId`, so an OFS chain caches only its tip |
| the cache today | `ctx.deltaCache: LruCache<Uint8Array>` keyed by hex `ObjectId`; probed at `object-resolver.ts:56–60`, `:422` (`resolveBaseForRefDelta`) and `internal/blob-source.ts:89`; populated **only** at `:342` (`targetId`) and `:432` (REF_DELTA `baseId`) via `cacheEntry` (**475–479**) |
| the chain | `collectDeltaChain` **249–311**; the pack hit's table is fetched once at **:261** |
| the LRU | `src/domain/storage/lru-cache.ts`: `createLruCache(maxSizeBytes, maxEntries = +Infinity)` **20–23**; `set` **88–110** — **throws** on `byteSize <= 0` (**89–91**, `'byteSize must be positive'`) and **silently drops** an entry larger than `maxSizeBytes` (**92–94**); `evict` 56–63 |
| the registry | `createPackRegistry` in `src/application/primitives/pack-registry.ts`; `refresh()` **784–807**; `dispose()` **825–846**; the per-Context registry map is `read-object.ts:15` with `adoptPackRegistry` **38–40** and `refreshPackRegistry` **49–51** |
| identity anchor — do not repurpose | `ctx.deltaCache` is load-bearing as an **identity anchor**: `internal/load-reftable-stack.ts:91` keys on it, and `fsck.ts:76` swaps in `createNoDeltaCache()` |

**The load-bearing choice, settled by the design.** A `(packName, offset) → { type, content }`
cache hangs **per-registry, cleared by `refresh()`** — **not** per Context. `(packName, offset)`
is only meaningful **within a generation**; a Context-scoped cache would survive a `refresh()`
that invalidated the packs, which is a **correctness bug**, not a tuning choice. It shares the
existing byte budget through a second `LruCache` sized from the same `deltaCacheMaxBytes`.

Storing the `(type, content)` **pair** avoids re-`splitHeader` on hits. Probe it in
`collectDeltaChain` **before descending**; populate per level in the bottom-up apply loop.

**Budget interaction to handle explicitly:** `LruCache.set` throws on `byteSize <= 0` (an empty
inflated intermediate is possible) and silently drops an over-cap entry (a large intermediate
simply never caches — documented behaviour, not a bug to work around). Use a floor-at-1 sizer,
following `load-reftable-stack.ts`'s `stackByteSize` pattern.

### TDD steps

1. **RED** — `test/unit/application/primitives/object-resolver.test.ts`: `Given an OFS delta
   chain read twice` / `When the second read runs` / `Then the mid-chain bases are not
   re-inflated` (inflate spy counting per level). Fails: only the tip caches today.
2. **RED** — same file: `Given a chain whose base was cached under (pack, offset)` /
   `Then the cached type is reused without re-splitting the header`.
3. **RED** — **the correctness test**: `Given the pack registry is refreshed` /
   `When the same (pack, offset) is read again` / `Then the stale entry is not served`
   (write different bytes at the same offset in a replaced pack generation). This is the test
   that forbids a Context-scoped cache; write it before the cache exists.
4. **RED** — `Given an intermediate larger than the byte cap` / `Then it is not cached and the
   read still succeeds`; and `Given a zero-length intermediate` / `Then the sizer floors at 1
   and set does not throw`. Two separate tests — the drop branch and the throw branch are
   different guards.
5. **RED** — `Given fsck's Context with createNoDeltaCache()` / `Then no offset-keyed entry is
   retained` — proves the new cache did not quietly re-enable object-byte caching for fsck.
6. **GREEN** — the second `LruCache` on the registry, cleared in `refresh()` (784–807) and
   released in `dispose()` (825–846); probe/populate in `collectDeltaChain`.
7. **REFACTOR** — one sizer, one key builder, both named; no magic values.
8. **Oracle (R13)** — `test/bench/delta-chain-read.bench.ts` cold row shows a strictly lower
   median ms (the fixture is ~43 deep at `--depth=50 --window=250`, exactly the shape this
   targets). A/B it against `main` through `bench-ab`, and re-measure `log`/`show` to price the
   shared-budget interaction with Part 6's loose bytes.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/domain/storage/lru-cache.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/pack-registry.ts`
- Targeted extra: `npx vitest run test/integration/packfile-interop.test.ts test/integration/large-object-pack-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(pack): key the delta base cache on pack offset so OFS chains cache every level`

---

## Part 10 — Byte-level tree path descent that keeps the duplicate-name refusal

### Context

Design §P4 (fix 1 + the faithfulness constraints) · **ADR-723** · **R4**. Split from Part 11 so
the descent rewrite and the blame-specific caching are reviewable separately; Part 11 builds on
this one.

**Anchors (re-verified; two design anchors corrected).**

| Thing | Anchor |
|---|---|
| the descent | **`src/application/primitives/internal/resolve-tree-path.ts`** (53 lines): `descendTreePath` 17–26; **`findTreeEntry` 34–50** — `async (ctx, root: ObjectId \| Tree, path: string): Promise<TreeEntry \| undefined>`, segment loop **42–48**, per segment a linear `findEntry` then a **full `readObject(ctx, entry.id)` at :45** (a parsed `Tree`, not a raw cursor); private **`findEntry` 52–53** — `tree.entries.find((c) => c.name === name)` |
| the cost per entry | `src/domain/objects/tree.ts` — `parseTreeContent` **31–73** costs, per entry: 3 `subarray` allocations, 2 `TextDecoder` calls, an `ObjectId.fromRaw` hex string, a `normalizeFileMode` lookup, a `Set` has+add, and an object push — **for every entry, to find one** |
| the refusal to preserve | `tree.ts:64–66`, verbatim: `if (names.has(name)) { throw invalidTreeEntry(offset, \`duplicate entry name: ${name}\`); }`. Other throws in the same parser: :39 `'missing space after mode'`, :46 `'missing null after name'`, :51 `` `invalid entry name: ${name}` ``, :57 `'truncated hash'` |
| the tools already in the tree | `src/domain/objects/tree-cursor.ts` (195 lines): **`openTreeCursor(buf, hash) 38–52`**, `advanceCursor 54–61`, **`compareCursorNames 130–147`** (byte-wise with the virtual trailing `/`), **`cursorsSame 149–151`** (raw oid bytes), **`cursorName 185–187`**, **`cursorOid 189–191`**, **`cursorMode 193–195`**. `computeIsDir` is **private, 110–121** — it accepts arbitrary-length octal and refuses **lazily** at `cursorMode` |
| raw tree I/O | `src/application/primitives/internal/raw-tree-io.ts`: `readRawTreeById` **14–18**, `joinPath` **20–22** |
| the ordering trap | git sorts as if a directory name carried a trailing `/` (`treeEntryCompare` `tree.ts:113–…`; `compareCursorNames` `tree-cursor.ts:130–147`), and **`parseTreeContent` never verifies sort order** |
| existing unit coverage | `test/unit/application/primitives/internal/resolve-tree-path.test.ts` (267 lines): `describe('descendTreePath')` **:18** (Givens at 19/39/68/91/108/130) and `describe('findTreeEntry')` **:150** (Givens at 151/172/191/221). **No property sibling exists** |
| downstream consumers | `blame`, `read-file-at`, and `rev-parse <tree-ish>:<path>` |

**What lands.** Rewrite `findTreeEntry`'s descent onto the cursor: compare **name bytes**,
compare oids as **raw bytes**, hex **only at the leaf**.

**Three constraints that are the whole point of ADR-723:**

1. **The duplicate-entry-name refusal is re-implemented in the descent**, not dropped. A
   per-directory `Set` over the names of **the directory being descended** (not the whole tree),
   throwing the same `invalidTreeEntry(offset, \`duplicate entry name: ${name}\`)` with
   **byte-identical error data**. The raw cursor path does not have this refusal today —
   `flatten-raw.ts`'s `validatedName` checks only `.`, `..` and embedded `/` — so swapping onto
   the cursor naively would *silently* drop it for three public surfaces. The `Set` is a cost
   `parseTreeContent` already pays; the saving comes from **not decoding and not hexing**.
2. **Mode validation stays eager per visited entry on the descended directory.** `computeIsDir`
   (110–121) accepts arbitrary-length octal and refuses lazily at `cursorMode`, so without an
   explicit eager `normalizeFileMode` call a malformed sibling mode would refuse later, or never.
3. **Do not replace `findEntry`'s linear scan with a binary search** without git's comparator.
   `parseTreeContent` never verifies sort order, so an unsorted-but-currently-accepted tree that
   `findEntry` resolves today would start returning `undefined` — `PATH_NOT_IN_TREE` where git
   finds the file is a faithfulness regression.

**No interop re-pin is owed** for the refusal (ADR-723): the refusal is *preserved*, so the unit
+ property coverage is the gate. ADR-723 also records the question it deliberately left open —
whether git itself refuses duplicate entry names outside `fsck`/`mktree` is **unpinned**, and the
divergence option only reopens if a future probe settles it. **Do not assume it here.**

**Property test owed** (`resolve-tree-path.properties.test.ts`, lens 2/3), beside the example
test, generators in the directory's `arbitraries.ts`.

### TDD steps

1. **RED** — extend `resolve-tree-path.test.ts` under `describe('findTreeEntry')` (:150), one
   `it` per case: found at depth 1 / found at depth 3 / missing final segment / missing
   intermediate segment / intermediate is a blob / leaf is a **gitlink** / leaf is a **symlink** /
   entry name that is a prefix of another (`ab` vs `ab.txt` vs `ab/`). Fails only after the
   rewrite for the byte-comparison cases; write them first as the safety net.
2. **RED** — `Given a tree with two entries of the same name` / `When the path descends into
   it` / `Then it refuses with reason 'duplicate entry name: <name>' and the same offset`.
   Assert `.data` — code, reason **and** offset. Fails: the cursor path has no such refusal.
3. **RED** — `Given a sibling entry with a malformed mode` / `When another entry in the same
   directory is resolved` / `Then it refuses eagerly` — the constraint 2 test.
4. **RED** — `Given a tree whose entries are not in git's sort order` / `Then the entry is still
   found` — the constraint 3 test, which a binary-search implementation fails.
5. **RED** — **new** `test/unit/application/primitives/internal/resolve-tree-path.properties.test.ts`
   (lens 2/3, `numRuns: 100`): `Given an arbitrary tree grammar` / `Then the cursor descent
   resolves exactly the paths the parsed-tree descent resolves`, with `parseTreeContent` +
   `findEntry` as the **independently-implemented oracle** (not a copy of the production loop).
   A second property: `Then any tree containing a duplicate name refuses`.
6. **GREEN** — the cursor descent, hexing only at the leaf.
7. **REFACTOR** — one helper per concern (`descend one level`, `compare a segment`), all under
   20 lines; no `any`; the `Set` scoped to a single directory and dropped on descent.
8. **Oracle** — `blame-interop` (`test/integration/blame-interop.test.ts`, top-level describe at
   **:154**, matrix `it.each` **:292–314**, comparing tsgit's rendered porcelain **byte-for-byte**
   against real `git blame --porcelain`) stays green, plus `tree-interop` and
   `tree-depth-interop`. A/B `blame` and `cat-file` through `bench-ab`.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/internal/resolve-tree-path.test.ts test/unit/application/primitives/internal/resolve-tree-path.properties.test.ts test/unit/domain/objects/tree-cursor.test.ts test/unit/domain/objects/tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/resolve-tree-path.ts src/domain/objects/tree-cursor.ts`
- Targeted extra (a refusal is re-implemented — prove it against real git's consumers):
  `npx vitest run test/integration/blame-interop.test.ts test/integration/tree-interop.test.ts test/integration/tree-depth-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(primitives): descend tree paths over raw bytes, keeping the duplicate-name refusal`

---

## Part 11 — Blame: oid short-circuit, pre-split lines, carried commit data

### Context

Design §P4 (fixes 2–4) · **R14**. Builds on Part 10's cursor descent.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| the suspect | `src/application/commands/blame.ts` (439 lines), `Suspect` **100–107**: `{ commit, path, blob, blobId, entries }`. `Scoreboard` 109–113 |
| the walk | `processSuspect` **256–…** — `readCommitData` **:257**, `const childLines = splitLines(suspect.blob)` **:258**, parent loop 261–268 (`resolveInParent` :262, Stryker disable :266, `break` :267) |
| the parent hop | `resolveInParent` **358–378** — `blobTreeEntry` **:367** (a full descent), TREESAME short-circuit **:370** (Stryker disable :369), `readBlob` :371 and :376 |
| scheduling | `schedule` **404–416** — empty-guard :414 (Stryker disable :413), `sb.queue.push` :415. **It discards the parent's `CommitData`**, so the parent re-reads and re-parses when it pops (worse than 2× on a merge commit) |
| leaf lookup | `blobTreeEntry` **419–428** — delegates to `findTreeEntry` :424 and treats **DIRECTORY and GITLINK leaves as absent** :426. `blobEntryAtPath` 431–439 |
| the symlink case | `readWorkingFile` **186–197** — `stat.isSymbolicLink ? LINK_ENCODER.encode(await ctx.fs.readlink(absPath)) : ctx.fs.read(absPath)` (**194–196**), `joinPath` at :191. **A "regular file" fast path would break symlink blame** |
| two `joinPath`s, same name | `blame.ts:28` imports `joinPath` from **`../primitives/internal/join-working-tree-path.js`**; `raw-tree-io.ts:20–22` exports a *different* `joinPath`. Do not cross them |
| the double split | `src/domain/diff/line-diff.ts`: **`splitLines` 52–66** returns `bytes.subarray(...)` **views** (:58, :64) — N object allocations, not copies; `diffLines` **342–348** delegates to **`diffLinesWithBound` 356–…**, which **re-splits both inputs at 363–364**; **`LineDiff` 16–21 already returns `oursLines` / `theirsLines`** |
| the same fix class | `src/domain/merge/three-way-content.ts:88–89` — `diffLines(base, ours)` and `diffLines(base, theirs)` split `base` twice (plus `splitLines(ours)`/`splitLines(theirs)` again at :92 in the degraded arm). In scope **only if it is free** |
| the bench | `test/bench/blame.bench.ts` (28 lines): `DEEP_ANCESTRY_TIERS` imported **:11**, used **:14**; one scenario titled at **:15**; sut `repo.blame('stable.txt')` :24. Tiers: `DEEP_ANCESTRY_SMALL` (50 commits), `_MEDIUM` (500), `_LARGE` (2 000, only under `TSGIT_BENCH_LARGE`) |
| the faithfulness pin | `test/integration/blame-interop.test.ts` — `describe.skipIf(!GIT_AVAILABLE)('blame interop')` **:154**; the matrix `it.each(BLAME_PORCELAIN_MATRIX)` **:292–314** compares tsgit's rendered porcelain **byte-for-byte** with real `git blame --porcelain` (`scrubNow` in worktree mode :309, exact :311) |

**What lands, in priority order.**

1. **Per-level oid short-circuit.** Carry the suspect's `[rootTree, subtree…, blob]` oid chain in
   `Suspect` (100–107). A parent whose **root tree equals the child's** is TREESAME with **zero
   tree reads**, and the first equal level stops the descent. Today the comparison happens only
   at the blob leaf (`resolveInParent:370`, reached via a full `blobTreeEntry` descent at :367).
2. **Pre-split lines.** `processSuspect:258` re-splits the same unchanged blob per generation and
   `diffLinesWithBound:363–364` re-splits both inputs internally. `LineDiff` (16–21) **already
   returns** `oursLines`/`theirsLines`, so the `changed` arm consumes them directly; the TREESAME
   and root arms still need an independent source, so carry a presplit array in `Suspect`.
3. **Carry the parent's `CommitData`.** `resolveInParent` reads each parent at :365 for its tree
   and date; `schedule` (404–416) discards it. Add the `CommitData` to the scheduled `Suspect`.
4. **`three-way-content.ts:88–89`** — same fix class; take it only if it is free, and prove it
   with the existing merge tests.

**Do not** add a "regular file" fast path (symlink blame encodes the *target string* as blob
content, `readWorkingFile:194–196`); do not treat DIRECTORY/GITLINK leaves as present
(`blobTreeEntry:426`); do not cross the two `joinPath`s.

### TDD steps

1. **RED** — `test/unit/application/commands/blame.test.ts`: `Given a parent whose root tree
   equals the child's` / `When the parent is resolved` / `Then no tree object is read` (a
   `readObject` spy counting tree reads). Fails: a full descent runs today.
2. **RED** — `Given a parent that differs only below the blamed path's first segment` /
   `Then the descent stops at the first equal level`.
3. **RED** — `Given a suspect whose blob is unchanged across three generations` /
   `Then the blob is split once`. Fails: split per generation plus twice inside the diff.
4. **RED** — `Given a merge commit with two parents` / `Then each parent commit object is read
   once` — the carried-`CommitData` test.
5. **RED** — regression guards, each its own `it`: `Given a symlink at the blamed path` /
   `Then its target string is blamed`; `Given a gitlink at the blamed path` /
   `Then the leaf is treated as absent`.
6. **GREEN** — widen `Suspect`, thread the oid chain / presplit lines / `CommitData` through
   `processSuspect` → `resolveInParent` → `schedule`.
7. **REFACTOR** — `Suspect` stays `readonly`; every new field is derived where it is first
   known, never mutated; keep `processSuspect` under 20 lines by extracting the parent hop.
8. **Oracle (R14)** — `blame.bench.ts`'s deep-ancestry tiers show a strictly lower median ms,
   A/B'd against `main` through `bench-ab` (run `small` and `medium`; `large` needs
   `TSGIT_BENCH_LARGE`). `blame-interop` byte-identical.

### Gate

- Part gate: `npx vitest run test/unit/application/commands/blame.test.ts test/unit/domain/diff/line-diff.test.ts test/unit/domain/merge/three-way-content.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/blame.ts src/domain/diff/line-diff.ts src/domain/merge/three-way-content.ts`
- Targeted extra: `npx vitest run test/integration/blame-interop.test.ts` — the byte-for-byte
  porcelain matrix is the pin for every change in this part.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(blame): short-circuit TREESAME parents by oid and stop re-splitting blobs`

---

## Part 12 — Read-path hash verification becomes opt-in

### Context

Design §P5 → F3 (+ F15's sync cache-hit fast path, which rides here because it **reads** this
flip) · **ADR-718** (supersedes ADR-389's default posture) · **R2**. The only two commands whose
observable behaviour moves are `bundle verify` and `catFile`; both end up **more** faithful.

**Why this is faithful, in one line:** Pin A measured canonical git serving *wrong bytes at exit 0*
through `cat-file`, `checkout`, `log`, `rev-list` and `show`, loose **and** packed, verifying only
in `fsck` / `verify-pack` / `bundle verify`. tsgit's `verifyHash ?? true` is **stricter than git**
— a divergence to close, not a property to defend.

**Anchors (re-verified; one design anchor corrected).**

| Thing | Anchor |
|---|---|
| the five `?? true` defaults | `src/application/primitives/read-object.ts:139` (in `readObject`, sig :134–138) and **:151** (in `readRawObject`, sig :146–150) — both `const verifyHash = options?.verifyHash ?? true;`; `walk-commits.ts:41` (in `createWalkSession`, :38) — `options.verifyHash ?? true`; `internal/commit-date-walk.ts:86` (in `commitDateWalk`, :81–84); `internal/blob-source.ts:80` — `const gate: BufferGate = { maxBufferedBytes, verifyHash: options?.verifyHash ?? true };` |
| the enforcement point | `object-resolver.ts:222–236` `verifyAndReturn(ctx, id, bytes, verifyHash)`; threaded as a **positional boolean** through `resolveObjectBytes` (:40–46) and `resolveObject` (:79–85); `blob-source.ts` fans it out at :152, :165–167, :179, :191, :199, :231, :245, :259, :351–353, :404–406; `internal/read-commit.ts:8,:27` carries it as a **required** field |
| ⚠️ corrected | there are **three** option-shaped opt-outs, not four: `fetch.ts:279` (`verifyHash: false`, with the Stryker `BooleanLiteral` proof on **:278**), `internal/fsck/content-validation.ts:78`, `internal/fsck/object-cache.ts:360` (Stryker `ObjectLiteral,BooleanLiteral` proof on **:359**). **`object-resolver.ts:430` is a *positional* `false`** — `const obj = await resolveObject(ctx, registry, baseId, false, maxBytes);` inside `resolveBaseForRefDelta` (414–434), no Stryker comment, unreachable from the `ReadObjectOptions` surface. Handle it separately |
| the two surfaces that move | `bundle-verify.ts` — `resolveExternalBase` (145–155) reads at **:147**, `isMissingObject` (178–186) reads at **:180**, both with **no options**; `cat-file.ts:41–42` builds `batchOptions` with no `verifyHash` plumbing at all (in `catFile`, 38–48) |
| the delta-cache-hit arm | `object-resolver.ts:56–60` — probes `ctx.deltaCache`, `enforceCachedCap`, then `verifyAndReturn(...)`, **re-hashing bytes tsgit itself verified** |
| the abort poll | `object-resolver.ts:230` — `checkAborted(ctx)` **between** hash and compare (`checkAborted` defined 178–182), pinned by `docs/design/primitives.md:1229` item 8: "after each `ctx.hash.hashHex(bytes)` call in `readObject` when `verifyHash: true` (ensures abort latency is bounded identically for hash-verify and I/O)" |
| the published claim to amend | `docs/understand/security.md` — `## Object integrity` heading at **:90**, the claim in the block **:90–94** (line **:92**): "Every object read through `readObject` is hashed and verified against the requested `ObjectId` … Verification is on by default …" |
| the design doc claim | `docs/design/primitives.md:399` — "**`verifyHash` defaults to `true`** (safe-by-default) … profiling showed the overhead < 1 % for typical workloads" — a claim with **no measurement artifact**, contradicted by the current profile. Also `:391` |

**Tests that INVERT (never delete).** Each of these calls the read with **no options** precisely
to kill the `?? true → false` mutant. Under the flip the surviving mutant is `?? false → true`, so
each flips to "no options ⇒ **serves** the corrupt bytes", and each keeps/gains a sibling proving
explicit `verifyHash: true` **still refuses**. Deleting them would silence the mutant, not kill it.

| File:lines | Current title | Becomes |
|---|---|---|
| `test/unit/application/primitives/read-object.test.ts:48–74` | `Given a corrupted loose file and verifyHash default true` > `When readObject is called` > `Then throws OBJECT_HASH_MISMATCH` (`data.code` at :70) | `Given a corrupted loose file and the default` > `Then it returns the bytes` |
| `read-object.test.ts:76–…` | the `verifyHash=false` counterpart | becomes the **explicit `true`** counterpart |
| `read-object.test.ts:514–546` | same for `readRawObject`, asserting `data.expected`/`data.actual` (:537–541) | same inversion |
| `read-object.test.ts:548–…` | opt-out counterpart | explicit-`true` counterpart |
| `walk-commits.test.ts:346–…` | comment at :350–352 says it exists **to kill the `?? true` BooleanLiteral mutant** | inverted; the comment must be rewritten, not dropped |
| `walk-commits-by-date.test.ts:445–…` | comment at :448 identical | inverted |
| `internal/blob-source.test.ts:447–477` | `… verifyHash default (true)` > `Then throws objectHashMismatch before returning (eager verification)` | inverted |
| `blob-source.test.ts:479–506` | the `verifyHash false` opt-out | explicit-`true` counterpart |
| `blob-source.test.ts:509+` | the streamed twin (gate at 0) | same |

Secondary sweep (verify, adjust only if they assert the default): `stream-blob.test.ts:364,636`;
`read-blob.test.ts:88–103`; `object-resolver.test.ts:371,395,745,2127`;
`commit-date-walk.test.ts:315,371`; `pack-registry.test.ts:3993`; `content-validation.test.ts`.

**Obligations that are work, not trade-offs.**

1. **Flip all five defaults to `false`.**
2. **`bundle-verify.ts` passes `verifyHash: true` explicitly** at both reads (:147, :180) — strictly
   **more** faithful than today (Pin A: git *does* verify in `bundle verify`).
3. **`catFile` stops verifying** — matching Pin A's `cat-file` row. No code change beyond the
   default; add the interop row.
4. **Replace the abort poll.** The hash-then-compare `checkAborted` (:230) disappears with the
   hash; ADR-718 requires "an explicit poll at the same point". **Not a silent deletion.**
5. **Re-prove `internal/fsck/object-cache.ts:359`** — its justification text **cites the old
   default** and is falsified by the flip. Re-write against the new structure or remove it.
6. **Forestall the newly-equivalent mutant at `fetch.ts:278`** — it disables only `BooleanLiteral`;
   under the flipped default the `ObjectLiteral` `{}` mutant on `{ verifyHash: false }` becomes
   equivalent and will survive un-suppressed. Either drop the now-redundant explicit `false` or
   widen the proof. Decide and state which.
7. **F15's sync delta-cache-hit fast path rides here** (`object-resolver.ts:56–60`): with the flip,
   the cache-hit arm no longer awaits a hash. Two obligations ride with it — (a) the arm **must
   still poll for abort before returning** (a sync return that never yields makes a cache-hot `log`
   impossible to cancel), and (b) the function **stays `Promise`-returning**; only the *body*
   short-circuits. Changing the signature would ripple through ~55 call sites for no gain.
8. **Documentation.** Amend `docs/understand/security.md:90–94` (verify-on-read stops being a
   documented property; detection is `fsck` + `bundle verify`) and `docs/design/primitives.md:399`
   (+ `:391`, + `:1229`'s poll wording). ⚠️ the design also cites `security.md:11` for a
   containment claim — **that line is about `commonDir`**; the containment statements live under
   `## Path containment` (:7) / `### Node — the write/read split` (:19). Verify before editing;
   that edit belongs to **Part 21**, not here.

**ADR-389 already carries its superseded-by-718 header** — no ADR housekeeping is owed by this part.
ADR-394 is untouched (only its option surface is referenced).

### TDD steps

1. **RED** — invert `read-object.test.ts:48–74` and `:514–546` to `Then it returns the corrupt
   bytes`, and make their siblings assert explicit `verifyHash: true` still throws with
   `data.code === 'OBJECT_HASH_MISMATCH'` **and** `data.expected` / `data.actual`. Fails: the
   default still refuses.
2. **RED** — same inversion for `walk-commits.test.ts:346`, `walk-commits-by-date.test.ts:445`,
   `blob-source.test.ts:447/479/509`, rewriting each mutant-killing comment to name the **new**
   surviving mutant (`?? false → true`).
3. **RED** — `test/unit/application/commands/bundle-verify.test.ts`: `Given a corrupt prerequisite
   object` / `When bundle verify runs` / `Then it refuses` — proves the explicit opt-in.
4. **RED** — `test/unit/application/commands/cat-file.test.ts`: `Given a corrupt object` /
   `Then catFile serves the bytes` — proves the flip reached this surface.
5. **RED** — `object-resolver.test.ts`: `Given a delta-cache hit and an already-aborted signal` /
   `Then the read rejects with the abort error` — the sync fast path's poll. Write it **before**
   the fast path, or the poll will be forgotten.
6. **RED** — `Given a delta-cache hit` / `Then no hash is computed` (hash spy).
7. **GREEN** — flip the five defaults; explicit `true` in `bundle-verify.ts:147/:180`; the sync
   cache-hit arm with its poll; leave `object-resolver.ts:430`'s positional `false` alone but
   confirm it still means "unverified".
8. **REFACTOR** — re-prove or remove `internal/fsck/object-cache.ts:359`; resolve `fetch.ts:278`;
   amend the two doc pages.
9. **Oracle (R2)** — new interop rows mirroring Pin A: `bundle verify` **refuses** a corrupt
   prerequisite; `cat-file` **serves** corrupt bytes at exit 0. Plus `commit-interop`,
   `commit-message-interop`, `blob-streaming-interop`, `loose-corrupt-precedence-interop` green.
   A/B `log`, `cat-file`, `show` — `verifyAndReturn` is a named row in the current profile.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/walk-commits.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/commands/bundle-verify.test.ts test/unit/application/commands/cat-file.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/primitives/walk-commits.ts src/application/primitives/internal/commit-date-walk.ts src/application/primitives/internal/blob-source.ts src/application/primitives/object-resolver.ts src/application/commands/bundle-verify.ts src/application/commands/fetch.ts src/application/commands/internal/fsck/object-cache.ts`
- Targeted extras: `npx vitest run test/integration/blob-streaming-interop.test.ts test/integration/loose-corrupt-precedence-interop.test.ts test/integration/commit-interop.test.ts` · `npm run check:spelling` (two doc pages change).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(primitives): make read-path hash verification opt-in, matching git`

---

## Part 13 — A byte-level commit and identity parser

### Context

Design §P5 → F4 (the parser half; the memo is Part 14) · **R1**. Pure domain work with a hard
differential oracle: the existing string parser.

**Anchors (re-verified; two design anchors corrected).**

| Thing | Anchor |
|---|---|
| the parser | `src/domain/objects/commit.ts` — **`parseCommitContent(id: ObjectId, content: Uint8Array): Commit` :46–65** (⚠️ **takes no `HashConfig`** — width tolerance comes entirely from `isValidObjectIdHex` accepting 40 **or** 64; a byte parser must derive width from the line length and must **not** grow a `hashConfig` parameter, because `parseCommitContent` is in `reports/api.json`); `parseRequiredFields` **:67–99**; `parseOptionalHeaders` :101–118 |
| the trusted-oid sites | `commit.ts:77` — `const tree = ObjectIdFactory.from(lines[0]!.slice(5));`; **`commit.ts:82`** — `parents.push(ObjectIdFactory.from(lines[i]!.slice(7)));` in the loop :81–84 (**the highest-traffic site in the codebase**); `tag.ts:94`; `snapshot/workdir-entry.ts:43` (`ObjectId.from(hex)` over `ctx.hash.hashHex`'s own output, in `computeBlobHash` :37–44). Note the import alias `import { ObjectId as ObjectIdFactory }` at `commit.ts:23` |
| ⚠️ corrected | **`serializeCommit` does not exist** — it is `serializeCommitContent(commit: Commit): Uint8Array` at **`commit.ts:120–141`** |
| the conditional spread | `commit.ts:61` — `...(gpgSignature !== undefined ? { gpgSignature } : {}),` |
| identity | `src/domain/objects/author-identity.ts` — **`parseIdentity(line: string): AuthorIdentity` :10–42**: `lastIndexOf('>')` :11, `lastIndexOf('<', lastClose)` **:16** (searched **backwards from `lastClose`**), `rawName = line.slice(0, lastOpen)` :21, **exactly one trailing space stripped** :22 (`rawName.endsWith(' ') ? rawName.slice(0, -1) : rawName`), `.trim()` :25 then `split(/\s+/)` :26, `parts.length < 2` :27 (so **trailing garbage is accepted**), `Number(parts[0])` :31 + `Number.isSafeInteger` :32 (so `"1e3"` → 1000 **accepted**, `"1.5"` rejected, negatives accepted), `/^[+-]\d{4}$/` :37 (ASCII-only `\d`). `serializeIdentity` **:46–67** with six guards (:48,:51,:54,:57,:60,:63); `CONTROL_CHARS = /[\n\r\0]/` :44 |
| the five refusal reasons | `'missing closing angle bracket'`, `'missing opening angle bracket'`, `'missing timestamp or timezone'`, `'invalid timestamp'`, `'invalid timezone offset'` — each with `line` carrying the **full original line** |
| third consumer | `src/domain/reflog/reflog-format.ts:85` — `return parseIdentity(raw);` inside `parseReflogIdentity` (:83–89), which relies on it throwing a **`TsgitError`** (never a bare `Error`) and rethrows `invalidReflogEntry('invalid identity')` |
| oid construction | `src/domain/objects/object-id.ts` — `isValidObjectIdHex` **:27–37** (module-**private**), `ObjectId.from` **:42–47** (length + per-code-unit `charCodeAt` scan), `fromRaw` **:49–57** (length check + `bytesToHex`, already documented as a trusted path). The cheaper precedent: `src/application/primitives/internal/serialize-and-hash.ts:33–36` uses `isOid` + cast, documented at :19–23 as "a single `RegExp.test` — this is a hot path" |
| already trusted, do not touch | `tree.ts:61`, `commit-graph.ts:198/247`, `read-commit-graph.ts:269` (all `fromRaw`); `midx.ts:471`, `pack-index.ts:215`, `pack-entry.ts:177`, `index-parser.ts:96/316` (already cast directly) |

**⚠️ At `commit.ts:77/82` the length check is NOT redundant** — a truncated `tree `/`parent ` line
still passes the object's own SHA check. **Only the hex-digit *scan* is provably vacuous. Drop the
scan, keep the width test.**

**Property tests owed** (neither exists today):
`test/unit/domain/objects/commit.properties.test.ts` and `author-identity.properties.test.ts`.
Template: `tag.properties.test.ts` (70 lines) — `describe('<x> properties')` > `describe('Given an
arbitrary …')` > `describe('When …')` > `it('Then …')`, a single `// Arrange + Act + Assert`
marker above `fc.assert`, `numRuns: 200` for the round trip and `100` for the invariant.
Generators already exported from `test/unit/domain/objects/arbitraries.ts`: **`arbAuthorIdentity()`
:137–152**, `arbObjectId(40|64)` :14–21, **`arbCommitMessage()` :203–205**, `arbTagName()`,
`arbArmorBlock()`.

**Two property traps, both real:**
1. `parse(serialize(x)) ≡ x` over arbitrary **bytes** is unsound — `decode()` uses a non-fatal
   `TextDecoder`, so invalid UTF-8 becomes U+FFFD and the round trip is lossy. **Generate a
   `Commit`, serialize, parse, compare structurally.**
2. `commit.ts:61` conditionally spreads `gpgSignature`, so the key is **absent** when undefined;
   `toEqual` cannot see key presence — **assert `'gpgSignature' in data`**.

### TDD steps

1. **RED** — `commit.properties.test.ts` (new): `Given an arbitrary commit` / `When serialized
   then parsed` / `Then it round-trips structurally` (`numRuns: 200`), plus
   `Then gpgSignature key presence round-trips` asserting `'gpgSignature' in data` both ways.
   Fails against the byte parser only once it exists; write it first as the differential net.
2. **RED** — `author-identity.properties.test.ts` (new): `Given an arbitrary identity` /
   `Then serializeIdentity ∘ parseIdentity is the identity` (`numRuns: 200`).
3. **RED** — `test/unit/domain/objects/author-identity.test.ts`, one `it` per pinned edge:
   a name containing `<`/`>` parses by the **last** pair; exactly one trailing space stripped
   (not `trimEnd`); `"1e3"` accepted as 1000; `"1.5"` rejected; a negative timestamp accepted;
   trailing garbage after the timezone accepted; non-ASCII digits in the timezone rejected;
   each of the five reasons asserted on `.data.reason` **and** `.data.line` carrying the full
   original line. Fails only where the byte parser diverges — that is the point.
4. **RED** — `test/unit/domain/reflog/reflog-format.test.ts`: `Given a malformed identity in a
   reflog line` / `Then it throws a TsgitError, not a bare Error`.
5. **RED** — a differential test: `Given a corpus of real commit bodies (multi-parent, octopus,
   gpg-signed, encoding header, 40- and 64-hex, CRLF in the message, empty message)` /
   `Then the byte parser's output equals the string parser's` — keep the string parser reachable
   under a test-only export while the differential runs, then delete it in REFACTOR.
6. **GREEN** — the byte parser, deriving hash width from the line length; drop the hex **scan** at
   `commit.ts:77/82` and `tag.ts:94` while **keeping the width test**; `workdir-entry.ts:43`
   adopts `serialize-and-hash.ts:33`'s `isOid` + cast shape.
7. **REFACTOR** — delete the superseded string paths; `parseCommitContent`'s exported signature is
   **unchanged** (no `HashConfig` parameter); confirm `reports/api.json` does **not** move — if it
   does, the signature changed and that is a bug in this part, not a gate to satisfy.
8. **Oracle** — `commit-interop` and `commit-message-interop` green; A/B `log`, `show`,
   `rev-parse` (the `parseRequiredFields` 32 % and `isValidObjectIdHex` 19 % rows are the target).

### Gate

- Part gate: `npx vitest run test/unit/domain/objects/commit.test.ts test/unit/domain/objects/commit.properties.test.ts test/unit/domain/objects/author-identity.test.ts test/unit/domain/objects/author-identity.properties.test.ts test/unit/domain/objects/tag.test.ts test/unit/domain/objects/object-id.test.ts test/unit/domain/reflog/reflog-format.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/commit.ts src/domain/objects/author-identity.ts src/domain/objects/object-id.ts src/domain/objects/tag.ts src/application/primitives/snapshot/workdir-entry.ts`
- Targeted extras: `npx vitest run test/integration/commit-interop.test.ts test/integration/commit-message-interop.test.ts` · `npm run test:coverage` (domain is a **100 %** gate and the `domain` mutation bucket is break 99 / low 100).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(domain): parse commit headers and identities over bytes`

---

## Part 14 — A byte-capped parsed-commit memo

### Context

Design §P5 → F4 (the memo half) · **ADR-727** · **R1**. Lands after Part 13 so the memo caches the
byte parser's output, and before Part 20, which re-keys it onto the session token.

**Anchors.**

| Thing | Anchor |
|---|---|
| where it hangs | `src/application/primitives/object-resolver.ts` — `resolveObject` (:79–85) is the parse point; `ctx.deltaCache` holds **bytes only**, so `resolveObject` re-parses on every read |
| the LRU | `src/domain/storage/lru-cache.ts` — `createLruCache(maxSizeBytes, maxEntries = +Infinity)` :20–23; `set` :88–110 **throws** on `byteSize <= 0` (:89–91) and **silently drops** an over-cap entry (:92–94) |
| the byte-sizer precedent | `src/application/primitives/load-reftable-stack.ts:100–109` `stackByteSize` — a floor-at-1 sizer with its rationale at :96–99 |
| the precedent that does **not** transfer | `src/application/primitives/internal/read-commit-graph.ts:81` `headerCache` — `WeakMap<Context, Map<ObjectId, CommitHeader>>`, cap `HEADER_CACHE_MAX_ENTRIES = 65_536` (:57), **FIFO not LRU**, with a written argument at **:76–80** that a walk touches each oid roughly once so LRU bookkeeping (~2 MiB at cap) never repays. **That argument does not transfer**: a `headerCache` miss re-derives from the already-parsed graph with **zero** further I/O, whereas a parsed-commit miss costs a **full object read**. And `headerCache` is populated only on a graph hit (`:307`), so a graph-absent repo never fills it — which is exactly the repo shape tsgit produces until Part 22's writer exists |
| what makes sharing safe | `CommitData` is **deep-readonly**, so handing the same parsed object to two callers needs no copy |

**Settled shape (ADR-727):** a **per-session byte-capped `LruCache<CommitData>`**, consulted by the
object resolver for **commits *and tags***, populated on parse, sharing the delta-cache byte budget
**by fraction**. "Per-session" is Part 20's token; **until Part 20 lands the memo is per-Context and
re-keys there** — say so in the code's naming, not in a comment that will rot.

**Two riders ADR-727 attaches, both binding:**
1. **The size fraction is A/B-measured, not picked.** The memo competes with Part 6's loose-read
   cache for the same 16 MiB, and demand shifts before it drops. Measure at ≥3 fractions and record
   the table in the commit body.
2. **"No memo, byte parser only" is the recorded fallback.** If the interaction cannot be sized
   cleanly, **drop the memo and keep Part 13** — the byte parser is the larger and simpler win, and
   a failed sizing exercise must not take it down. Escalate as
   `{ part, reason, ≤3 options }` rather than shipping an unsized cache.

### TDD steps

1. **RED** — `test/unit/application/primitives/object-resolver.test.ts`: `Given a commit read
   twice` / `When the second read runs` / `Then it is not re-parsed` (parse spy). Fails: no memo.
2. **RED** — `Given a tag read twice` / `Then it is not re-parsed` — the memo covers tags too.
3. **RED** — `Given a commit larger than the memo's byte cap` / `Then it is not cached and the
   read still succeeds` (the silent-drop branch, its own test).
4. **RED** — `Given a commit whose parsed size computes to zero` / `Then the sizer floors at 1 and
   set does not throw` (the throw branch, its own test — `if (A || B)` needs each alone).
5. **RED** — `Given entries exceeding the cap` / `Then the least-recently-used entry is evicted`
   — the property that justifies LRU over `headerCache`'s FIFO.
6. **RED** — `Given fsck's Context (createNoDeltaCache)` / `Then no parsed commit is retained` —
   fsck must not start reusing parses it deliberately isolates.
7. **GREEN** — the `LruCache<CommitData>` sized as a fraction of `deltaCacheMaxBytes`, probed and
   populated in `resolveObject`.
8. **REFACTOR** — one sizer, one key builder; no magic fraction (a named constant with the
   measured table in the commit body).
9. **Oracle** — A/B `log`, `show`, `blame` and `describe` at ≥3 fractions; record absolute
   columns. Re-measure Part 6's loose-cache workloads to price the shared budget.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/domain/storage/lru-cache.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts`
- Targeted extra: none beyond the part gate — the memo is invisible on every public surface. If it
  becomes visible, that is a bug, not a gate.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(primitives): memoise parsed commits behind a byte-capped LRU`

---

## Part 15 — Index cache, bounded status/add I/O, and the write-only stat map removed

### Context

Design §P6 → F7 · §0.1 invariant-route checklist, row 4 · **R15**. Consumes Part 3/4's policy.

**Public-surface decision, made here:** `WorkingTreeStatMap` is reachable from
`src/application/primitives/types.ts:223` (`readonly stats?: WorkingTreeStatMap` on the **public**
walk options) — so deleting it is a **public** change: regenerate and commit `reports/api.json`
**in this part**, and check `docs/use/primitives/` for a mention.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| `readIndex` | `src/application/primitives/read-index.ts:20–58` — `indexPath` :21, **`exists` :22**, **`stat` :26** (+ `exceedsMaxIndexBytes` :27), **`read` :30**, TOCTOU post-check on `bytes.length` **:33–35**, trailer split :46–47, **whole-file `ctx.hash.hashHex(payload)` :49**, checksum compare :50–52, `parseIndex` :54. `indexMtimeFrom` :15–18. **Three syscalls + a full-file hash on every `status` and every `add`** |
| status's unbounded fan-outs | `src/application/commands/status.ts` — `scanWorkingTree` :193–210 with `await Promise.all(stage0.map(…))` **:202–208**; a second at **:351** in `buildUnmergedEntries` (:347–363, whose docstring :340–346 justifies its exclusion from the shared stat map). `scanUntracked` :222–233 is a sequential `for await` |
| status's other costs | `requireWorkTree(ctx, 'status')` at **:130** (once) and **:368** (inside `readWorktreeMode`'s per-path `lstat`); `createWorkingTreeStatMap()` **:161**; `readHeadTree(ctx)` **:171**, sequential after both scans |
| add's sequential loop | `src/application/commands/add.ts` — `addAll` :236–271, lock :242, **the per-file loop :253–259**, commit :266; `addLiteralOnly` :132–156 (loop :143–150); `addByPathspec` loop :214–221. `stageFromStat` **:398–…** (`EntryKind` :396) does `assertValidPromisorRemoteConfig` :417 → **the sole per-file `lstat` :418** → TOCTOU type-flip guard :419–425 → `ie_match_stat` short-circuit from :432 (Stryker proof :435). Callers `processWalkEntry` :342–349 and `stageOne` :388 |
| ⚠️ | `add.ts:48` imports `acquireIndexLock` from `'./internal/index-update.js'`, a **deprecated 6-line re-export**; the real module is `src/application/primitives/internal/index-lock.ts` |
| the walker contract | `test/unit/application/primitives/walk-working-tree.properties.test.ts:286–307` asserts the walker's emission order matches a recursive oracle with an **order-sensitive `toEqual` over 100 runs**. **Parallelising the walk is a contract change; parallelising its consumption is not** |
| the stat map | `src/application/primitives/internal/working-tree-stat-map.ts` — interface :17–20 (`sampled` :18, `record` :19), `createWorkingTreeStatMap` :22–30. Consumers: `status.ts:28-29,161,199,225`; `compare-working-tree-entry.ts:39` (type) and **:137** (optional 5th param of `compareWorkingTreeDelta`); `walk-working-tree.ts:13,26`; **`types.ts:18,223` (public option)** |
| the single-flight helper | `src/application/primitives/internal/promise-memo.ts:22–44` `createPromiseMemo` (interface :13–20), with identity-guarded rejection clear at :27–30. Already in the pyramid allowlist |
| the realpath cache it protects | `src/adapters/node/node-file-system.ts:446` `parentRealpathCache` |

**The syscall-budget pins are the regression surface, and they are dense.** Every one must stay
green **through the surviving mechanism** — rewrite, never delete:

| Pin | Anchor | Assertion |
|---|---|---|
| `add --all` over 3 files | `add.test.ts:1662–1684` | `expect(fileLstatCounts).toEqual([1, 1, 1])` at **:1681**, via `instrumentedContext(base)` (:1670) |
| racy-clean shortcut | `add.test.ts:408–462` | `expect(readCalled).toBe(false)` **:457** (a boolean, not a count) |
| two passes share one stat map | `status.test.ts:1145–1205` | `expect(calls()).toBe(2)` **:1200** |
| path-only untracked walk | `status.test.ts:718–746` | `expect(untrackedLstatCalls).toBe(0)` **:744** |
| stat-map contract | `compare-working-tree-entry.test.ts:763–853` | four tests: 0 calls on a map hit (:777), `recordSpy` **not** called on a hit (:793), 1 call + recorded on a miss (:812–815), 1 call with no map (:849) |
| lazy-stat memoisation | `walk-working-tree.test.ts:249–294` | 0 / 1-per-entry / 1-when-read-twice (:259, :275, :292) |
| pruning | `walk-working-tree.test.ts:735–768` | `lstatsInsidePruned === 0` **:765** |
| adapter syscall counts | `node-file-system-injected.test.ts` | ~25 exact-count assertions, incl. `realpathSpy toHaveBeenCalledTimes(2)` :569 under `Then fsOps.realpath is called exactly once per root` (:556–557), and `Then realpath is invoked once per distinct dirname` (:1563 → :1581/:1582) |

⚠️ **Concurrent identical `realpath` probes racing `parentRealpathCache` before it populates will
inflate those counts.** The mitigation is `createPromiseMemo`'s single-flight, already in the tree.

**What lands.**

1. **Index cache** — per-Context, keyed on **`(size, mtimeMs, mtimeNs, ino)`**, following
   `config-read.ts:156`'s precedent, **invalidated by the index-lock commit path**. Keep the TOCTOU
   post-check (:33–35) and the **integrity-first ordering** (trailer verified *before* parsing, so
   a malformed payload cannot leak parser state through an error message). ⚠️ `mtimeNs` **and**
   `ino` are both in the key because second-resolution filesystems make `mtimeMs` alone unsafe.
2. **status's lstat fan-out** → an `ioBound` pool from Part 3/4 (`:202–208`, and `:351`). It is not
   actually parallel today — everything funnels through libuv's 4-wide pool — so the JS-side
   per-call cost dominates; the pool plus the `mapStat` rebuild (Part 7) is the win. **Keep
   `bigint: true`.**
3. **add** — fan `stageFromStat` through an `ioBound` pool **while iterating the walk
   sequentially**. Ordering holds because staging is path-keyed with a sort-at-end and the index is
   byte-sorted on write. **Drain the pool on the first hostile-path throw *before* `lock.commit`.**
4. **Delete `WorkingTreeStatMap`** and the `stats` parameter threaded through
   `scanWorkingTree`/`scanUntracked`/`compareWorkingTreeDelta`/`walkWorkingTree`/`types.ts:223`.
   The tests that name `createWorkingTreeStatMap` and `recordSpy` are **rewritten to assert the same
   counts through the surviving mechanism**, never deleted. Remove `createWorkingTreeStatMap` from
   `test-pyramid-budgets.json`'s `sutBindsResult.allowlist` in the same commit.
5. **`requireWorkTree` hoist at `status.ts:368`** if Part 7 did not already take it — verify, do
   not re-do.

### TDD steps

1. **RED** — `test/unit/application/primitives/read-index.test.ts`: `Given two readIndex calls on
   one Context with the index unchanged` / `Then the file is read once`; then one test **per key
   component** — `Given the index size changed` / `Then it is re-read`, and the same for
   `mtimeMs`, `mtimeNs` and `ino` **independently**. Four separate tests: a combined one cannot
   kill the per-field mutants.
2. **RED** — `Given an index written through the lock commit path` / `Then the next readIndex sees
   it` — the invalidation, written before the cache.
3. **RED** — `Given a truncated index` / `Then the trailer check refuses before parsing` — pins the
   integrity-first ordering against a cache that might reorder it.
4. **RED** — `status.test.ts`: `Given N tracked entries` / `Then at most ioBound lstats are in
   flight` (max-in-flight counter).
5. **RED** — `add.test.ts`: `Given a hostile path mid-walk` / `Then the pool drains before the
   lock is committed` (assert commit ordering, not timing).
6. **RED/REWRITE** — every pin in the table above, re-expressed through the surviving mechanism.
   The counts are the contract; the mechanism is not.
7. **GREEN** — the index cache + invalidation; the two pools; the stat-map deletion.
8. **REFACTOR** — `createPromiseMemo` around any newly-concurrent `realpath` probe; allowlist
   update; **`npm run docs:json` + commit `reports/api.json`** (public option removed).
9. **Oracle (R15)** — `status.bench.ts`, `status-dirty.bench.ts` and `add.bench.ts` show strictly
   lower medians, **with the per-file `lstat` budget unchanged** (`add --all` over 3 files stays
   `[1, 1, 1]`).

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/read-index.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/add.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/walk-working-tree.properties.test.ts test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-index.ts src/application/commands/status.ts src/application/commands/add.ts src/application/primitives/compare-working-tree-entry.ts src/application/primitives/walk-working-tree.ts src/application/primitives/types.ts`
- Targeted extras: `npm run check:test-pyramid` (allowlist entry removed) · `npm run docs:json` +
  commit `reports/api.json` · `npx vitest run test/integration/status-interop.test.ts test/integration/add-interop.test.ts` (verify the exact suite names first).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(commands): cache the index, bound status and add I/O, drop the write-only stat map`

---

## Part 16 — A HEAD FlatTree cache keyed on `(rootTreeOid, maxDepth)`

### Context

Design §P6 → F13 · **ADR-726**. Wires **only** `status` and `rm`; other `flattenTree` consumers may
opt in later, and that is deliberate scope.

**Anchors (re-verified; one design anchor corrected).**

| Thing | Anchor |
|---|---|
| ⚠️ corrected path | `readHeadTree` is **`src/application/primitives/read-head-tree.ts:21–32`** (not `internal/`): `resolveRef(ctx,'HEAD')` :22 with a `REF_NOT_FOUND` catch :23–25, `readObject` :27, non-commit throw :28–30, **`flattenTree(ctx, commit.data.tree)` :31** |
| its two callers | `src/application/commands/status.ts:171` and `src/application/commands/rm.ts:171` (**not** `diff` — the recursive tree diff walks raw bytes and never flattens; `diff-trees.ts:661` only mentions it in a comment) |
| the flattener | `src/application/primitives/flatten-tree.ts:22–25` — `flattenTree(ctx, treeIdOrObject)` = `flattenRawTree(ctx, treeIdOrObject, await resolveFlattenBounds(ctx))`; `src/application/primitives/internal/flatten-raw.ts` — `flattenRawTree` **:101–117**, `flattenLevel` :119–…, `flattenEntry` **:167–186**, `validatedName` :194–200 |
| the depth in the key | `resolveFlattenBounds` **:67–70** reads `core.maxTreeDepth` (default 2048) **per call**, so a `FlatTree` is only valid under the depth it was built with. **The depth is IN the key**, which makes correctness across a `core.maxTreeDepth` change **structural** — no coupling to `invalidateConfigCache` is added or needed |
| the entry cap | `MAX_FLAT_TREE_ENTRIES = 1_000_000` at **`src/domain/diff/flat-tree.ts:12`** (re-exported `src/domain/diff/index.ts:24`), imported at `flatten-raw.ts:22`, used :69 |
| ⚠️ gitlinks | there is **no explicit gitlink branch**. `flattenEntry:179–185` records any entry whose mode `!== FILE_MODE.DIRECTORY` verbatim — so a gitlink (`160000`) **is** in the `FlatTree`, even though `blobTreeEntry` treats gitlinks as absent. `status`/`rm` depend on that; **a cached tree must preserve it, and a test asserts it** |
| path building | `raw-tree-io.ts:20–22` `joinPath` concatenates per entry, so deep trees re-concatenate the ancestor prefix at every level |
| the LRU traps | `lru-cache.ts:88–110` — silent drop over cap (:92–94), throw on `byteSize <= 0` (:89–91). Sizer pattern: `load-reftable-stack.ts:100–109` (floor at 1) |
| other consumers (not wired here) | `merge.ts:324–326`, `apply-merge-to-worktree.ts:241–243`/`:303–305`, `stash.ts:377`/`:387`, `internal/clean-work-tree.ts:39`, and the public `repository.ts:435`/`:884–887` binding |

**Settled shape (ADR-726):** a **Context-scoped byte-capped `LruCache`** keyed
**`(rootTreeOid, maxDepth)`**, sized from the existing delta-cache budget, with a **floor-at-1**
byte sizer. **An over-cap tree simply never caches** — a monorepo HEAD tree re-flattens exactly as
today; that drop is **documented behaviour, not a bug to work around**. Context-scoped becomes
session-scoped in **Part 20**.

### TDD steps

1. **RED** — `test/unit/application/primitives/read-head-tree.test.ts`: `Given two status-shaped
   reads of the same HEAD` / `Then the tree is flattened once` (flatten spy).
2. **RED** — `Given core.maxTreeDepth changed between two reads` / `Then the tree is re-flattened`
   — the key's second component, its own test. A oid-only key passes every other test and fails
   this one.
3. **RED** — `Given a HEAD tree larger than the byte cap` / `Then it is not cached and the read
   still succeeds`.
4. **RED** — `Given an empty HEAD tree` / `Then the sizer floors at 1 and set does not throw`.
5. **RED** — `Given a HEAD tree containing a gitlink` / `Then the cached FlatTree still carries
   the 160000 entry` — the ADR-726 preservation clause.
6. **RED** — `Given HEAD moves between two calls` / `Then the new tree is flattened` (the oid
   component).
7. **GREEN** — the cache in `read-head-tree.ts`, wired for `status.ts:171` and `rm.ts:171` only.
8. **REFACTOR** — one key builder, one sizer, both named; no other `flattenTree` consumer touched.
9. **Oracle** — A/B `status`, `status-dirty` and `rm` (if a bench exists; otherwise report
   `status` only and say so).

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/read-head-tree.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/rm.test.ts test/unit/application/primitives/internal/flatten-raw.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-head-tree.ts src/application/commands/status.ts src/application/commands/rm.ts`
- Targeted extra: none beyond the part gate — the cache is invisible on every public surface.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(primitives): cache the flattened HEAD tree per root oid and depth`

---

## Part 17 — Parallel checkout materialisation with completion-ordered progress

### Context

Design §P7 → F6 · **ADR-725** · **R16**. Consumes Part 3/4's policy.

**Anchors (re-verified; two design anchors corrected).**

| Thing | Anchor |
|---|---|
| the prescan | `src/application/primitives/apply-changeset.ts` — **`checkDirty` :156–173**: a plain `for` over `changeset.entries` awaiting `evaluateDirtyPath` (:163–168), then **refusal arrays sorted with `comparePaths` at :172** (git's raw-byte order; `comparePaths` imported :29). Called from `applyChangeset` **:309** under `if (!force)` :308, throwing `checkoutOverwriteDirty(dirty)` :311 |
| the write side | **`applyAllEntries` :267–298** — a plain `for` awaiting `applyEntry` per entry (:278–296) |
| progress today | `:288–293` — `ctx.progress.update(CHECKOUT_OP, written + deleted, changeset.stats.add + changeset.stats.update + changeset.stats.delete, entry.path)`, fired per non-noop entry, with the total **recomputed every iteration**. `CHECKOUT_OP = 'checkout:materialize'` at **:70** |
| the scanner | one `createLeadingPathScanner(ctx)` per invocation at **:325**, passed to `applyAllEntries` :326 and used at :205/:243. Implementation `src/application/primitives/internal/symlinked-leading-path.ts:44–119` — `memo = new Map<string, PrefixShape>()` :45, `hasSymlinkedLeadingPath` :68–81, `unlinkSymlinkedLeadingComponent` :83–112, `invalidate` :114–116, Stryker `StringLiteral` proofs at **:70** and **:85**. **Its per-directory memo is exactly what concurrent access races** |
| the scanner's ordered pin | `test/unit/application/primitives/internal/symlinked-leading-path.test.ts:182–214` — `Then walking stops at the missing prefix and a deeper prefix is never lstat-ed`, asserting `expect(calls).toEqual([dirPath])` **:213** and `expect(calls).not.toContain(deeperPath)` :214 over an **ordered** array; sibling at :219–244 asserting `expect(rmSpy).toEqual([dirPath])` |
| ⚠️ corrected path | the port is **`src/ports/progress-reporter.ts`** (not `ports/progress.ts`): `ProgressReporter` :9–26, **`update: (op: string, current: number, total?: number, text?: string) => void` :22** with the docstring at :17–21 — "`current` is the count of items processed so far … `text`, when provided, is sideband-style auxiliary text". Module doc :1–8: reporters are **synchronous and fire-and-forget**; the facade wraps every call in try/catch |
| the hook pin | `test/unit/application/commands/checkout.test.ts` — helper `postCheckoutSince` **:1434–1436**; four tests at **1438–1455**, **1457–1474**, **1476–1497**, **1499–1517**, each asserting `runner.calls` length and args. **Hook invocation counts are unaffected by the progress change (ADR-725 says so explicitly, and these tests are what prove it)** |
| ⚠️ | **`test/bench/checkout.bench.ts` does NOT exist** — R16 requires creating it. The nearest existing scenario is `clone-small-repo.bench.ts` |

**What lands.**

1. **The dirty prescan goes through an `ioBound` pool unchanged.** Refusals are unaffected:
   `checkDirty` completes before any write, and its refusal arrays are sorted with `comparePaths`
   **after** collection (:172), so collection order does not matter.
2. **The write side needs ordered waves** — deletes first, directories before their children —
   because `applyEntry` creates parents. `LeadingPathScanner` knows the structure; the changeset's
   own `add`/`update`/`delete` split gives the wave boundaries.
3. **The scanner needs single-flight** (`createPromiseMemo`, `internal/promise-memo.ts:22–44`) or
   its memo races, and the ordered pin at :182–214 is what catches it.
4. **Progress (ADR-725).** `current` stays **strictly monotone** via **one counter incremented as
   each entry finishes** — never derived from an index; `total` is unchanged (hoist the recomputed
   sum out of the loop); `text` carries the path of the entry that **just completed**, in
   **completion order, not changeset order**. The port never promised `text` ordering, so this is
   contract-honest rather than a divergence. Two things this makes testable rather than
   hand-waved: `current` must be **proved** monotone under a pool, and `text` must be proved to
   always name a path that **has actually landed on disk** — emitting a path before its write
   completes would be worse than reordering.

### TDD steps

1. **RED** — `test/unit/application/primitives/apply-changeset.test.ts`: `Given a changeset with N
   entries` / `When materialisation runs` / `Then at most ioBound writes are in flight`
   (max-in-flight counter).
2. **RED** — `Given entries that complete out of order` / `Then progress.current is strictly
   monotone` — collect every `update` call and assert monotonicity. This is the test an
   index-derived counter fails.
3. **RED** — `Given an entry whose write is still pending` / `Then its path is not yet reported in
   progress text` — the "text names a landed path" clause.
4. **RED** — `Given a directory and its children in one changeset` / `Then the directory wave
   completes before the children wave starts`.
5. **RED** — `Given a dirty working tree` / `Then the refusal arrays are byte-order identical to
   the sequential run` — `comparePaths` order under a pool.
6. **RED** — `symlinked-leading-path.test.ts`: `Given two concurrent probes of the same prefix` /
   `Then the prefix is lstat-ed once` — the single-flight test; the ordered pin at :182–214 must
   stay green **unchanged**.
7. **RED** — **new** `test/bench/checkout.bench.ts` (R16) with a scenario over an existing fixture,
   sharing `test/bench/support/tiered-bench.ts`'s shape. It is a bench, not an assertion.
8. **GREEN** — the two pools, the waves, the completion counter, the single-flight scanner.
9. **REFACTOR** — hoist the recomputed `total`; re-prove or remove `symlinked-leading-path.ts:70`
   and `:85` if their lines moved; keep `applyAllEntries` under 20 lines by extracting the wave.
10. **Oracle (R16)** — `checkout.bench.ts` shows a strictly lower median than the same scenario on
    `main`, A/B'd through `bench-ab`. `checkout.test.ts:1438–1517`'s four hook tests stay green
    **unchanged** — that is the ADR-725 claim being verified, not assumed.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/commands/checkout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts src/application/primitives/internal/symlinked-leading-path.ts test/bench/checkout.bench.ts`
- Targeted extras: `npm run check:test-pyramid` (a new bench file shifts tier counts) ·
  `npx vitest run test/integration/checkout-interop.test.ts` (verify the exact suite name).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(checkout): materialise in bounded waves with a completion-ordered progress counter`

---

## Part 18 — Clone streams its pack into quarantine

### Context

Design §P7 → F8 · **ADR-728** · **R17**. Faithfulness-**positive**: Pin B shows git streams the
received pack into `objects/pack/tmp_pack_<6 mkstemp chars>` and renames to `pack-<sha>.pack`
(+`.idx`, `.rev`) **only after `index-pack` has verified it**, and on `SIGKILL` mid-clone the
partial `tmp_pack_XXXXXX` **survives** (mode `444`) — git does not clean up on a hard kill.

**Anchors (re-verified; one design anchor corrected).**

| Thing | Anchor |
|---|---|
| the full buffer | `src/application/primitives/fetch-pack.ts` — **`drainPackBodyBounded` :200–233**: accumulates every sideband chunk into `chunks[]` (:213), caps at `ctx.config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES` (:205, throwing `packTooLargeBytes(cap)` :210), then allocates `new Uint8Array(total)` and copies (**:226–229**) — a **2× peak**. Progress ticks at :215–218; the tail tick at :220–223 carries a Stryker `ConditionalExpression` proof on **:220** |
| the port surface | `src/ports/file-system.ts` — **`writeStream(path, source: AsyncIterable<Uint8Array>)` :63–64** already exists; **`atomicRename?` :116–125 is optional** ("OPFS has no rename and no atomic replace, so the browser adapter omits it. Omission is a documented answer, not an oversight") — **the rename must fall back to `rename` (:114)**; `rm` **:106–107** — "Throws FILE_NOT_FOUND if not found", i.e. **not idempotent**; `writeExclusive` :66–80 with its documented single-ENOENT-retry ("if the parent is removed between the implicit mkdir and the open (e.g. concurrent `git gc` prunes the fanout), the adapter retries once") |
| the artefact writer to reuse | `src/application/primitives/internal/write-pack-artifacts.ts:141–163` — writes `.pack` → `.idx` → optional `.promisor` → optional `.rev`, one shared `sortPackIndexEntries` at :148, `mkdir` :147, `wantRev` resolved at **:145 before any artefact is created** |
| the registry read path | `RegisteredPack.readSlice` (`pack-registry.ts:113`, impl :387–416) — index from disk through it rather than from memory |
| ⚠️ the Proxy pin | `test/unit/application/commands/clone.test.ts:307–361` — `Then nothing reads hash or hashConfig through the original context once bootstrap has started writing`; `IDENTITY_SENSITIVE_PROPS = new Set(['fs','layout','hash','hashConfig'])` **:340**, counter :341–352, assertion `expect(staleReadsAfterBootstrap).toBe(0)` **:358**. **A mechanical hoist like `const { fs } = ctx` outside a loop changes that count** |
| ⚠️ | **`tooling/bench-memory.ts` has NO clone workload** — its workloads are delta-chain (:129), large-pack (:176, gated `TSGIT_BENCH_LARGE`), commit-walk header cache (:222), header cache (:249, :263), fsck object cache (:292), driven at :345–362. **R17 requires adding one.** It imports the **built dist** (`DIST_ENTRY = dist/esm/index.node.js`, :44), so the workload must run against a build |

**What lands.** Stream the sideband body to `objects/pack/tmp_pack_<random>`, hash the trailer
**incrementally as bytes arrive**, verify, then rename to `pack-<sha>.pack` and write the sibling
`.idx`/`.rev` — exactly git's shape. Index from disk through `readSlice`. Clone peak memory becomes
**O(window) instead of O(pack)** — that is R17's oracle.

**The failure posture, and the pin this part owes.**

⚠️ **Implementer-owed empirical pin (ADR-728 makes it a gate).** Pin B covered only the *hard kill*.
Whether git also unlinks on a **handled** failure is **not pinned**. Before any interop test claims
parity on the failure path: in a `mktemp -d` throwaway with an isolated `HOME`, `GIT_*` scrubbed and
signing off, start a `git clone` and **kill `git-upload-pack` (the *server* side, not the client)
mid-stream**; observe whether `objects/pack/tmp_pack_*` survives on the client. **Align tsgit to
whatever that shows**, and record the matrix in `docs/design/perf-remediation-2026-08.md`. The
`try/finally` unlink is proposed on **tidiness** grounds, not faithfulness grounds — do not defend
it as parity until the probe says it is.

**The unlink must be genuinely best-effort:** `ctx.fs.rm` throws `FILE_NOT_FOUND` when the path is
gone, so a cleanup racing a successful rename must **narrow to exactly that code and rethrow
everything else**. A swallowed-everything `catch {}` is a guardrail violation, not a tidy-up.

**Which stages get a pool, and from which bucket.** The **sideband receive** takes **no pool** — it
is a single ordered stream, concurrency 1 by construction, and the incremental trailer hash rides
along it. The **indexing pass** that inflates each object out of the quarantined pack via
`readSlice` is **`cpuBound`** (deflate/inflate dispatched to the libuv threadpool, not
oversubscribed).

### TDD steps

1. **RED** — `test/unit/application/primitives/fetch-pack.test.ts`: `Given a sideband stream` /
   `When the body is drained` / `Then the whole pack is never held in memory` — assert through a
   `writeStream` spy that bytes reach the file as they arrive (chunk count > 1 before completion),
   not through an RSS measurement.
2. **RED** — `Given a stream whose trailer does not match` / `Then it refuses and no
   pack-<sha>.pack exists` — the verify-before-rename ordering.
3. **RED** — `Given a successful stream` / `Then the temp file is renamed and the .idx and .rev
   siblings are written`.
4. **RED** — `Given an adapter without atomicRename` / `Then the plain rename path is used`
   (the OPFS case, its own test).
5. **RED** — `Given a handled failure mid-stream` / `Then the temp file is removed` **and**
   `Given the temp file is already gone` / `Then FILE_NOT_FOUND is swallowed and every other code
   rethrows` — two tests; the second is the guardrail.
6. **RED** — `Given the response exceeds maxResponseBytes` / `Then it refuses with the same
   `.data` as today` — the cap survives the rewrite.
7. **GREEN** — the streamed quarantine; reuse `writePackArtifacts` for the siblings.
8. **REFACTOR** — re-prove or remove `fetch-pack.ts:220`'s Stryker proof if its line moved; keep
   `clone.test.ts:307–361`'s `staleReadsAfterBootstrap === 0` green — **do not hoist `ctx.fs`**.
9. **Oracle (R17)** — add a **clone workload** to `tooling/bench-memory.ts` (there is none) and
   demonstrate peak RSS bounded independently of pack size at **two pack sizes differing by ≥4×**.
   Plus the network interop suites under `test/integration/network/*` (real `git-http-backend`).
   ⚠️ Those suites need `runGitAsync` — a **synchronous** git spawn blocks the in-process server
   and deadlocks.

### Gate

- Part gate: `npx vitest run test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/clone.test.ts test/unit/application/commands/fetch.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/fetch-pack.ts tooling/bench-memory.ts`
- Targeted extras: `npx vitest run test/integration/network` (real `git-http-backend`; run
  detached and poll — the sandbox reaps long foreground runs) · the ADR-728 handled-failure probe,
  with its matrix recorded in the design doc · a `bench-memory` run at two pack sizes.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(clone): stream the incoming pack through quarantine instead of buffering it`

---

## Part 19 — Size-gated callback zlib

### Context

Design §P7 (the zlib threshold, deferred from F15) · **ADR-719**'s `cpuBound` bucket. This is the
enabler that makes Parts 15, 17 and 18's pools do anything at all on Node.

**Why.** Node's **synchronous** zlib blocks the one JS thread, so a promise pool over `inflateSync`
reorders without overlapping. Node's **callback** zlib dispatches to the **libuv threadpool**, so
above a size threshold it genuinely overlaps; below it, dispatch overhead dominates.

**Anchors (re-verified).**

| Thing | Anchor |
|---|---|
| the adapter | `src/adapters/node/node-compressor.ts` (225 lines) — `import { createInflate, deflateRawSync, deflateSync, inflateSync } from 'node:zlib'` **:1**; `class NodeCompressor implements Compressor` **:21–213**; ctor :24–26; `effectiveCap` :30–34; **`deflate` :36–43** (the sync call at **:39**, Stryker proof :38); **`deflateRaw` :45–54** (:48–50, Stryker proof :47); **`inflate` :56–62** (the sync call at **:58**, with `maxOutputLength: this.maxInflatedBytes`); `streamInflate` :64–102 (**`createInflate()` :75**, with a comment at :69–72 that Node's `maxOutputLength` "is unreliable for streaming use"); `createInflateStream` :104–212 (**`createInflate()` :106**, Stryker `BlockStatement` proof :205). `MAX_INFLATED_OBJECT_BYTES` :14 |
| the port is already async | `src/ports/compressor.ts` (57 lines) — `InflateStreamResult` :1–6, `Compressor` :8–56 with `deflate` :14, `deflateRaw` :21, `inflate` :24, `streamInflate` :44–48 (docstring :26–43 pins the "**a caller can only narrow the cap, never raise it**" contract), `createInflateStream` :55. **No signature changes are needed** |
| the shared contract suite | `test/unit/ports/compressor.contract.ts` — a **factory**, `compressorContractTests(createSut: () => Promise<Compressor>): void` **:6**, `describe('Compressor contract')` **:7**, **15 flat `it()` cases** in the 2-level Given/When/Then single-string form (:8, :16, :23, :32, :43, :62, :84, :96, :125, :138, :151, :165, :179, :189, :224). Wired at `test/unit/adapters/node/node-compressor.test.ts:7` and `test/unit/adapters/memory/memory-compressor.test.ts:14`. **No browser adapter is wired into it** |
| the browser gap | `BrowserCompressor` has **no node-side behavioural test** — `browser-adapter.test.ts:24` only asserts `toBeInstanceOf`. Its real coverage is `test/browser/decompression-stream.spec.ts` under Playwright across chromium/firefox/webkit |

**What lands.** Above a threshold, `deflate`/`deflateRaw`/`inflate` dispatch through Node's
**callback** zlib; below it they keep the sync path. The **bound** comes from Part 3's `cpuBound`
(`min(cores, threadpoolWidth)`); **the threshold itself is a measured constant, not a derived one
— A/B it at 4, 16 and 64 KiB before fixing a value**, and record the table in the commit body.

`BrowserCompressor` (`CompressionStream`/`DecompressionStream`) and `MemoryCompressor` are already
async and are **not** touched.

### TDD steps

1. **RED** — `test/unit/adapters/node/node-compressor.test.ts`: `Given a payload below the
   threshold` / `Then the synchronous path is used`; `Given a payload above the threshold` /
   `Then the callback path is used`. Two tests, discriminated by a `node:zlib` spy — not by
   timing. Fails: only the sync path exists.
2. **RED** — `Given a payload above the threshold that inflates past the cap` / `Then it refuses
   with the same `.data` as the sync path` — the cap must not become weaker on the new path.
3. **RED** — `Given the callback path rejects` / `Then the error is surfaced with the same shape`
   (`describeError`, `node-compressor.ts:6–8`).
4. **GREEN** — the size gate + the callback dispatch, bounded by `limitFor(ctx, 'cpuBound')`.
5. **REFACTOR** — the threshold is a **named constant** with the measured table in the commit
   body; re-prove or remove the Stryker proofs at :38, :47 and :205 if their lines moved.
6. **Oracle** — the 15-case shared contract green for **node and memory**; the Playwright browser
   spec green; A/B `adapter-inflate.bench.ts`, `loose-read.bench.ts`, `pack-read.bench.ts`,
   `clone-small-repo.bench.ts` and `add.bench.ts` at the three candidate thresholds.

### Gate

- Part gate: `npx vitest run test/unit/adapters/node/node-compressor.test.ts test/unit/adapters/memory/memory-compressor.test.ts test/unit/adapters/browser/browser-adapter.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-compressor.ts src/ports/compressor.ts`
- Targeted extras: `npm run check:tarball` (the adapter is on the node entry graph; no `node:`
  specifier may become reachable from `index.default.js`) · `npm run check:size` · the Playwright
  spec `test/browser/decompression-stream.spec.ts`.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`perf(node): dispatch large zlib work to the libuv threadpool`

---

## Part 20 — Caches key on a session token

### Context

Design §P8 → F14 · **ADR-722** · **R6** · §0.1 invariant-route checklist, row 6. Re-keys the caches
Parts 14 and 16 added, which is why it lands after them.

**Public-surface decision, made here:** `ctx.session` is **internal and opaque** — not exported
from `src/index.ts`, not documented as constructible. An embedder has no reason to build one, and
a public token invites callers to forge cache identity. `Context` itself is already a public type,
so verify `reports/api.json` after the change and regenerate **in this part** if the field surfaces.

**Anchors — the caches (verified, and there are TEN, not nine).**

| # | Cache | Declaration |
|---|---|---|
| 1 | config `{parsed, tokens, source}` | `config-read.ts:156` |
| 2 | per-scope `IniSection[]` | `config-scoped-read.ts:16–19` |
| 3 | pack registry | `read-object.ts:15` |
| 4 | promisor in-flight fetches | `read-object.ts:21` |
| 5 | ref store | `ref-store.ts:221` |
| 6 | loose-oid fanout | `internal/loose-oid-cache.ts:22` |
| 7 | shallow set | `internal/shallow-set.ts:30` |
| 8 | commit-graph layers | `internal/read-commit-graph.ts:52` |
| 9 | commit-graph headers | `internal/read-commit-graph.ts:81` |
| **10** | **reftable stack** | **`src/application/primitives/load-reftable-stack.ts:91`** — already keyed on `Context['deltaCache']`, with a 22-line docstring (:70–90) that is a complete statement of the problem. **⚠️ the file is not under `internal/`** |
| + | the two caches this plan added | Part 14's parsed-commit LRU and Part 16's FlatTree LRU — **both re-key here** |

**Anchors — the derivation sites (verified; there are eight call sites across seven shapes).**

| Site | Expression | Verdict |
|---|---|---|
| `repository.ts:654–665` | `Object.freeze({ ...baseCtx, ...buildOptionalCtxFields({…}), promisor })` | **creates** the token |
| `list-worktrees.ts:74–77` `deriveMainContext` | `({ ...ctx, layout: { ...ctx.layout, gitDir: commonGitDir(ctx) } })` — **the only unfrozen derivation** | **fresh** (gitDir changes) |
| `list-worktrees.ts:155` (`linkedEntry` → `deriveWorktreeContext`), loop `:182–193` | one fresh Context **per linked worktree** | **fresh** |
| `internal/worktree-context.ts:36–55` | freeze; new `fs` (`worktreeScopedFs`), `layout`, `cwd`; **drops `promisor`/`hooks`/`command`** (destructure :35) | **fresh** (fs root set **and** layout) |
| `internal/submodule-context.ts:17–39` | freeze; new `layout` (`${gitDir}/modules/<name>`), `cwd`; drops `promisor`/`hooks` (:20), **not `command`**; Stryker proof :33 | **fresh** (different repository) |
| `fsck.ts:76–77` | `Object.freeze({ ...ctx, deltaCache: createNoDeltaCache() })` then `adoptPackRegistry(ctx, auditCtx)` | **keeps** it |
| `clone.ts:162` | `Object.freeze({ ...ctx, hash: adopted, hashConfig: configFor(adopted.algorithm) })`, consumed :172–173 | **keeps** it — see the tension |
| `bundle-verify.ts:128` | `Object.freeze({ ...ctx, hash, hashConfig: configFor(algorithm) })` | **keeps** it — see the tension |

**What lands (ADR-722).** A frozen `ctx.session` token created at construction and preserved by a
**`deriveContext(ctx, changes)` helper — the only derivation path** — whose docstring names the
**three** dimensions that force a **fresh** token: **gitDir/commonDir, the fs root set, and the hash
algorithm**. All ten caches (plus this plan's two) re-key onto `ctx.session`.
**`adoptPackRegistry` (`read-object.ts:38–40`) is REMOVED**, not deprecated — its one caller keeps
the registry by keeping the token.

⚠️ **A tension inside ADR-722 the implementer must RESOLVE, not paper over.** The ADR lists the
hash algorithm among the fresh-token dimensions **and** names clone's and bundle-verify's hash
adoption among the same-repository derivations that **keep** it. Both cannot be read literally at
once. The reconciliation this plan takes: hash algorithm is a fresh-token dimension **in general**
(oid-keyed caches are meaningless across a digest-width change), but at these two sites the swap
happens **during bootstrap, before any hash-dependent cache is populated**, so keeping the token is
sound. **That soundness is an assumption about ordering, and assumptions about ordering rot —
ASSERT it**: a test proving no oid-keyed cache holds an entry at the moment `clone.ts:162` /
`bundle-verify.ts:128` derive. **If the assertion cannot be made to hold, take a fresh token at
those two sites and record the deviation.** Do not keep the token on the strength of prose.

⚠️ **The question the token forces into the open, now answered.** `fsck.ts:76` has *two* effects
today: it stops the audit polluting (and benefiting from) the object-byte cache — clearly intended
— **and**, because `load-reftable-stack.ts:91` keys on `ctx.deltaCache`, it silently gives fsck a
fresh reftable-stack cache too. **ADR-722 decouples them and keeps the session for fsck, isolating
only `deltaCache`.** fsck therefore now **shares** ref/config/graph caches with the opening Context.
This is a **stated behaviour change to a verification command**, taken deliberately: re-reading the
same `packed-refs` is redundant work, not safer work — fsck's integrity guarantee comes from its own
independent re-hash, which is untouched. **Assert the narrowing explicitly** (fsck still gets zero
object-byte cache hits; fsck now gets ref-store reuse) rather than letting it be inferred.

**Immediate win this unlocks.** `listWorktrees` (`:182–193`) builds a fresh Context per linked
worktree and calls `getRefStore` twice per worktree, so N linked worktrees cost **N+1 fresh ref
stores and N+1 `packed-refs` parses**, plus a fresh `NodeFileSystem` + validator each — in a
**sequential** loop.

### TDD steps

1. **RED** — `test/unit/ports/context.test.ts`: `Given a Context built by openRepository` /
   `Then it carries a frozen session token`.
2. **RED** — `test/unit/application/primitives/derive-context.test.ts` (new), **one test per
   dimension, in both directions**: `Given a derivation that changes gitDir` / `Then the token is
   fresh`; the same for the fs root set and the hash algorithm; and `Given a derivation that
   changes only deltaCache` / `Then the token is preserved`.
3. **RED** — **symmetry, per cache, in both directions** (R6): `Given a write through a derived
   Context` / `Then a read through the original hits` **and** the reverse. Parameterise over the
   ten caches; do not collapse the two directions into one test.
4. **RED** — `test/unit/application/commands/fsck.test.ts`: `Given fsck runs on an opened
   repository` / `Then it gets zero object-byte cache hits` **and** `Then it reuses the ref store`
   — the two halves of the deliberate narrowing, asserted separately.
5. **RED** — `test/unit/application/commands/clone.test.ts` and `bundle-verify.test.ts`:
   `Given the hash algorithm is adopted at bootstrap` / `Then no oid-keyed cache holds an entry at
   that moment` — the assertion that licenses keeping the token. If it cannot be made to hold,
   **stop and escalate** `{ part, reason, ≤3 options }`.
6. **RED** — `test/unit/application/primitives/list-worktrees.test.ts`: `Given N linked
   worktrees` / `Then the common ref store is built once` (construction counter).
7. **GREEN** — the token, `deriveContext`, the ten re-keys plus this plan's two, and the removal
   of `adoptPackRegistry`.
8. **REFACTOR** — every derivation site goes through `deriveContext`; `list-worktrees.ts:74–77`
   stops being the one unfrozen derivation; `load-reftable-stack.ts:70–90`'s docstring is rewritten
   (its problem statement is now solved structurally).
9. **Oracle** — `worktree-interop`, `linked-worktree-discovery-interop` and
   `ownership-trust-gate-interop` green; A/B `listWorktrees`-heavy and `status` scenarios.

### Gate

- Part gate: `npx vitest run test/unit/ports test/unit/application/primitives/derive-context.test.ts test/unit/application/primitives/list-worktrees.test.ts test/unit/application/primitives/load-reftable-stack.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/clone.test.ts test/unit/application/commands/bundle-verify.test.ts test/unit/application/primitives/read-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/context.ts src/repository.ts src/application/primitives/read-object.ts src/application/primitives/load-reftable-stack.ts src/application/primitives/list-worktrees.ts src/application/primitives/internal/worktree-context.ts src/application/primitives/internal/submodule-context.ts src/application/commands/fsck.ts src/application/commands/clone.ts src/application/commands/bundle-verify.ts`
- Targeted extras: `npm run check:architecture` · `npm run docs:json` (verify `ctx.session` did
  **not** surface publicly; commit `reports/api.json` only if it legitimately moved) ·
  `npx vitest run test/integration/worktree-interop.test.ts test/integration/linked-worktree-discovery-interop.test.ts`
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`refactor(ports): key every per-repository cache on a session token`

---

## Part 21 — First-party read containment becomes single-authority

### Context

Design §P8 → F9 · **ADR-721** (supersedes ADR-541 on one narrow point) · **R3** · §0.1 row 5.
Security-adjacent: **two observable behaviours flip**, both ratified, both confined to *branded
read escapes*.

**Anchors (re-verified; three design anchors corrected).**

| Thing | Anchor |
|---|---|
| the wrapper | `src/repository/wrap-fs-validator.ts` (195 lines) — `wrapFsValidator(fs, roots, allowExternalPaths = [])` **:53–171**; root minimisation :65–68; `allowSet` :69; **`guard` :70–78** (`hasDotDotSegment` → `pathspecOutsideRepo`; then `rootList.some(isContainedIn)`; then `allowSet.has`; else refuse). **`guard` runs on all 20 wrapped methods** (:80–166); `rename` guards **both** operands (:137–138); `symlink` guards only `linkPath` (:152, rationale :146–151); `homedir`/`xdgConfigHome`/`systemConfigPath` are unguarded pass-throughs (:167–169) |
| ⚠️ corrected | **`layoutRootsOf` is NOT in `wrap-fs-validator.ts`** — it is **`src/repository/layout-roots.ts:19–32`** (docstring :4–18 explicitly frames minimisation as a **per-FS-call hot-path** concern). Callers: `src/index.node.ts:24,80`; `src/repository.ts:42,574` |
| ⚠️ corrected | there are **exactly TWO** Stryker equivalence proofs in `wrap-fs-validator.ts` (**:12** on `isDotDotSegment`'s `MethodExpression`, **:24** on `hasDotDotSegment`'s `StringLiteral`), not three. **A predicate restructure invalidates both** |
| the adapter's read path | `src/adapters/node/node-file-system.ts` — **`resolveRead` :972–986**, private, **synchronous and syscall-free**: `toAbsolute` :973, the `..` prefilter :979 (Stryker proof :978), `normalizeForCompare` :980, `roots.some(containedByPrefix)` :981–983, `throw permissionDenied(path)` **:984**. Read surfaces: :574, :581, :602, :662, :675, :681, :687, :742, :796 |
| the adapter's write path | **`resolveWrite` :998–…**, async: unconditional `policy.resolve` :1004, root set :1012, **`realpathForCreation` :1014 and the post-check :1023–1024**, which "runs unconditionally, on every call — no verdict is ever cached across calls". Write surfaces: :607, :616, :629, :638, :647, :700, :709, :721+:722, :752, :763, :771, :793 |
| ⚠️ corrected | **`composeAdapters` (`src/repository/compose-adapters.ts:47–65`) does NOT handle `unsafeRawAdapters` or `wrapTransportValidator`.** It only does `overrides.X ?? fallback.X` (:52–56) plus four `adapterUnavailable` guards (:57–63). The wrapping decision lives in **`src/repository.ts:575–582`**, gated on `opts.unsafeRawAdapters === true` (declared **:218**); `composeAdapters` is called at **:566** |
| the free rider | `src/repository.ts:589–595` `worktreeFs` — rebuilds a `NodeFileSystem` **and** a `wrapFsValidator` on **every call**, never memoised (`unsafeRawAdapters` re-checked :593). Callers, all via `worktreeScopedFs` (`internal/worktree-context.ts:12–15`): `worktree-context.ts:41`, `list-worktrees.ts:159`, `worktree.ts:97`, `:167`, `:316` and **`:351`** (a sixth site the design's list misses) |
| the error codes | `PERMISSION_DENIED` — `src/domain/error.ts:21` (declaration), `:148–149` (factory `permissionDenied(path: string)`), `:242–243` (message arm). `PATHSPEC_OUTSIDE_REPO` — `src/domain/commands/error.ts:27` (declaration, note the **branded `FilePath`**), `:332–333` (factory), message arm in **`src/domain/error.ts:362–363`**. The exhaustiveness pin is the single `switch (data.code)` in `src/domain/error.ts` (~:230–621) with `const _exhaustive: never = data;` at **:617–620** |
| the config-scope allowlist | `computeConfigScopePaths` admits `~/.gitconfig` / `$XDG/git/config` / `/etc/gitconfig` past the wrapper; the adapter then refuses them with `PERMISSION_DENIED`, which `readSingleScopeUncached` (`config-scoped-read.ts:45–64`, catch at **:60**) catches **alongside `FILE_NOT_FOUND`** and returns `[]`. It does **not** catch `PATHSPEC_OUTSIDE_REPO` |
| the interop suite to re-run first | `test/integration/git-parity-containment-interop.test.ts` (1 416 lines) |
| ⚠️ ADR number collision | `docs/adr/625-git-parity-containment-posture.md` and `docs/adr/625-one-shared-pack-offset-sort-for-idx-and-rev.md` both exist. **Cite by filename, never by number** |

**What lands (ADR-721).** Brand the first-party adapters in `composeAdapters`
(`compose-adapters.ts:47–65` is the seam; `test/unit/repository/compose-adapters.test.ts` is its
test) and **skip `wrapFsValidator` on *reads* only**. The **write path keeps both layers** — there
the wrapper is not redundant, because it cannot do the realpath post-check, and ADR-721 carries
ADR-541's write-path posture forward unchanged. **User-supplied `opts.fs` keeps both layers exactly
as today.**

**There is no provenance signal to skip on** — `composeAdapters:52` erases it (`overrides.fs ??
fallback.fs`), and the only opt-out is the repo-wide `unsafeRawAdapters`, which *also* drops
`wrapTransportValidator` (the SSRF guard) and therefore cannot serve. **A brand must be
introduced.**

**The two observable flips, both ratified, both confined to branded read escapes (R3):**
1. the refusal code becomes the adapter's **`PERMISSION_DENIED`** instead of
   `PATHSPEC_OUTSIDE_REPO`;
2. an in-repo `a/../b` read path is **collapsed and accepted** rather than refused (the wrapper
   rejects any `..` segment, including the Win32 forms `'.. '` / `'...'`; the adapter collapses).

⚠️ **Sequence the wrapper skip BEFORE any allowlist change, never the reverse.** Removing the
wrapper preserves the `[]` outcome for config-scope reads; removing only the allowlist while
keeping the wrapper **breaks them**.

**The correctness gate is a property test, not an interop test.** ADR-485 records that path
containment is a **tsgit security property, not a git behaviour** — "there is nothing git-observable
to diverge from" — so the gate is a **verdict-identity proof over the containment predicate**
(lens 2). `git-parity-containment-interop.test.ts` is nonetheless the first thing to re-run.

**Free rider (take it):** memoise `worktreeFs`'s closure **by root set**. It touches neither the
gate nor the cache keying and is a self-contained win, and `listWorktrees` calls it per worktree.

**Invariant-route walk (design §0.1 row 5 — record it in the commit body).** Every route that can
bypass or re-admit the relaxed check: **the discovery walk** (it runs *before any adapter
exists*); `worktreeFs(path)` (a **fresh adapter per call**, and after the memo a fresh one **per
root set**); **submodule child contexts** (`internal/submodule-context.ts:17–39`); the
**config-scope allowlist** paths; **`unsafeRawAdapters`** (`repository.ts:218`, re-checked at
`:593`); and **user-supplied `opts.fs`**, which must be **unaffected**.

**ADR housekeeping owed by this part.** `docs/adr/625-git-parity-containment-posture.md` reads
`- **Status:** accepted (ratified by user)` with no forward pointer; ADR-721 refines it. Add
`· **Refined by:** ADR-721` to that header bullet. (`docs/adr/541-*.md` **already** carries its
superseded-by-721 line — nothing owed there.)

**Documentation.** `docs/understand/security.md` — the containment section (`## Path containment`
:7, `### Node — the write/read split` :19) already asserts the *adapter's* behaviour, so this change
makes the docs **more** accurate; verify the exact lines and amend. Check `docs/use/errors.md` for
the two refusal-code pins.

### TDD steps

1. **RED** — `test/unit/repository/compose-adapters.test.ts`: `Given first-party adapters` /
   `Then the composed set is branded`; `Given a user-supplied fs` / `Then it is not branded`.
2. **RED** — **new** `test/unit/repository/wrap-fs-validator.properties.test.ts` (lens 2): `Given
   an arbitrary path from the containment corpus` / `Then the wrapper's verdict and the adapter's
   verdict agree` — over in-root, out-of-root, `..`-collapsing-inside, `..`-escaping, Win32 `'.. '`
   / `'...'`, absolute, relative, symlink-shaped, and the three config-scope paths. **This is the
   test that defines what "single-authority" means**, and it must be written first.
3. **RED** — `Given a branded adapter and a read path that escapes the roots` / `Then it refuses
   with PERMISSION_DENIED` (assert `.data.code`, not the class) — flip 1, its own test.
4. **RED** — `Given a branded adapter and an in-repo read path containing '..'` / `Then it is
   accepted` — flip 2, its own test.
5. **RED** — `Given a user-supplied fs and the same two paths` / `Then today's behaviour is
   unchanged` — two tests, the R3 guarantee.
6. **RED** — `Given a config-scope path` / `Then the scope resolves to an empty array, not a
   throw` — the allowlist sequencing, asserted before the wrapper is touched.
7. **RED** — write path: `Given a branded adapter and a write that escapes via a symlink` /
   `Then the realpath post-check still refuses` — proves both layers survive on writes.
8. **RED** — `test/unit/repository/repository.test.ts`: `Given repeated worktreeFs calls for the
   same root set` / `Then the validator is built once`.
9. **GREEN** — the brand in `composeAdapters`; the read-path skip in `repository.ts:575–582`; the
   `worktreeFs` memo.
10. **REFACTOR** — re-prove or remove `wrap-fs-validator.ts:12` and `:24`; amend the ADR-625
    containment file's status bullet; update `docs/understand/security.md` and check
    `docs/use/errors.md`.
11. **Oracle** — `git-parity-containment-interop.test.ts` (1 416 lines) green; A/B `merge` (the
    `guard` frame is the top frame of its profile) and `status`.

### Gate

- Part gate: `npx vitest run test/unit/repository/compose-adapters.test.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/repository/wrap-fs-validator.properties.test.ts test/unit/repository/repository.test.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/application/primitives/config-scoped-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/compose-adapters.ts src/repository/wrap-fs-validator.ts src/repository/layout-roots.ts src/repository.ts src/adapters/node/node-file-system.ts`
- Targeted extras (security-adjacent — all required): `npx vitest run test/integration/git-parity-containment-interop.test.ts test/integration/ownership-trust-gate-interop.test.ts` ·
  `npm run check:architecture` · `npm run check:spelling` (two doc pages change).
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`refactor(repository): make the adapter the single read-containment authority`

---

## Part 22 — A commit-graph writer, byte-identical to git

### Context

Design §P9 → Task 1 · **ADR-724** · **R22**. The single largest gap in P9: tsgit must **write** a
format it has only ever **read**, and the one reference encoder in the tree is test code. This part
lands the writer as an internal primitive; **Part 23** puts the public command on top of it.

**Why it is tractable:** Pin C/K show `git commit-graph write --reachable` is **byte-deterministic**
and `git gc` produces exactly it, and tsgit's reader already parses the exact chunk set git emits at
default settings.

**Anchors (re-verified; three design anchors corrected).**

| Thing | Anchor |
|---|---|
| the reader (the spec) | `src/domain/commit/commit-graph.ts` (315 lines). ⚠️ constants are **:5–29**: `MAGIC 'CGPH'` :5, `SUPPORTED_VERSION 1` :6, `HEADER_SIZE 8` :7, **`CHUNK_TABLE_ROW_SIZE 12` :8**, `FANOUT_ENTRIES 256` :9, `FANOUT_SIZE 1024` :10, **`CDAT_FIXED_SIZE 16` :11**, chunk ids `OIDF/OIDL/CDAT/GDA2/EDGE/BASE` :13–18, **`NO_PARENT 0x70000000` :21**, **`OCTOPUS_FLAG 0x80000000` :23**, `EDGE_LAST_FLAG` :25, `EDGE_POS_MASK` :27, **`GENERATION_OVERFLOW_FLAG` :29** |
| parse entry point | **`parseCommitGraphLayer(bytes: Uint8Array): CommitGraphLayer` :62–125**; `CommitGraphLayer` :46–60; `CommitData` :36–43 |
| chunk table | `readChunkTable(bytes, view, numChunks, hashLength)` **:127–158** — `rowCount = numChunks + 1` :133, trailer bound check :148–151, ranges from consecutive row offsets :154–156; `requireChunk` :160–166; `validateChunkSize` :168–175 |
| size validation | :90–104 — `hashLength = hashVersion === 1 ? 20 : 32` **:86**; OIDF must be exactly `FANOUT_SIZE` :91; `commitCount = view.getUint32(oidf.start + 255*4)` :92; OIDL :95; `commitDataEntrySize = hashLength + CDAT_FIXED_SIZE` :97; CDAT :99; GDA2 :101–104. **EDGE's size is deliberately unvalidated** (bounds checked at read in `readEdgeChain` :281–295) |
| the CDAT entry | `commitDataAt(layer, localPos)` **:242–262** at `_commitDataOffset + localPos*(hashLength+16)`: `[0,hashLength)` root tree raw bytes; `+4` parent1 u32BE (`NO_PARENT` when absent); `+4` parent2 (`NO_PARENT`, a plain position, or `OCTOPUS_FLAG \| edgeIndex`); `+4` genWord; `+4` dateWord. Decode: **`committerDate = (genWord & 0x3) * 2**32 + dateWord` :254** and **`generationV1 = genWord >>> 2` :255** — a **34-bit** committer date and a **30-bit** topological generation |
| ⚠️ corrected | `resolveGeneration` is **:297–315** (`:314` is only its final `return`); the **GDO2 degrade is :307–313** — when `raw & GENERATION_OVERFLOW_FLAG`, the reader silently returns `generationV1`. **There is no `GDO2` chunk id and no GDO2 parsing** |
| base graphs | `readBaseGraphHashes` **:177–201**, with a refusal when BASE is missing but `numBaseGraphs > 0` (:184–191). The writer emits `numBaseGraphs = 0` and no BASE chunk |
| ⚠️ corrected | the test-only encoder is **`test/unit/domain/commit/arbitraries.ts:75`** (not `:107`), `buildCommitGraphBytes(model: CommitGraphLayerModel): Uint8Array`, docstring **:70–74** — *"Production code never writes this format … so the encoder lives beside the arbitraries it serves"*. **That docstring must be amended by this part.** `CommitGraphCommitModel` :19–26, `CommitGraphLayerModel` :28–34, `arbCommitGraphLayerModel` **:217–272** (1–6 commits, ≤4 parents, ≤3 base graphs). Reusable private helpers: `hashLengthFor` :36, `setUint64BE` :40, `planEdgeChunk` :52, `writeFanoutAndLookup` :164, `writeCommitData` :184, `resolveParent2` :210. ⚠️ **it writes no trailer digest** (allocates `trailerStart + hashLength` and leaves it zero) — the production writer must add one |
| where it lands | `src/application/primitives/path-layout.ts` — **`commitGraphPath(gitDir)` :90** → `${gitDir}/objects/info/commit-graph`; `commitGraphChainPath` :93–94 and `commitGraphLayerPath` :97–98 exist for the **split** form, which this writer does **not** produce; `lockSuffix = '.lock'` :116; `commonGitDir(ctx)` :41 |
| ⚠️ corrected | **there is no generic atomic-write helper.** `src/application/primitives/atomic-write.ts` (not `internal/`) exports only **`atomicWriteRef(ctx, refName, refPath, content)` :11–39**, ref-scoped by its own docstring, with a best-effort lock `rm` on rename failure (:32–36). A **new generic lock-then-rename helper** is owed for `objects/info/commit-graph.lock` |
| sourcing commits | `src/application/primitives/walk-commits.ts` — `walkCommits(ctx, options): AsyncIterable<Commit>` **:98–122**; `WalkCommitsOptions` is **`src/application/primitives/types.ts:121–140`** |
| ⚠️ do NOT reuse | fsck's `buildReachableSet` (`internal/fsck/reachability.ts:152`) is **universe-bounded** — it requires decoding every object in the repository first (`fsck.ts:79–82,94`), O(all objects) before the walk starts, for a task that needs only commits |
| ⚠️ self-reference hazard | `internal/read-commit-graph.ts` short-circuits for shallow repositories (**:183**) and **poisons a corrupt graph for the Context's lifetime** (:309–317). **The writer must read commit *objects*, never the graph it is about to replace**, or it encodes a stale generation set. Note also there is **no invalidation hook** — `graphCache` (:52) / `headerCache` (:81) mean a graph written mid-`Context` is invisible until a **fresh Context** |

**What lands.**

1. **A pure domain serializer** — `src/domain/commit/commit-graph-writer.ts`:
   `serializeCommitGraph(commits, hashConfig): Uint8Array`. Same split `pack-writer.ts` /
   `write-pack-artifacts.ts` already uses; being pure and in the domain is what makes it
   100 %-coverage-testable and property-testable **against the existing reader**.
2. **A thin application wrapper** — gathers the commit set and writes the file under the lock.
3. **The exact bytes to emit** (Pins C, K, M, N): magic `CGPH`, version `1`, hash version `1`
   (SHA-1) / `2` (SHA-256), **chunk count 4** (`OIDF OIDL CDAT GDA2`) — **5 when any octopus merge
   is present** (`+ EDGE`, the only conditional chunk) — base-graph count `0`; chunk table of
   `numChunks+1` rows × 12 B terminated by a zero-id row carrying the trailer offset; `OIDF`
   exactly 1024 B of 256 big-endian cumulative counts; `OIDL` **oid-sorted** (this ordering
   *defines* every position index); `CDAT` per the table above; `GDA2` holding
   `correctedCommitDate − committerDate` per commit as u32, where
   `correctedCommitDate = max(committerDate, 1 + max(parents' correctedCommitDate))`;
   `generationV1` = the topological level (`0` for a root, `1 + max(parents' level)` otherwise).
   **No BASE, no Bloom chunks** (the changed-path Bloom chunks appear only under `--changed-paths`, so omitting
   them is what byte-identity with the default write *requires*).
4. **Two refusals, not truncations.** (a) A repository with a committer date **≥ 2³⁴** cannot be
   encoded — refuse with typed data. (b) **`GDO2` must not be emitted**: when a corrected-date
   offset would exceed `0x7fffffff`, git sets `GENERATION_OVERFLOW_FLAG` and puts the true value in
   a `GDO2` chunk that **tsgit's reader does not parse** (:307–313) — emitting it would produce a
   file tsgit itself reads with reduced fidelity. **Refuse, write nothing, leave any existing graph
   intact.**
5. ⚠️ **Implementer-owed empirical pin.** git's behaviour under corrected-date overflow is
   **unpinned** — the design's skew probe failed on git's date parser
   (`fatal: invalid date format: 2500-01-01…`). Before the interop test claims parity here: in a
   `mktemp -d` throwaway (isolated `HOME`, `GIT_*` scrubbed, signing off), build a repo with a
   corrected-date offset past 2³¹ using **`GIT_COMMITTER_DATE=@<epoch>`** (the seconds form, which
   the ISO parser rejected), run `git commit-graph write --reachable`, and record whether a `GDO2`
   chunk appears and what `numChunks` becomes. If git emits `GDO2`, the honest options are to parse
   it (a reader change) or keep the refusal **with an ADR line**. **Do not silently emit a chunk
   tsgit cannot read.** Record the matrix in the design doc.
6. **The commit set is refs-only — and that is NOT gc's root set** (Pin O vs Pin H). Say it in the
   naming: **`commitGraphRoots` vs `retentionRoots`**, not in a comment.
7. **The lock.** Pin L: git holds `objects/info/commit-graph.lock` and refuses with
   `fatal: Unable to create '…commit-graph.lock': File exists.` Take the **same path** through the
   new generic lock-then-rename helper, so a tsgit write and a concurrent
   `git commit-graph write` exclude each other rather than interleaving.
8. **`@writes` tag + write-surface registration.** Every write surface in `src/` carries a
   `@writes` tag consumed by `tooling/audit-write-surfaces.ts` (`check:write-surfaces`, currently
   **warn-only**). Add `surface: commitGraph`, `kind: byte-identical`,
   `format: commit-graph-v1`, and give the interop test a matching `interopSurface: commitGraph`.

### TDD steps

1. **RED** — `test/unit/domain/commit/commit-graph-writer.properties.test.ts` (new, lens 1,
   `numRuns: 200`): `Given an arbitrary commit DAG` / `When serialized then parsed` /
   `Then parseCommitGraphLayer round-trips it` — reusing `arbCommitGraphLayerModel`
   (`arbitraries.ts:217–272`), including **octopus merges** and **multi-root DAGs**. Fails: no
   serializer.
2. **RED** — `test/unit/domain/commit/commit-graph-writer.test.ts`, one `it` per field:
   header bytes (`CGPH`, v1, hash version **1** and **2** — two tests); `numChunks === 4` without
   an octopus merge and `=== 5` with one (two tests, the pair that kills the conditional-chunk
   mutant); `OIDF` exactly 1024 B with correct cumulative counts; `OIDL` oid-sorted;
   `CDAT` field-by-field including the `(genWord & 3) << 32 | dateWord` split;
   `GDA2` corrected-date offsets; `NO_PARENT` for a root; `OCTOPUS_FLAG | edgeIndex` for >2
   parents; `numBaseGraphs === 0` and **no BASE chunk**.
3. **RED** — the two refusals, **each its own test**: `Given a committer date ≥ 2^34` /
   `Then it refuses with typed data and writes nothing`; `Given a corrected-date offset past
   0x7fffffff` / `Then it refuses rather than emitting GDO2`, asserting `.data` (code + reason).
4. **RED** — `test/unit/application/primitives/write-commit-graph.test.ts`: `Given an existing
   commit-graph.lock` / `Then the write refuses and the existing graph is untouched`;
   `Given a successful write` / `Then the lock is released and the file is at
   objects/info/commit-graph`; `Given a repository with a commit reachable only from a reflog` /
   `Then it is absent from the graph` (Pin O, refs-only roots);
   `Given a corrupt existing graph` / `Then the writer reads commit objects, not the graph`.
5. **GREEN** — the serializer, the generic lock-then-rename helper, the primitive.
6. **REFACTOR** — amend `arbitraries.ts:70–74`'s docstring (production **does** write this format
   now); factor `hashLengthFor` / `setUint64BE`-shaped helpers so the test encoder and the
   production writer do not drift; every function under 20 lines; no `any`.
7. **Oracle (R22)** — **new** `test/integration/commit-graph-write-interop.test.ts` with the
   `@proves` block (`surface: commitGraph`, `bucket: cross-tool-interop`,
   `interopSurface: commitGraph`, a `unique:` sentence), one shared `beforeAll` repo, **60 s
   timeout**, `GIT_*` scrubbed, `HOME` isolated, signing **off** — reusing
   `test/integration/interop-helpers.ts` (`git` :200–201, `runGit` :91–102, `runGitEnv` :105,
   `GIT_AVAILABLE` :149, `disableAutoMaintenance` :221–225, `makePeerPair` :181–189). Rows:
   byte identity vs `git commit-graph write --reachable` on a **linear** history, a **merge**
   repo and an **octopus** repo; the same in a `--object-format=sha256` repo (header hash
   version 2); `git commit-graph verify` on tsgit's file → **silent, exit 0**; a reflog-only
   commit **absent** from tsgit's graph exactly as from git's.

### Gate

- Part gate: `npx vitest run test/unit/domain/commit/commit-graph-writer.test.ts test/unit/domain/commit/commit-graph-writer.properties.test.ts test/unit/application/primitives/write-commit-graph.test.ts test/unit/domain/commit/commit-graph.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commit/commit-graph-writer.ts src/application/primitives/write-commit-graph.ts src/application/primitives/atomic-write.ts`
- Targeted extras: `npx vitest run test/integration/commit-graph-write-interop.test.ts` ·
  `npm run test:coverage` (new `src/domain/**` is a **100 %** gate; `domain` mutation bucket break
  99 / low 100) · `npm run check:architecture` · the GDO2 probe, matrix recorded in the design doc.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(domain): write the commit-graph byte-identically to git`

---

## Part 23 — The `maintenance` command and its full Tier-1 surface

### Context

Design §P9 → Command surface + §Surface gates · **ADR-724**, **ADR-249**. This part puts the public
command on Part 22's writer and **pre-pays every surface gate once**, so Parts 24–27 extend a
surface that already exists rather than re-tripping the checklist.

**Public-surface decision, made here:** `maintenance`, `MaintenanceOptions`, `MaintenanceResult`
and `MaintenanceTask` are **public**. `MaintenanceTask` ships as the **full** union
`'commit-graph' | 'gc'` from day one **only if** `gc` is implemented; it is **not**, so this part
ships `MaintenanceTask = 'commit-graph'` and **Part 25 widens it**. Both parts regenerate
`reports/api.json`. Shipping a declared-but-unimplemented task would be a lie on the public surface.

**The surface, exactly (ADR-249 — every field is a count, a boolean, an enum or an oid; no rendered
line, no formatted size, no message):**

```ts
export type MaintenanceTask = 'commit-graph';           // Part 25 adds | 'gc'

export interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
}
```

⚠️ **`auto?: boolean` is deliberately NOT shipped here.** It gates the `gc` task and nothing else,
so shipping it in this part would be a **declared-but-inert public option** — exactly the
`JoinOptions.concurrency` smell Part 4 removes. **Part 25 adds `auto` together with the task it
gates.** For the same reason `MaintenanceTask` ships as the single-member union: a declared-but-
unimplemented `'gc'` would be a lie on the public surface.

`tasks` is **required and non-empty**; an unknown task is an `invalidOption('tasks', …)` refusal
mirroring `git maintenance run --task=bogus` → `error: 'bogus' is not a valid task` (Pin D).
`tasksRun` echoes what **actually** ran — **not** a `skipped: true` flag, so that "ran nothing" and
"ran and found nothing" stay distinguishable from the counts. In this part it always equals
`tasks`; **Part 25's `auto` gate is what makes it load-bearing**, and it ships now because it is
part of the surface ADR-724 ratified and because widening a result type twice is churn.
**Explicit-only: no timer, no threshold check inside `status`, no write-path hook** (ADR-724).

**The surface-gate checklist — every row, with its exact anchor. Budget all twelve.**

| # | Gate | Anchor | What lands |
|---|---|---|---|
| 1 | command barrel | `src/application/commands/index.ts` — `packRefs` at **:222**, format `export { type PackRefsResult, packRefs } from './pack-refs.js';`; the multi-symbol form is :217–221. Sorted by module path (biome-enforced) | `export { type MaintenanceOptions, type MaintenanceResult, type MaintenanceTask, maintenance } from './maintenance.js';` — **between `./log.js` and `./merge.js`** |
| 2 | public barrel | `src/index.ts:3` is `export * from './application/commands/index.js';` | **nothing** — no per-command line exists; do not add one |
| 3 | facade interface | `src/repository.ts` — `packObjects` **:379**, `packRefs` **:380**; `BindCtx` :76 | `readonly maintenance: BindCtx<typeof commands.maintenance>;` ⚠️ **exactly two-space indent** — both `tooling/check-doc-coverage.ts` and `tooling/audit-browser-surface.ts` parse this file with `/^ {2}readonly (\w+):\s*BindCtx</gm`, so it must stay in the flat interface |
| 4 | facade impl | `src/repository.ts:793–796` (`packObjects`, the **options-taking arrow**) vs :797–800 (`packRefs`, no-arg) | the `packObjects` shape, param named **`maintenanceOpts`** (biome shadow rule), body `guard(); return commands.maintenance(ctx, maintenanceOpts);`, cast `as Repository['maintenance']` |
| 5 | binding-integrity key list | `test/unit/repository/repository.test.ts` — `it(` **:242**, assertion **:247**, array literal **:248–300** (`'log',` at :270, `'merge',` at :271) | insert `'maintenance',` **at line 271** |
| 6 | docs page + index row | template `docs/use/commands/pack-refs.md` (headings: `# \`packRefs\`` :1, `## Signature` :12, `## Behaviour` :24, `## Examples` :70, `## Throws` :81, `## See also` :88); index `docs/use/commands/README.md` — header line 3 says **"46 entries"**, table header :13–14, rows between `log` and `merge` | `docs/use/commands/maintenance.md` + one index row + **"46 entries" → 47** |
| 7 | parity scenario | `test/parity/scenarios/index.ts` — imports :1–47 alphabetical, **array :49–97 append-ordered (new entries go at the tail, after :96)**; template `test/parity/scenarios/pack-refs.scenario.ts`; `Scenario<T>` at `scenarios/types.ts:15–28`; runners `test/parity/node.test.ts` + `test/parity/memory.test.ts` (both `describe.each(SCENARIOS)`), `run-scenario.ts:18–26` always `dispose()`s | `maintenance.scenario.ts` + import + tail array entry. ⚠️ **it must work on the memory adapter**, not just Node — `check:browser-surface` requires a parity scenario or a browser spec, else an allowlist entry with a `reason` in `tooling/audit-browser-surface.allowlist.json` |
| 8 | README count | `README.md:47` — `- 46 Tier-1 commands · 20+ AsyncIterable primitives · operator toolkit (\`pipe\`, \`filter\`, \`map\`, …)` | 46 → **47** |
| 9 | `reports/api.json` | **prepush-only** gate `check:doc-typedoc` = `git diff --exit-code -- reports/api.json` | `npm run docs:json`, commit it **in this part** |
| 10 | size budgets | `.size-limit.json` — there is a **per-command row for every command** (peers 1.5–10 kB); plus `Commands (barrel)` 6 kB, `Full library` 335 kB, `Core` 50 kB | add a `dist/esm/commands/maintenance.js` row; **measure, do not assume headroom** (`rm -rf dist .wireit` first) |
| 11 | package exports | `package.json` `exports` carries **one subpath per command** | add the `maintenance` subpath |
| 12 | pyramid budgets | `test-pyramid-budgets.json` (repo root) — `integration` has a hard **`warnAbove: 25`**; gating heuristics include `gwtTitle`, `aaaBody`, `sutNaming`, `sutBindsResult` | new test files shift tier counts; **compensate a large interop suite with unit tests in the same PR** |

### TDD steps

1. **RED** — `test/unit/application/commands/maintenance.test.ts`: `Given tasks: []` /
   `Then it refuses with option 'tasks'`; `Given an unknown task` / `Then it refuses with option
   'tasks' and the offending value in .data`. Two tests, `.data` asserted — never the class.
2. **RED** — `Given tasks: ['commit-graph']` / `Then the graph is written and commitsInGraph
   matches the reachable commit count` and `Then tasksRun is ['commit-graph']`.
3. **RED** — `Given a repository with no commits` / `Then commitGraphWritten is false and
   tasksRun still reports the task ran` — the "ran and found nothing" vs "declined" distinction.
4. **RED** — `Given the result` / `Then it carries no rendered text` — assert every field is a
   number, boolean, string-enum or oid (ADR-249). A structural test, not prose.
5. **RED** — `test/unit/repository/repository.test.ts:247` with `'maintenance'` inserted at 271 —
   fails until the facade binding exists.
6. **GREEN** — `src/application/commands/maintenance.ts` over Part 22's primitive; the barrel; the
   facade interface + impl.
7. **GREEN** — the parity scenario (node **and** memory), registered at the tail of `SCENARIOS`.
8. **REFACTOR/GATES** — docs page + index row + "46 entries" → 47; `README.md:47`;
   `.size-limit.json` row; `package.json` exports subpath; **`npm run docs:json` + commit
   `reports/api.json`**.
9. **Oracle** — `npm run check:doc-coverage`, `npm run check:browser-surface`,
   `npm run check:size`, `npm run check:test-pyramid` and `npm run test:parity` all green;
   `git diff --exit-code -- reports/api.json` clean after regeneration.

### Gate

- Part gate: `npx vitest run test/unit/application/commands/maintenance.test.ts test/unit/repository/repository.test.ts test/parity && npm run check:types && ./node_modules/.bin/biome check src/application/commands/maintenance.ts src/application/commands/index.ts src/repository.ts test/parity/scenarios/maintenance.scenario.ts test/parity/scenarios/index.ts`
- Targeted extras (**this part trips the whole checklist — run every one**):
  `npm run check:doc-coverage` · `npm run check:browser-surface` · `npm run check:size` ·
  `npm run check:test-pyramid` · `npm run check:spelling` · `npm run docs:json` + commit
  `reports/api.json` · `npm run test:parity`.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(commands): add the maintenance command with the commit-graph task`

---

## Part 24 — gc foundations: configuration, expiry arithmetic, and the `.mtimes` format

### Context

Design §P9 → Task 2 (the new domain format module · the injectable clock · Config) ·
**ADR-731** · **R27**, **R28**. No pipeline yet — this part lands the three pieces the pipeline
needs, each with its own hard oracle, so Part 25 assembles rather than invents.

**Anchors — the config pattern (⚠️ it is SEVEN sites, not four).** To add a `gc` section to
`ParsedConfig`, copy `pack.writeReverseIndex` at **every** one of these
(`src/application/primitives/config-read.ts`):

| # | Line(s) | Site |
|---|---|---|
| 1 | **:113–114** | the public `ParsedConfig` member (`readonly pack?: { readonly writeReverseIndex?: boolean };`) |
| 2 | **:499** | `MutableParsedConfig`'s echo |
| 3 | **:537–538** | the `dispatchSection` arm (`} else if (section === 'pack') { mergePack(acc, sec); }`) |
| 4 | **:909–916** | `mergePack` itself (siblings `mergeCommit`/`mergeTag` :891–907 are identical in shape) |
| 5 | **:1048** | `FinalizeOut`'s echo |
| 6 | **:1086** | `finalizeScalarBuckets` (`if (acc.pack !== undefined) out.pack = acc.pack;`) |
| 7 | **:1127** | `finalize`'s inline `out` literal type |

⚠️ **Preserve the invariant at :1079–1082** — "only assign their bucket after observing a
recognised key, so a defined value is always non-empty"; a `gc` merger that assigns eagerly makes
`finalizeScalarBuckets` emit an empty object. Section names are lower-cased before dispatch (:507,
:522); keys are lower-cased inside each merger.

**The three keys (pinned).**

| Key | Type | Default | Semantics |
|---|---|---|---|
| `gc.auto` | integer | **6700** | Pin D/I — consulted **only** under `auto: true`; `0` disables every heuristic |
| `gc.pruneExpire` | date expression | **`2.weeks.ago`** | Pin R — `never` ⇒ nothing expires; `now` ⇒ no cruft pack written |
| `gc.cruftPacks` | boolean | **true** | Pin E/AA — `false` routes surviving unreachable objects to **loose**, it does not skip them |

**Validation machinery to reuse:** `parseGitBoolean` — `src/domain/config/config-ini.ts:796–807`
(git's exact `git_config_bool` grammar; re-exported `config-read.ts:31`); `parseGitInt` (same file,
`{ok,value}`/`{ok,reason}`); the eager refusal gate `assertValidBooleanConfig(ctx, section,
subsection, keys)` — `src/application/primitives/internal/boolean-config-guard.ts:12–20`; the
integer refusal precedent `resolveMaxTreeDepth`
(`internal/resolve-max-tree-depth.ts:16` → `configBadNumericValue`). `pack.writeReverseIndex`'s own
gate (`write-pack-artifacts.ts:72–83`) documents **why** it must run before any read: *a refused
value is left absent in `ParsedConfig`, so a bare `?? true` cannot tell "refused" from "unset"*.

**⚠️ Date expressions already exist — do not write a new parser from scratch.**
`src/domain/reflog/approxidate.ts` exports **`parseApproxidate(text: string, now: number): number |
undefined` :26–31** (re-exported `src/domain/reflog/index.ts:2`; consumers `commands/reflog.ts:10`,
`commands/rev-parse.ts:10`). It already handles `'now'` (:28), `'yesterday'` (:29), ISO
`YYYY-MM-DD[ HH:MM:SS]` (:21) and the relative form `^(\d+)[ .]([a-z]+?)s?(?:[ .]ago)?$` (:22) —
**so `2.weeks.ago` parses today**, with units at :10–19. **It does NOT handle `never` or
`@<epoch>`.** Extend or wrap it for exactly those two, and **refuse everything else**.

**Scope control is a safety property, not tidiness:** implement `never`, `now`, `@<epoch>`,
ISO-8601 and the `<n>.<unit>.ago` forms, and **refuse the rest** rather than approximating.
A date expression tsgit silently mis-parses **moves the cutoff, and moving the cutoff destroys
data**. Refusing an exotic-but-valid git expression is a recoverable inconvenience; mis-parsing one
is not. git's own refusal is pinned: `git gc --prune=bogus` → `fatal: failed to parse prune expiry
value bogus`, **exit 128, nothing written**. tsgit refuses with typed `invalidConfig`-family data
carrying the offending value, and writes nothing.
📌 **Related parked item:** `docs/BACKLOG.md:431` parks "idiomatic date inputs for
`reflog.expire`/`expireUnreachable`" — take the `gc.pruneExpire` **input shape** decision jointly
with it, and say so in the commit body rather than pre-judging it silently.

**The injectable clock — the house pattern, copied exactly, not invented.**
`src/application/primitives/internal/index-lock.ts:6–9`:
```ts
interface AcquireOptions {
  /** Injectable clock — defaults to `Date.now`. Tests override to simulate stale/skewed locks. */
  readonly now?: () => number;
}
```
consumed at **:50** as `const now = opts.now ?? (() => Date.now());`. The gc pipeline's **internal**
options bag takes the same field with the same docstring shape. **Being internal, it does not widen
`reports/api.json` and does not appear on `MaintenanceOptions`** — a public "pretend it is Tuesday"
knob is not a feature.
⚠️ **The unit mismatch is handled once, at the seam:** `Date.now()` is **milliseconds**, the sidecar
stores **seconds** (Pin P). Convert exactly where the cutoff is computed —
`Math.floor(now() / 1000)`, as `reflog-identity.ts:31` and `commit.ts:355` already do — and keep
every downstream comparison in seconds. Mixing them is a 1000× expiry bug that a fixed-clock test
catches **only if the test's clock is also in milliseconds**. Write it that way.

**The `.mtimes` format module — `src/domain/storage/cruft-pack.ts`.** Pure, zero platform
dependencies, inside the **100 % coverage** gate, and a **near-clone of `rev-index.ts`**:

```ts
export const CRUFT_MTIMES_MAGIC = 0x4d544d45;   // 'MTME' — note the final byte is 45/'E', not 53/'S'
const CRUFT_HEADER_SIZE = 12;

export function serializeCruftMtimes(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
  mtimeOf: (oid: ObjectId) => number,
  presorted?: ReadonlyArray<SortedEntry>,
): Uint8Array;

export function parseCruftMtimes(
  bytes: Uint8Array,
  oidsInIndexOrder: ReadonlyArray<ObjectId>,
): ReadonlyMap<ObjectId, number>;
```

Line for line against `serializePackRevIndex` (⚠️ **`src/domain/storage/rev-index.ts:112–143`**,
not `:111–142`):

| `serializePackRevIndex` | `serializeCruftMtimes` |
|---|---|
| refuses `digestLength ∉ {20,32}` with `invalidPackRevIndex('hash-id', …)` (`:118–123`; the factory is `src/domain/storage/error.ts:79`) | the same guard with its own typed refusal — a width the pack cannot carry must **refuse, not truncate** |
| `const hashId = digestLength === 32 ? 2 : 1;` **`:125`** | **identical** (Pin U) |
| `packPositionsByOffset(presorted ?? sortPackIndexEntries(entries))` (`:129`; the helper is **private**, `rev-index.ts:152–165`) | `mtimeOf` applied over `presorted ?? sortPackIndexEntries(entries)` — the same **one-sort-per-pack** contract and the same `presorted` hand-off from the `.idx` writer's caller (`sortPackIndexEntries` + `SortedEntry` live in **`src/domain/storage/pack-order.ts:15–24` / `:4–7`**) |
| allocates `REV_HEADER_SIZE + 4n + 2·digestLength` (`:131`; `REV_HEADER_SIZE = 12` :18) | allocates `CRUFT_HEADER_SIZE + 4n + 2·digestLength` — Pin P's `68 = 12 + 16 + 20 + 20` |
| writes magic (`:134`) / `1` (`:135`) / `hashId` (`:136`), then the `u32BE` body (`:138`), then `packChecksum` (`:140`), **leaving the self-checksum zeroed** | **identical**, with `MTME` for `RIDX` |

The trailer is finalised by an application-layer `buildMtimes` that copies **`buildRev`
(`src/application/primitives/internal/write-pack-artifacts.ts:54–70`)** verbatim, including its
"one width source" argument: `trailerStart = bytes.length - packChecksum.length`,
`ctx.hash.hash(bytes.subarray(0, trailerStart))`, `bytes.set(digest, trailerStart)`. Pin P confirmed
**empirically** that git's digest covers the pack-checksum field, so `buildRev`'s offset arithmetic
is right without adjustment. `artifactPaths` (**`:109–114`**) gains **`mtimesPath`**, one line,
matching Pin T's naming.

⚠️ **The ordering contract is the one thing a reader must not get wrong, and it deserves a named
type rather than a comment:** the `u32BE` at slot *i* belongs to the oid at **`.idx` position
*i* — oid-ascending, **not** pack-offset order. `serializePackRevIndex` is the trap next door,
because its body *is* offset-indexed. **Two sibling files, two different index spaces — name them
`mtimesByIndexPosition` vs `packPositionsByOffset`** so the difference is unmissable at the call
site. `parseCruftMtimes` takes the oid list from the already-parsed sibling `.idx` rather than
re-parsing it — **the reader half must never invent its own index order.**

**`settleRefresh` on the pack registry.** `refresh()`
(`src/application/primitives/pack-registry.ts:784–807`) closes the outgoing generation's persistent
`FileHandle`s but hands the batch to `trackClose` (:601–607) and returns **`void`**; only
`dispose()` (**:825–846**, terminal: `disposed = true`, `all()` keeps returning the retired set)
drains `pendingCloses` (:597) via the private `drainPendingCloses` (:609–614). Parts 25–27 must
**await the drain before unlinking a pack**. The minimal honest change is **one new `PackRegistry`
member** (interface **:195–259**) — `settleRefresh(): Promise<void>` exposing the existing private
drain — **with gc as its only caller**.
⚠️ **Implementer-owed pin, on the Windows CI job** (`ci.yml:252` runs `windows-latest`): whether
Node's `unlink` refuses a `.pack` with a live `FileHandle`. **Draining first is correct on every
platform regardless** — on POSIX an unlinked-but-open pack keeps its bytes allocated until the fd
closes, so `packBytesAfter` would otherwise report space the filesystem has not yet reclaimed.

### TDD steps

1. **RED** — `test/unit/domain/storage/cruft-pack.test.ts`, field by field against Pin P's real
   bytes: signature `MTME`; version `1`; hash id `1` **and** `2` (two tests); `objectCount`
   entries; the total length `12 + 4n + 2·hashLength`; the pack checksum equal to the `.pack`
   trailer; the self-checksum over **everything before it, including the pack-checksum field**.
2. **RED** — **the `.idx`-order test, with a deliberately non-monotonic mtime fixture** (Pin P's
   three entries: oids ascending, mtimes `1767225660 / 1787754322 / 1785538860`) — an
   offset-indexed implementation must **fail** this. This is the single most valuable test in the
   part.
3. **RED** — the two `parseCruftMtimes` guards, **separately**: `Given a count that disagrees with
   the .idx` / `Then it refuses`; `Given a bad self-checksum` / `Then it refuses`. `if (A || B)
   throw` needs each condition triggered alone.
4. **RED** — `Given a digest width that is neither 20 nor 32` / `Then it refuses rather than
   truncating`.
5. **RED** — **new** `test/unit/domain/storage/cruft-pack.properties.test.ts` (R27, lens 1,
   **`numRuns: 200`**): `Given an arbitrary object count, u32 mtime vector and hash width` /
   `Then parseCruftMtimes ∘ serializeCruftMtimes is the identity`. Generators in the directory's
   `arbitraries.ts`. The example test pins git's literal bytes; the property proves the grammar —
   **neither substitutes for the other**.
6. **RED** — `test/unit/application/primitives/expiry-cutoff.test.ts`: one test per grammar form
   (`never` → nothing expires; `now`; `@<epoch>`; ISO-8601; `2.weeks.ago`), plus
   `Given an unsupported expression` / `Then it refuses with the offending value in .data`, plus
   **`Given a millisecond clock` / `Then the cutoff is in seconds`** (the 1000× bug).
7. **RED** — `test/unit/application/primitives/config-read.test.ts`: `gc.auto` default 6700, `0`,
   and a malformed value refusing; `gc.cruftPacks` default true and a malformed value refusing;
   `gc.pruneExpire` default `2.weeks.ago`. Each refusal asserted on `.data`.
8. **RED** — `test/unit/application/primitives/pack-registry.test.ts`: `Given a refresh with
   outgoing handles` / `When settleRefresh is awaited` / `Then every outgoing handle is closed`.
9. **GREEN** — the seven config sites; the expiry-cutoff helper + clock; `cruft-pack.ts`;
   `mtimesPath`; `settleRefresh`.
10. **REFACTOR** — the two index spaces are named types; no magic values; the clock's docstring
    matches `index-lock.ts:7–8` word for word.
11. **Oracle** — the property test plus a byte comparison of `serializeCruftMtimes`'s output
    against a real `.mtimes` produced by `git gc` on a `mktemp -d` throwaway for the same cruft set
    (that comparison rides into Part 25's interop suite; here it is a fixture assertion).

### Gate

- Part gate: `npx vitest run test/unit/domain/storage/cruft-pack.test.ts test/unit/domain/storage/cruft-pack.properties.test.ts test/unit/application/primitives/expiry-cutoff.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/domain/reflog/approxidate.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/cruft-pack.ts src/domain/reflog/approxidate.ts src/application/primitives/config-read.ts src/application/primitives/pack-registry.ts src/application/primitives/internal/write-pack-artifacts.ts`
- Targeted extras: `npm run test:coverage` (new `src/domain/**` is a **100 %** gate) ·
  `npm run check:architecture`.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(domain): add the cruft-pack mtimes format, gc configuration and an injectable expiry clock`

---

## Part 25 — The `gc` task: reachable loose objects packed, unreachable ones crufted

### Context

Design §P9 → Task 2, pipeline steps 1–11 restricted to the **loose** candidate universe ·
**ADR-724**, **ADR-731** · **R23–R31**. Existing packs are **not** touched here — Part 26 adds
consolidation and Part 27 the promisor class. That restriction is a coherent, git-comparable
posture on its own (it never destroys an object git would keep), and it keeps this part reviewable.

**Public surface widened here** (`reports/api.json` regenerated **in this part**):
`MaintenanceTask` gains `| 'gc'`; **`MaintenanceOptions` gains `readonly auto?: boolean`**
(deferred from Part 23 because it gates this task and nothing else — see there);
`MaintenanceResult` gains
`looseObjectsBefore`, `looseObjectsPacked`, `prunedLooseObjects`, `packsBefore`, `packsAfter`,
`packId: ObjectId | undefined`, and the four cruft scalars `cruftObjectsAdded`,
`cruftObjectsRetained`, `cruftObjectsExpired`, `cruftPackId: ObjectId | undefined`.

**Why each cruft scalar exists** (it maps one-to-one onto Pin S's three-way outcome — the only way
a caller can tell the three apart): `cruftObjectsAdded` = newly-unreachable objects that entered the
cruft pack; `cruftObjectsRetained` = objects carried forward with mtimes intact, which distinguishes
"wrote a cruft pack because there was new garbage" from "rewrote it because some aged out";
`cruftObjectsExpired` = objects **destroyed** — the one number in this design that counts data
leaving the repository forever, and it is its own field precisely so a caller that alarms on it does
not have to infer it from a difference; `cruftPackId` = `undefined` is Pin S row 3 (everything
expired) *and* Pin R's `--prune=now`. **"No rewrite" is not "no cruft pack"** — when the surviving
set is unchanged, `cruftPackId` still reports the existing sha.

**Anchors.**

| Thing | Anchor |
|---|---|
| loose enumeration | `src/application/primitives/enumerate-objects.ts` — `enumerateObjects(ctx, opts)` **:23–53**, loose half **:41–53**: walks all 256 `HEX_PREFIXES` (**:67–69**, module-private) with `exists` **then** `readdir` = up to **512 serial fs round trips**. Its only caller today is `commands/fsck.ts:79`. ⚠️ **It surfaces no mtimes** — gc must `lstat` the loose files itself |
| retention roots | `src/application/commands/internal/fsck/roots.ts` — `collectRoots(ctx, opts, universe)` **:265–276**, `addRefRoots` **:80–101**, `addReflogRoots` **:103–122**, `addIndexRoots` **:220–234**, `RootsCollection` :236–252. ⚠️ **all three `add*Roots` are module-private, and `collectRoots` is universe-bounded** (it needs a pre-built `Set` of every object — the wrong cost shape). **Reuse the root collection, not the walk**: export the three collectors or lift them into a shared internal module |
| reachability | `src/application/primitives/internal/closure-engine.ts` — `computeClosure(ctx, request)` **:260–276**; `ClosureTier = 'bitmap' \| 'walk'` **:39, no engine-side default**; `ClosureRequest` :41–65 (`wants`, `not`, `objects`, `tier`, …) takes **oids, not refs**; `ClosureResult` :77 |
| pack build | `src/application/primitives/build-pack.ts` — `buildPack(ctx, { oids })` **:40–53**, **serial `for` loop :41–45** (one `readObject` + one deflate per oid, no bound), `encodeEntry` :55–67. **Non-delta by design** (docstring :1–12) |
| artefact write | `internal/write-pack-artifacts.ts` — `writePackArtifacts(ctx, input)` **:141–163**: `mkdir` :147, one shared `sortPackIndexEntries` :148, then `.pack` → `.idx` → optional `.promisor` → optional `.rev`, **all through `writeExclusive`**; `wantRev` resolved at **:145 before any artefact is created**, from `pack.writeReverseIndex` (:80–83) |
| where packs live | `src/application/primitives/path-layout.ts` — `packsDir(gitDir)` **:77** → `${gitDir}/objects/pack`; `commonGitDir(ctx)` :41; `objectsDir(gitDir, prefix)` :75; `multiPackIndexPath(packsDir)` :106 |
| pack classification input | `pack-registry.ts:547–565` — one shared `readdir` already builds **`const fileNames = new Set(...)` at :559**, consumed by `loadPack(ctx, dir, entryName, fileNames)` (:280–292) where `hasRevIndex` and `hasBitmap` are plain `fileNames.has(...)` lookups. ⚠️ **`loadPack` has no `.keep`/`.promisor`/`.mtimes` awareness today** |
| delete | `src/ports/file-system.ts:106–107` — `rm(path)` **"Throws FILE_NOT_FOUND if not found"**, i.e. **not idempotent**; `unlink`/`remove` do not exist on the port. `writeExclusive`'s contract (:66–80) already anticipates a concurrent pruner removing the fanout and **retries once** — a host `git gc` against the same repository is a **supported** concurrency, not an excluded one |
| the invariant this falsifies | `src/application/primitives/internal/loose-oid-cache.ts` states **"tsgit never prunes loose objects"** twice in prose — **:13–16** and **:59–66** — and its only mutator `invalidateLooseOid` (**:67–69**) is **add-only**. `forgetLooseOidPrefix` (**:76–78**) is the sole removal escape hatch and its docstring frames the pruner as **external** (`git gc`). Consumers to walk: `object-resolver.ts:197` (the probe) and **:203** (stale-HIT recovery), `write-object.ts:49` and `:54`, `internal/fsck/object-presence.ts:45` |
| the other stale prose | `src/application/commands/pack-refs.ts:8` says in-source *"tsgit has neither `gc` nor `prune`"* |
| verification opt-in | Part 12 flipped `verifyHash` to default **false**. **Step 8 is the one place in the codebase that opts back IN explicitly** |
| commit-graph caches | `internal/read-commit-graph.ts` has **no invalidation hook** (`graphCache` :52, `headerCache` :81, corrupt-poison :309–317) — a graph or pack written mid-`Context` is invisible until a **fresh Context**. Interop tests must construct one after every write |

**The pipeline, this part's scope.**

1. **Count.** `enumerateObjects(ctx, { includePacks: false })` → the loose set → `looseObjectsBefore`.
   The 512-round-trip enumeration goes through Part 3/4's **`ioBound`** pool — the single largest
   win available in this task, and the reason P9 sits after P1. If `auto` is set and the count does
   not exceed `gc.auto`, **return with `tasksRun` omitting `'gc'`**.
   ⚠️ **`auto` mirrors `git maintenance run --auto`, and the split is deliberate**: Pin I is
   decisive — **explicit `git gc` ignores `gc.auto` entirely** (with `gc.auto=0` it still packed);
   only `--auto` consults the threshold. The gate uses an **exact loose count**, not git's
   estimator: git's `--auto` predicate samples a single fanout directory, its own documentation says
   "**approximately** more than this many loose objects", and the exact sampling predicate **could
   not be reproduced**. An exact count sits inside git's documented "approximately", is strictly
   more accurate, and is free because gc enumerates the loose objects anyway. **State it in the docs
   page, do not leave it inferred.**
2. **Read the existing cruft pack, if any.** Parse `pack-<sha>.mtimes` with `parseCruftMtimes`
   against its sibling `.idx`'s oid list → `existingCruft: Map<oid, mtime>`. An absent sidecar ⇒
   empty map and every downstream branch degenerates correctly. A `.mtimes` whose object count
   disagrees with its `.idx`, or whose self-checksum fails, is a **typed refusal that writes
   nothing** — never a silent empty map.
3. **Collect retention roots** — refs **+ HEAD + index + reflogs** (Pin H). ⚠️ **Not the same root
   set as the commit-graph task** (Pin O: refs only). Say it in the naming — `retentionRoots` vs
   Part 22's `commitGraphRoots`.
4. **Partition by reachability** over the **loose** universe plus `existingCruft`:
   ```text
   owned           = looseSet ∪ existingCruft.keys
   toNormalPack    = reachable ∩ owned
   cruftCandidates = owned \ reachable
   mtime(o)        = max( lstat(loose path).mtimeMs  if o ∈ looseSet,
                          existingCruft.get(o)       if o ∈ existingCruft )
   ```
   ⚠️ **`mtime` is a `max`, not a lookup with a fallback, and the difference is destructive.** An
   object can legitimately have both sources — a crufted object the caller has since rewritten
   (Pin Q's freshen probe) — and taking either one unconditionally destroys something the user just
   wrote. **No source is the current time**, and a helper that defaults to "now" when it cannot
   `lstat` is the exact bug the pin exists to prevent: it makes aged garbage immortal. **A failed
   `lstat` is a refusal, not a `Date.now()` fallback.**
   Reachability is recomputed over the whole `owned` set every run, which subsumes Pin S's
   resurrection rule as a special case rather than needing a dedicated intersection.
5. **Apply the cutoff** (Pin R, a **strict** `>`):
   ```text
   survivors = { o ∈ cruftCandidates : mtime(o) >  cutoff }
   doomed    = { o ∈ cruftCandidates : mtime(o) <= cutoff }
   ```
   `gc.pruneExpire=never` ⇒ `cutoff = -Infinity`, `doomed` empty. `now` ⇒ `cutoff = now`, the
   surviving set is empty and step 7 takes its **delete** branch — per Pin R, **no cruft pack is
   written at all**.
6. **Build and write the normal pack.** `buildPack(ctx, { oids: toNormalPack })` →
   `writePackArtifacts(ctx, { packDir: packsDir(commonGitDir(ctx)), … })`. `packId` is the pack sha.
   **Skipped entirely when `toNormalPack` is empty** — Pin V proves git writes **no** pack rather
   than a zero-object one. `buildPack`'s per-oid `readObject` + deflate loop is **`cpuBound`**.
7. **Decide the cruft pack's fate** — Pin S's three-way branch, evaluated as a **set comparison,
   never as a schedule**:

   | Condition | Action |
   |---|---|
   | `survivors` == `existingCruft`'s key set | **no-op.** Leave the sidecar and its pack **untouched** — name and bytes unchanged. `cruftPackId` reports the existing sha |
   | `survivors` empty | **delete branch** (step 10) — no empty cruft pack is ever written |
   | otherwise | `buildPack(survivors)` + `writePackArtifacts` + `buildMtimes` under a **new** sha; the old cruft pack's four siblings retire at step 10 |

   ⚠️ **The no-op branch is a faithfulness requirement, not an optimisation.** An always-rewrite
   implementation stays functionally correct but **churns the pack sha on every run**, which is
   observable and which the interop pin catches. Pin W refines what "leaves" means: git replaces the
   file with byte-identical content under the same name, so **inode and mtime move while name and
   bytes do not**. **The interop assertion compares name and bytes, never inode or `st_mtime`** —
   an identity assertion would fail one of the two correct implementations for the wrong reason.
8. **Refresh, then verify.** `refreshPackRegistry(ctx)`, then read **every** oid just packed —
   into either pack — back out with **`verifyHash: true` passed explicitly**. gc is about to delete
   the only other copy, so "trust the bytes" is exactly wrong here; and under ADR-731 this covers
   the **cruft** pack too — the objects with the weakest claim on being kept are exactly the ones
   nobody else will notice going bad. **It must be a read through the registry**, not a trust of
   the bytes just serialised in memory. **Do not make it conditional and do not sample it.**
9. **Prune loose.** Only now unlink, via `ctx.fs.rm`:
   ```text
   survivingPacks = { the new normal pack } if step 6 wrote one
                  ∪ { the cruft pack, if one exists after step 7 }
                  ∪ { every pre-existing pack }        # untouched in this part
   unlink         = looseSet ∩ ⋃{ oids of each pack in survivingPacks }
                  ∪ (doomed ∩ looseSet)                # expired and loose ⇒ destroyed HERE
   ```
   git's `count-objects -v` names the first class `prune-packable` and `repack -d` removes it.
   `prunedLooseObjects` counts **every** unlink and may exceed `looseObjectsPacked`; the fields stay
   separate so the difference is **visible rather than silent**. **Narrow `FILE_NOT_FOUND` and
   rethrow every other code** — a bare `catch {}` is a guardrail violation.
   **Step 9b — await `settleRefresh()`** (Part 24) before any unlink of a pack file.
10. **Retire the superseded cruft pack.** Delete `pack-<oldSha>.{idx,rev,pack,mtimes}` — **all
    four**, tolerating an absent `.rev` when `pack.writeReverseIndex` is off. **Order matters
    twice**: the **`.idx` goes FIRST**, which removes the pack from git's *and* tsgit's readers in a
    single unlink (`pack-registry.ts:261–263` keys the scan on `.idx`; `loadCandidatePack:457–471`
    already skips an `.idx` with no `.pack`), so everything after it operates on litter; and the
    **`.mtimes` goes LAST**, so the only reachable partial state is a pack that reads as an
    **ordinary** one — objects retained, ages forgotten — rather than a sidecar with no pack, which
    step 2 would have to refuse.
11. **Invalidate.** `forgetLooseOidPrefix` for **every fanout prefix touched** — or add a
    remove-member helper — **in the same commit that adds the unlink**, and **rewrite the two prose
    blocks** at `loose-oid-cache.ts:13–16` and `:59–66` plus `pack-refs.ts:8`. Then `refresh()` the
    pack registry a second time so the retired pack leaves the current generation.

**Out of `maintenance`'s scope, deliberately** (Pin J): `git gc` also runs `pack-refs`,
`reflog expire` and `worktree prune`. tsgit already ships `packRefs()` as its own Tier-1 command;
folding it in would make one call mutate the ref backend as a side effect. **`maintenance` touches
objects only** — R26 asserts refs, reflogs and the index are byte-identical across the call.

⚠️ **`gc` is the first tsgit command that can DESTROY data.** Reviews weight the expiry predicate
and the step-9/10 deletion set accordingly, and the docs page says so **in the caller's words, not
in a footnote**.

### TDD steps

1. **RED** — `test/unit/application/commands/maintenance.test.ts`, the `auto` gate: `Given auto is
   absent` / `Then gc runs unconditionally even with gc.auto=0` (Pin I); `Given auto: true and a
   loose count below gc.auto` / `Then tasksRun omits 'gc'`; `Given auto: true and a count above` /
   `Then it runs`. Three tests.
2. **RED** — the reachability partition: `Given a reachable loose object` / `Then it lands in the
   new pack`; `Given an unreachable loose object newer than the cutoff` / `Then it lands in the
   cruft pack`; `Given an index-only blob and a reflog-only commit` / `Then both survive and are
   packed` (Pin H).
3. **RED** — **mtime provenance, one test per source and one for the `max`**: `Given a loose object
   whose mtime is forced to the past` / `Then the sidecar records exactly that value`;
   `Given an object carried forward from a previous sidecar` / `Then its mtime is byte-identical`;
   **`Given both sources with the loose one newer` / `Then the newer wins`** and its mirror with the
   carried one newer. **A lookup-with-fallback implementation must fail this pair in one ordering.**
4. **RED** — `Given a loose object whose lstat fails` / `Then gc refuses` — the no-`Date.now()`
   guarantee, its own test.
5. **RED** — **the expiry boundary, three separate tests** with an injected clock:
   `mtime = cutoff − 1` destroyed; **`mtime = cutoff` destroyed**; `mtime = cutoff + 1` survives.
   The at-cutoff case is its own test — a two-sided test lets the boundary mutant live.
6. **RED** — `gc.pruneExpire=never` ⇒ everything survives **in a cruft pack** (not loose, not
   deleted); `gc.pruneExpire=now` ⇒ **no cruft pack exists** and every unreachable object is gone.
   Two tests.
7. **RED** — **Pin S's four branches**, each its own test: new garbage ⇒ new sha with old mtimes
   carried **byte-identically**; partial expiry ⇒ new sha with survivors only, old siblings gone;
   total expiry ⇒ cruft pack **and all four siblings** absent; **unchanged set ⇒ the sidecar is
   content-identical under the same file name** (assert **bytes and name**, never inode or mtime).
8. **RED** — `Given an object in the cruft pack made reachable again` / `Then it moves to the normal
   pack and leaves the cruft set` (resurrection).
9. **RED** — deletion ordering: `Given a fault injected after the .idx unlink` / `Then the
   half-retired pack is invisible to createPackRegistry`; `Given a fault injected before the
   .mtimes unlink` / `Then the pack still reads as an ordinary pack`.
10. **RED** — `Given gc runs` / `Then packed-refs, every loose ref file and every reflog are
    byte-identical` (R26) and `Then the index is byte-identical`.
11. **RED** — `Given a pruned fanout prefix` / `Then forgetLooseOidPrefix was called for it` and
    `Then a subsequent probe re-reads the directory` — the invariant repair, asserted.
12. **RED** — `Given an unparseable gc.pruneExpire` / `Then it refuses with typed data and writes
    nothing` — no pack, no sidecar, no deletion.
13. **RED** — `Given the result` / `Then it carries no rendered text` (ADR-249), and one assertion
    per cruft scalar against a fixture whose three outcomes are all non-zero.
14. **GREEN** — the pipeline, step by step, in the order above.
15. **REFACTOR** — rewrite `loose-oid-cache.ts:13–16`, `:59–66` and `pack-refs.ts:8`; add the
    `@writes` tag (`surface: cruftPack`, `format: cruft-mtimes-v1`) for `check:write-surfaces`;
    extend the docs page with the gc task, the three `gc.*` keys, the exact-count note, and an
    explicit warning that `gc` **destroys** aged unreachable objects.
16. **Oracle (R23–R31)** — **new** `test/integration/maintenance-interop.test.ts` with the
    `@proves` block, one shared `beforeAll` repo, **60 s timeout**, `GIT_*` scrubbed, `HOME`
    isolated, signing off. ⚠️ **`interop-helpers.ts`'s `buildSafeEnv` forces `gc.auto=0`,
    `gc.autoDetach=false` and `maintenance.auto=false` on EVERY spawned git** — a row that needs
    the twin repository to actually gc must override those explicitly (`runGitEnv()` + override, or
    `-c`). Rows: cruft creation (git agrees: `cat-file -e` exit 0, `fsck` reports `dangling` at
    exit 0, `count-objects -v` counts them `in-pack`); **`.mtimes` byte format compared against
    git's own sidecar for the same cruft set**; mtime provenance; the expiry boundary vs
    `git gc --prune=@<cutoff>`; `--prune=never` / `--prune=now` equivalences; all four
    existing-cruft branches; resurrection; retention roots (Pin H); no ref mutation (Pin J);
    artefact siblings (the normal pack carries `.idx`+`.rev` and **no** `.mtimes`; the cruft pack
    carries `.idx`, `.rev` **and** `.mtimes`; neither carries `.bitmap`); **SHA-256 cruft** (hash id
    `2`, 32-byte trailers, 80-byte file for one entry); the malformed prune-expiry refusal.
    **Construct a fresh Context after every write** — the commit-graph and loose-oid caches have no
    invalidation hook.

### Gate

- Part gate: `npx vitest run test/unit/application/commands/maintenance.test.ts test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/loose-oid-cache.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/maintenance.ts src/application/primitives/enumerate-objects.ts src/application/primitives/internal/loose-oid-cache.ts src/application/commands/pack-refs.ts src/application/commands/internal/fsck/roots.ts`
- Targeted extras: `npx vitest run test/integration/maintenance-interop.test.ts` ·
  `npm run docs:json` + commit `reports/api.json` (the task union and result type widened) ·
  `npm run check:test-pyramid` (⚠️ `integration` has a hard **`warnAbove: 25`** — a large interop
  suite must be balanced by unit tests in the same PR) · `npm run check:spelling` ·
  `npm run check:size`.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(commands): add the gc task with git's cruft-pack lifecycle`

---

## Part 26 — gc consolidates the packs it owns

### Context

Design §P9 → §Consolidation (ADR-732 half) · **ADR-732** (refines ADR-731) · **R24**, **R32**,
**R33**. Widens Part 25's candidate universe from *loose* to *every pack gc owns*. `*.keep` packs
are excluded; **`.promisor` packs are excluded here too, as a temporary conservative posture that
Part 27 replaces with parity** — say so in the commit body so the intermediate state is not mistaken
for the final one.

**Public surface widened here** (`reports/api.json` regenerated **in this part**):
`MaintenanceResult` gains `packsRetired`, `packBytesBefore`, `packBytesAfter`.

**Why those three scalars and not others.** `packsRetired` — `packsAfter − packsBefore` cannot
express it: consolidating 5 packs into 1 and 2 into 1 both read `−1`, and only one just deleted four
files' worth of history. `packBytesBefore` — the **denominator**; Part 1 spent a whole part
establishing that a share without its denominator is unreadable, and a lone "after" or a lone signed
delta reproduces exactly that defect. `packBytesAfter` — the numerator; the caller composes the
ratio, because a ratio field would be a *derived presentation* (ADR-249). Three deliberate
exclusions: **bytes, not object counts** (consolidation leaves the object set unchanged, so every
count is flat while the bytes multiply); **`.pack` bytes only** (`.idx`/`.rev`/`.mtimes` sizes are a
function of object count, which the caller already has); **no ratio, no formatted size**.
**The pair is free**: Pin Y already forces an `lstat` of every pack before it is superseded, and
`FileStat` carries `size` (`ports/file-system.ts:10`) beside `mtimeMs` (:4) on the same result.

**What changes in the pipeline.**

- **Step 1b — classify the pack directory, and `lstat` it once.** One `readdir` of `objects/pack/`
  — **the registry already takes it and already builds the `fileNames` set at
  `pack-registry.ts:559` (block :547–565), consumed at `:280–292` where `hasRevIndex` (:290) and
  `hasBitmap` (:292) are decided** — partitions every `pack-<sha>.idx` **by pure sibling lookup, at
  zero extra I/O**:
  ```text
  kept        fileNames.has(`${name}.keep`)        → untouchable            (Pin V)
  promisor    fileNames.has(`${name}.promisor`)    → excluded for now       (Part 27 promotes it)
  cruft       fileNames.has(`${name}.mtimes`)      → step 2 / step 7
  normal      otherwise                            → CONSOLIDATED
  ```
  **Checked in that order and mutually exclusive**: `.keep` wins over everything, `.promisor` over
  `.mtimes` and over the default. **A pack carrying two markers is not a contradiction to refuse but
  a precedence to apply** — and it is the pair a classifier is most likely to get wrong, so there is
  a test per **pair** as well as per class. **One site, four verdicts, one test file.**
  `lstat` each `.pack` **now, before anything is written**: `mtimeMs` is the only source for an
  object migrating out of a superseded pack (**Pin Y** — after the rename it is wrong, after the
  unlink it is gone), and `size` on the same result is `packBytesBefore`.
- **Step 4 — the universe gains the normal packs' object lists.**
  ```text
  keptOids        = ⋃{ oids of each KEPT pack }                       ← Pin V
  owned           = looseSet ∪ existingCruft.keys ∪ ⋃{ oids of each NORMAL pack }
  toNormalPack    = (reachable ∩ owned) \ keptOids
  cruftCandidates = owned \ (reachable ∪ keptOids)
  mtime(o)        = max( lstat(loose path).mtimeMs  if loose,
                         existingCruft.get(o)       if carried,
                         lstat(containing .pack)    if in a normal pack )   ← Pins Q, Y
  ```
  `keptOids` is subtracted **again** even though kept packs contribute nothing to `owned` — **that
  is not redundancy**: an object can be inside a kept pack **and** loose **and** inside a normal pack
  at once, in which case it entered `owned` by the third route, and the subtraction is what keeps it
  out of the new pack. **Pin V's second probe** is the reason for the cruft-side subtraction: git
  writes **no** cruft pack at all for an unreachable object living in a kept pack.
  **This is what turns the design's old divergence row into a parity row**: an object packed while
  reachable and since made unreachable now lands in `cruftCandidates` and migrates, carrying **its
  source pack's** `lstat` mtime.
- **Step 6 — no short-circuit.** `toNormalPack` now contains previously-packed objects, so this
  step reads them **out of the packs about to be superseded** and re-emits each as a base entry.
  ⚠️ **There is no "already consolidated ⇒ skip" branch**: Pin W shows git rewrites the pack even
  with exactly one pack and nothing loose, **on every run**, and a short-circuit would diverge
  *visibly* — a skipped rewrite leaves the pack's `st_mtime` stale, and Pin Y makes that mtime the
  expiry clock for every object in it that later becomes unreachable, so skipping **silently ages
  objects git would have kept young**. tsgit's rewrite settles rather than drifting: `buildPack` is
  deterministic, so a repeat gc on an unchanged object set reproduces the same `<sha>`.
  The **only** genuine no-op is the **empty-input** one (Pin V).
- **Step 10b — retire every superseded normal pack.** `pack-<oldSha>.{idx,rev,bitmap,pack}`,
  **`.idx` first**, tolerating any absent sibling. Pin X observed git deleting
  `pack-d0142cdc….bitmap` **with** its pack, so a superseded pack's bitmap goes with it rather than
  being orphaned — **tsgit must delete an artefact it has no writer for**. An orphan `.bitmap` is
  tolerated by git (`fsck` silent, `rev-list` exit 0) but leaving one is litter, not a divergence
  tsgit gets to take. **Kept packs are not in this set and never can be** — the step-1b
  classification is the single gate, so there is one place to get it right and one place to test it.
  **Await `settleRefresh()` (Part 24) first** — steps 6 and 8 hold persistent `FileHandle`s on
  exactly these packs.
- **midx deletion.** `objects/pack/multi-pack-index` (`path-layout.ts:106`) is **deleted whenever it
  names any retired pack** (Pin T; Pin G row 1) — which, since consolidation retires every normal
  pack, is now the **ordinary** case. Deletion is the only available verb (tsgit has no midx writer
  and none is in scope), and it is what git does. **A midx naming only surviving *kept* packs is
  left alone** (Pin G row 2) — now the rare branch, so it gets its **own test** rather than being
  assumed unreachable.
- **`gc.cruftPacks=false` becomes a DIFFERENT pipeline, not a smaller one** (Pin AA). With
  unreachable objects living inside a pack gc is about to supersede, git **writes them back out as
  loose files** (in-pack 6 → 3, loose 0 → 3): they cannot stay where they are, because their pack is
  being deleted. So the flag **routes the surviving unreachable set to *loose* instead of to a cruft
  pack**; **step 5 still runs** in both modes and only the destination of `survivors` moves.
  ⚠️ **An implementation that merely SKIPS the cruft steps deletes those objects along with their
  pack — data loss dressed as a config flag, and the single most dangerous way to get this branch
  wrong.** It passes every other test in the suite and fails only this one.
- **Crash recovery that needs explicit code.** Of Pin X's states, one is not just an argument:
  a crash **after step 7 but before step 10** leaves **two** cruft packs, both valid, objects
  duplicated. **Step 2 must tolerate finding more than one `.mtimes`** — treat the union as
  `existingCruft` and retire all but the one it writes.

**ADR housekeeping owed by this part.** `docs/adr/731-gc-uses-cruft-packs.md` reads
`- **Status:** accepted` with no forward pointer; add `· **Refined by:** ADR-732`. Consider widening
`docs/adr/724-*.md`'s existing superseded note (it names only 731) to also name 732 — its
"pack loose objects … prune the packed loose objects" bullet is what consolidation rewrites.

### TDD steps

1. **RED** — `test/unit/application/commands/maintenance-classify.test.ts` (new): **one test per
   class** (kept / promisor / cruft / normal) **and one per confusable pair** — a cruft pack is not
   a normal pack; a pack carrying both `.keep` and `.mtimes` (**`.keep` wins**); a pack carrying both
   `.keep` and `.promisor` (**`.keep` wins**). Six tests minimum.
2. **RED** — `Given a reachable object living only in a kept pack` / `Then its oid does NOT appear
   in the new pack` — asserted by **absence**, never by a count.
3. **RED** — `Given an unreachable object inside a kept pack` / `Then no cruft pack is written for
   it` (Pin V's second probe).
4. **RED** — `Given a repository whose only pack is .keep-marked and nothing loose` /
   `Then gc writes nothing` — the empty-input branch, **its own test**, distinct from…
5. **RED** — …`Given exactly one normal pack and nothing loose` / `Then gc rewrites it`, and
   `Given a second gc on the unchanged object set` / `Then the same <sha> is produced` (Pin W).
   **The guard that collapses tests 4 and 5 is exactly the mutant this pair kills.**
6. **RED** — **the three-source mtime `max`**, with all three present and **each one newest in
   turn** — three tests. A two-source implementation must fail one of them.
7. **RED** — `Given an object packed while reachable, then made unreachable` / `Then it migrates to
   the cruft pack carrying its source pack's mtime` — force the source `.pack`'s mtime into the past
   and assert the sidecar records **that** value. **This is the assertion that catches an
   implementation stat-ing after the rename.**
8. **RED** — `Given a fault injected after the .idx unlink` / `Then the half-retired pack is
   invisible to createPackRegistry` and `Then git counts it as garbage, not as a pack`.
9. **RED** — `Given a superseded pack with a .bitmap` / `Then the bitmap is deleted with it and no
   orphan is left`.
10. **RED** — `Given a midx naming a retired pack` / `Then it is deleted`; `Given a midx naming only
    kept packs` / `Then it is untouched and still readable` — two tests.
11. **RED** — `Given gc.cruftPacks=false and unreachable objects inside a superseded pack` /
    `Then they are written back out as LOOSE files and survive`, and its sibling
    `Then aged ones are destroyed with the pack`. **Its own test — a skip-the-cruft-steps
    implementation passes everything else and destroys data here.**
12. **RED** — `Given a crash state with two cruft packs` / `Then the next gc treats the union as
    existingCruft and retires all but the one it writes`.
13. **RED** — `Then packsRetired counts every superseded pack`; `Then packBytesBefore and
    packBytesAfter sum every .pack`; `Then packBytesAfter > packBytesBefore on a deltified fixture
    while the object set is unchanged` — the size trade, asserted **directionally, never as a
    threshold**.
14. **RED** — `Given retirement` / `Then settleRefresh is awaited before the first unlink`.
15. **GREEN** — step 1b, the widened step 4, step 10b, midx deletion, the `cruftPacks=false`
    loosening branch, the two-cruft-pack recovery.
16. **REFACTOR** — one classification site; the ADR-731 status bullet; the docs page gains the
    consolidation section, the object-placement table and the **measured** size trade
    (**×1.29 … ×6.91**, **×3.17 on real history** — quote ×3.17 as the planning number), the
    `packBytesBefore`/`packBytesAfter` pair, and **`*.keep` as the caller's escape hatch**.
17. **Oracle** — interop rows added to `maintenance-interop.test.ts`: **consolidation placement**
    (three normal packs + loose ⇒ exactly one new pack holding every reachable object, the three
    predecessors and all their siblings gone, and the object→file-class partition equal to
    `git gc`'s on a **twin** repository); **packed-then-unreachable migrates** with its source
    pack's mtime; **`*.keep` survives** (bytes **and inode** unchanged, `.keep` still present, zero
    of its objects in the new pack, an unreachable object inside it **not** crufted); the
    **`*.keep` empty-input boundary** (directory listing byte-identical before and after); the
    **single-pack no-op boundary** (against git the assertion is on *behaviour* — that a pack was
    written — not on sha equality, since tsgit's bytes are base-only and git's are deltified);
    the **cruft no-op compared on bytes and file name, never inode**; deletion ordering under
    injected faults; **`.bitmap` follows its pack**; **`gc.cruftPacks=false` loosening**; the
    directional size-trade row; `.rev`-sibling + midx deletion — **the row that proves ADR-724's two
    carried backlog constraints are discharged for real**.

### Gate

- Part gate: `npx vitest run test/unit/application/commands/maintenance.test.ts test/unit/application/commands/maintenance-classify.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/maintenance.ts src/application/primitives/pack-registry.ts`
- Targeted extras: `npx vitest run test/integration/maintenance-interop.test.ts test/integration/midx-interop.test.ts test/integration/packfile-interop.test.ts` ·
  `npm run docs:json` + commit `reports/api.json` · `npm run check:spelling` ·
  `npm run check:size` · `npm run check:test-pyramid`.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(commands): consolidate existing packs during gc and retire their siblings`

---

## Part 27 — gc repacks promisor objects in their own class

### Context

Design §P9 → the ADR-733 rows throughout · **ADR-733** (refines ADR-732) · **R32**. The final part:
it promotes `.promisor` packs from Part 26's temporary exclusion to a **second consolidation class**,
adds the maintenance bench, and closes the documentation.

**The one rule no branch may ever break:** promisor and non-promisor objects are **never merged
into one pack**. Pin Z shows git produces **two** packs and carries the `.promisor` marker onto the
new one; merging would tell a later `git` that objects it must lazily fetch are **already present
locally** — a partial-clone **correctness break**, not a size trade.

**Public surface widened here** (`reports/api.json` regenerated **in this part**):
`MaintenanceResult` gains `promisorPackId: ObjectId | undefined`.

**Why exactly this field and no promisor object count.** `promisorPackId` is **exact symmetry with
`packId` and `cruftPackId`**: gc now writes at most one pack per class it owns, and each class's id
answers the same two questions — *does one exist afterwards*, and *which one*. Neither `packsAfter`
nor `packsRetired` can answer either; they are totals across classes. A **count** would carry no
information the id plus the existing pack scalars do not, because **the promisor class has no
lifecycle branches at all** — its objects are consolidated wholesale, never expired, never crufted —
whereas the three `cruftObjects*` counts exist precisely because the cruft lifecycle has three
distinguishable outcomes. **The three pack ids are now a set and must read as one**: an ordinary
repository reports `packId` set and the other two `undefined`; a partial clone with no garbage
reports two set and `cruftPackId` `undefined`; a repository whose only pack is `.keep`-marked
reports **all three `undefined`, and that is not an error**. `packId` keeps its name (renaming a
field the ADR-724 sketch endorsed would be churn) but **the docs page calls it *the normal pack***,
not *the pack*.

**What changes in the pipeline — four touch points, no more.**

- **Step 1b** — `promisor` stops being an exclusion and becomes a **consolidation class**. The
  classifier is unchanged in shape; only its verdict's meaning moves. ⚠️ **`.promisor` is not an
  exclusion at all but a second consolidation class — a materially different thing that should not
  be filed next to `.keep` in a reader's head.** `*.keep` remains the **only** total exclusion.
- **Step 4** — a second, **disjoint** output partition:
  ```text
  ownedPromisor   = ⋃{ oids of each PROMISOR pack }
  owned           = looseSet ∪ existingCruft.keys ∪ ⋃{ oids of each NORMAL pack }
  toPromisorPack  = ownedPromisor                 ← whole; reachability irrelevant
  toNormalPack    = (reachable ∩ owned) \ (ownedPromisor ∪ keptOids)
  cruftCandidates = owned \ (reachable ∪ ownedPromisor ∪ keptOids)
  ```
  A given oid lands in **exactly one** of the three — **that three-way disjointness is the property
  the suites assert directly**, and it is what makes step 8's verify a partition of the repository
  rather than a re-read of parts of it twice.
  ⚠️ **`toPromisorPack` is deliberately NOT intersected with `reachable`.** An unreachable promisor
  object cannot go to the cruft pack, because a cruft pack **has no `.promisor` marker**: moving it
  there announces that a lazily-fetchable object is fully present locally — the same lie as merging.
  Carrying it forward is the only direction that cannot lose anything, and it makes the promisor
  class the one class with **no expiry**: `cruftObjectsExpired` never counts a promisor object.
  The subtraction also decides the **overlap** case — an oid both loose (or in a normal pack) *and*
  inside a promisor pack: **the promisor class wins**, the object is not duplicated into the new
  normal pack (Pin V's rule for kept packs, applied to the other non-normal class), and its loose
  copy is still unlinked at step 9 because it lives in a surviving pack.
  ⚠️ **Implementer-owed empirical pin.** Pin Z's probe had **only reachable** promisor objects, so it
  pins the rebuild but **not** the reachability filter. Run it: Pin Z's setup with the promisor
  pack's objects made **unreachable** before `git gc`, asserting whether they land in the new
  promisor pack, the cruft pack, or nowhere. **§P9 takes the *retain* direction meanwhile — the
  recoverable way to be wrong, since the alternative destroys data — and a correction is one
  subtraction at step 4, not a redesign.** Record the matrix in the design doc.
- **Step 6b — build the promisor pack.** Step 6 again, one class over:
  `buildPack(ctx, { oids: toPromisorPack })` → `writePackArtifacts(ctx, { packDir, …, promisor:
  true })` into the same `objects/pack/`. **The `promisor` flag already exists on the writer**
  (`write-pack-artifacts.ts:141–163`) and already emits `pack-<sha>.promisor` **between** the `.idx`
  and the `.rev` (`writeEmptySentinel` :118–119, called :154) — **this step supplies no new artefact
  code, it supplies a second call**. The `.rev` gate applies identically, which is why Pin Z's git
  output shows `{idx,pack,promisor,rev}`. **Skipped entirely when `toPromisorPack` is empty** —
  every repository that is not a partial clone. **The two empty-input guards must be independent**:
  a partial clone whose non-promisor half is entirely `.keep`-marked writes a promisor pack and **no**
  normal pack.
  One inherited window, named rather than discovered later: `writePackArtifacts` creates `.pack`,
  then `.idx`, then `.promisor`, so **between the second and third writes the pack is findable and
  reads as an ordinary pack**. That is not new — `clone` and `fetch` already do it — and **gc
  neither widens it nor is entitled to fix it here**; a reordering would change a writer three
  commands share.
- **Step 10c — retire every superseded promisor pack.** `pack-<oldSha>.{idx,rev,promisor,pack}`
  under the same two ordering rules: **`.idx` first** (one unlink retires the pack from both
  readers) and **`.promisor` LAST**. The reason is the `.mtimes` rule reached from the other
  direction: **a pack findable *without* its marker reads as an ordinary normal pack, and a later gc
  would merge its objects into the normal pack — the one outcome Pin Z forbids.** So the marker must
  outlive the `.idx` that makes the pack findable at all. Skipped entirely when step 6b was skipped.
  A `.bitmap` present here is tolerated and deleted on the same "an orphan is litter" grounds.
  **midx**: a midx naming a **promisor** pack must now be deleted too — ADR-733 shrank the survivor
  set to `.keep` alone.

**The bench (design §Oracles) — `test/bench/maintenance.bench.ts`, four scenarios, absolute
wall-clock only, through Part 2's driver:**
1. commit-graph write over `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH`'s commit count;
2. `gc` over a fixture seeded with a few thousand **reachable** loose objects;
3. **repeat** `gc` over a few thousand **unreachable** loose objects **plus an existing cruft pack**
   — it must measure a **repeat** run; a first-run number flatters the design by skipping the
   carry-forward entirely;
4. **repeat** `gc` over `DELTA_CHAIN_FIXTURE` (43-deep chains) — the most expensive thing
   `maintenance` can do.

**Scenarios 3 and 4 are cost ceilings, not wins**, and 4 is the headline. Pin W makes it a
**recurring** ceiling: there is no skip branch, so a repeat `gc` on an unchanged repository pays a
**full repack every time**. Scenario 4 reports **two** budgets side by side — wall-clock ms **and**
`packBytesAfter / packBytesBefore` (measured **×6.91** on this fixture). **Report both as budgets;
neither is a CI gate** (R33) — a threshold on a number that moves 5× with the corpus is a flake
generator. Revert only on a result that makes `gc` **unusable**, never on a delta against a baseline
that does not exist.

**The transitive oracle, and the reason this whole part pays for itself:** after a `commit-graph`
run on a tsgit-created repo, `test/bench/log.bench.ts` must show the commit-graph fast path
engaging — Part 6's prefetcher **stops being dead code**. ⚠️ **Measure it; do not assert it in
prose**, and remember `read-commit-graph.ts` has no invalidation hook, so the measurement needs a
**fresh Context** after the write.

**ADR housekeeping owed by this part.** `docs/adr/732-gc-consolidates-existing-packs.md` reads
`- **Status:** accepted`; add `· **Refined by:** ADR-733`. **And widen
`docs/adr/724-maintenance-command-with-commit-graph-and-gc-lite.md`'s existing note** — it
currently reads `superseded by ADR-731 (prune semantics; the command and commit-graph task
stand)` and names only 731, while 732 and 733 further rewrite its *"pack loose objects … prune the
packed loose objects"* bullet. Name all three. The convention is **prose only** — a header bullet
and/or a leading blockquote; there is no `refines:` front-matter key and no tooling reads ADR
front-matter, so this is checklist-enforced, not gate-enforced.

### TDD steps

1. **RED** — `Given the step-4 partition` / `Then no oid appears in two of toNormalPack /
   toPromisorPack / cruftCandidates` — over an **overlap fixture** where the same oid is loose
   **and** inside a promisor pack. **The promisor class must win and the normal pack must not carry
   it.**
2. **RED** — `Given an UNREACHABLE promisor object` / `Then it lands in toPromisorPack and not in
   cruftCandidates`, and `Then it survives a cutoff that would destroy any other unreachable
   object`. **These are the tests a `reachable ∩ ownedPromisor` implementation fails.**
3. **RED** — `Given a repository with no promisor packs` / `Then no .promisor file is written
   anywhere` — step 6b's empty-input branch, **its own test, independent of step 6's**. One guard
   serving both is exactly the mutant this pair kills.
4. **RED** — `Given a partial clone whose non-promisor half is entirely .keep-marked` /
   `Then a promisor pack is written and no normal pack is` — the independence, positively.
5. **RED** — `Then writePackArtifacts is called with promisor: false at step 6 and promisor: true
   at step 6b` — asserted on the **captured argument**, not on the resulting file list (a
   conditional-spread/flag mutant is invisible to a file listing).
6. **RED** — `Given a fault injected mid-step-10c after the .idx unlink` / `Then the half-retired
   pack is invisible to createPackRegistry` **and** `Then its .promisor is still present` — the
   assertion that catches a marker-first unlink.
7. **RED** — `Given a pack carrying both .keep and .promisor` / `Then .keep wins and the pack is
   untouched`, plus its twin `Given a .keep-marked pack in a partial clone` / `Then the other
   promisor packs are still consolidated`.
8. **RED** — `Then promisorPackId is undefined on an ordinary repository` and
   `Then it equals the new pack's sha on a partial-clone-shaped one` — two tests.
9. **RED** — `Then packsRetired spans all three retirable classes` and `Then a partial clone's
   steady state is "N packs became 2"` — **a test asserting a hard-coded `packsAfter === 1` would
   be asserting the absence of a partial clone.**
10. **RED** — `Given a midx naming a promisor pack` / `Then it is deleted`.
11. **GREEN** — the step-1b verdict promotion, step 6b, step 10c, `promisorPackId`.
12. **REFACTOR** — the ADR-732 status bullet; the docs page's placement table becomes **all
    parity** with the promisor rows, the four file classes are named with what gc does to each, and
    `packId` is described as *the normal pack*.
13. **Oracle** — interop rows added to `maintenance-interop.test.ts`: **`.promisor` pack rebuilt,
    not merged** (a partial-clone-shaped repo ⇒ **exactly two** new packs, the second carrying a
    `pack-<sha>.promisor`; every promisor oid in the promisor pack and **no promisor oid in the
    normal pack** — ⚠️ **asserted by oid membership, never by pack count**, since a count passes an
    implementation that writes two packs with the wrong objects in them; the old promisor pack and
    all its siblings gone; the object→file-class partition equal to `git gc`'s on a **twin**);
    **`.promisor` retirement ordering** under an injected fault; **`.keep`-over-`.promisor`
    precedence**; **no promisor pack ⇒ no promisor output**. Plus the four bench scenarios and the
    transitive `log.bench.ts` measurement.

### Gate

- Part gate: `npx vitest run test/unit/application/commands/maintenance.test.ts test/unit/application/commands/maintenance-classify.test.ts test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/maintenance.ts test/bench/maintenance.bench.ts`
- Targeted extras: `npx vitest run test/integration/maintenance-interop.test.ts` ·
  `npm run docs:json` + commit `reports/api.json` · `npm run check:spelling` ·
  `npm run check:size` · `npm run check:test-pyramid` · the unreachable-promisor probe, matrix
  recorded in the design doc · the four bench scenarios plus the `log.bench.ts` transitive
  measurement (background + poll).
- **Phase-boundary gate after this part:** `npm run validate`, then `npm run docs:json` fresh and
  `npm run check:spelling` fresh before any push — a wireit-**cached** green `validate` can precede
  a **red** prepush.
- Poll, don't wait: never end your turn waiting on a background notification — re-run the gate
  command yourself.

### Commit

`feat(commands): repack promisor objects into their own pack during gc`

---

## Gate map — which parts need more than the part gate

The **part gate** is always
`npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`.
`npm run validate` is the **phase-boundary** gate, not a per-part one. This table is the
at-a-glance answer to "can I commit on the part gate alone?"

| Part | Part gate only? | Targeted extras, and why |
|---|---|---|
| 1 | ✗ | `check:spelling` (new frame names in `baseline.md`); a completed `npm run profile` is the oracle |
| 2 | ✗ | one `bench-ab` no-op run (the R10 oracle) |
| **3** | ✗ **(most gates of any part)** | `check:architecture` (new domain + ports files, type-only imports count as edges) · `check:tarball` (`node:os` must stay off `index.default.js`) · `check:size` · `docs:json` + `reports/api.json` · 100 % coverage on the new domain/ports/adapter files |
| 4 | ✗ | `check:test-pyramid` (allowlist) · `docs:json` + `api.json` (`JoinOptions` shrank) · `check:architecture` |
| 5 | ✗ | the three config interop suites — **refusal ordering** moves under this refactor |
| 6 | ✗ | `log-interop`, `commit-graph-walk-interop` |
| **7** | ✓ | pure cost changes with identical verdicts; if an item cannot get a verdict-equality test, **drop the item** |
| 8 | ✗ | six pack/fsck interop suites — corrupt-pack **refusals** are in the blast radius |
| 9 | ✗ | `packfile-interop`, `large-object-pack-interop` |
| 10 | ✗ | `blame-interop`, `tree-interop`, `tree-depth-interop` — a refusal is re-implemented |
| 11 | ✗ | `blame-interop` (the byte-for-byte porcelain matrix) |
| 12 | ✗ | four interop suites incl. **two new Pin-A rows** · `check:spelling` (two doc pages) |
| 13 | ✗ | `commit-interop`, `commit-message-interop` · `test:coverage` (domain is a 100 % gate) |
| **14** | ✓ | the memo is invisible on every public surface — if it becomes visible, that is a bug |
| 15 | ✗ | `check:test-pyramid` (allowlist entry removed) · `docs:json` + `api.json` (**a public walk option is removed**) · status/add interop |
| **16** | ✓ | Context-scoped cache, no public surface |
| 17 | ✗ | `check:test-pyramid` (a new bench file shifts tier counts) · checkout interop |
| 18 | ✗ | the **network** interop suites (real `git-http-backend`, run detached and poll) · the **ADR-728 handled-failure probe** · a `bench-memory` run at two pack sizes |
| 19 | ✗ | `check:tarball` · `check:size` · the **Playwright** browser spec |
| 20 | ✗ | `check:architecture` · `docs:json` (verify `ctx.session` did **not** surface) · worktree interop |
| 21 | ✗ | `git-parity-containment-interop` (1 416 lines) · `ownership-trust-gate-interop` · `check:architecture` · `check:spelling` |
| 22 | ✗ | the **new** `commit-graph-write-interop` suite · `test:coverage` · `check:architecture` · the **GDO2 probe** |
| **23** | ✗ **(the whole Tier-1 checklist)** | `check:doc-coverage` · `check:browser-surface` · `check:size` · `check:test-pyramid` · `check:spelling` · `docs:json` + `api.json` · `test:parity` |
| 24 | ✗ | `test:coverage` (new domain module) · `check:architecture` |
| 25 | ✗ | the **new** `maintenance-interop` suite · `docs:json` + `api.json` · `check:test-pyramid` (⚠️ `integration` has a hard `warnAbove: 25`) · `check:spelling` · `check:size` |
| 26 | ✗ | `maintenance-interop` + `midx-interop` + `packfile-interop` · `docs:json` + `api.json` · `check:spelling` · `check:size` · `check:test-pyramid` |
| 27 | ✗ | `maintenance-interop` · `docs:json` + `api.json` · `check:spelling` · `check:size` · `check:test-pyramid` · the **unreachable-promisor probe** · four bench scenarios + the transitive `log.bench.ts` measurement · then the **phase gate** `npm run validate` |

**Three parts (7, 14, 16) are safe on the part gate alone.** Every other part either moves a
refusal, an on-disk byte, a public symbol, a size budget or a tier count.

## Implementer-owed empirical pins — assignment

Four pins are owed by implementers, not by the design. Each **blocks a parity claim** until it is
run, and each records its matrix back into `docs/design/perf-remediation-2026-08.md`. All of them
run in a `mktemp -d` throwaway with an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
scrubbed and signing **off** — **never** in this worktree.

| Pin | Part | Probe |
|---|---|---|
| **Handled-failure clone quarantine** (ADR-728) | **18** | Start a `git clone`, kill **`git-upload-pack` (the server side, not the client)** mid-stream, observe whether `objects/pack/tmp_pack_*` survives on the client. Align tsgit to whatever it shows. The unlink is a **tidiness** argument until then |
| **`GDO2` under corrected-date overflow** (ADR-724 / P9 task 1) | **22** | Build a repo with a corrected-date offset past 2³¹ using **`GIT_COMMITTER_DATE=@<epoch>`** (the ISO form is rejected by git's parser), run `git commit-graph write --reachable`, record whether a `GDO2` chunk appears and what `numChunks` becomes. If git emits it: parse it (a reader change) or keep the refusal **with an ADR line** — never silently emit a chunk tsgit cannot read |
| **Windows handle drain before unlink** (§0.1) | **24** | On the `windows-latest` CI job, whether Node's `unlink` refuses a `.pack` with a live `FileHandle`. **Draining first is correct on every platform regardless** — on POSIX an unlinked-but-open pack keeps its bytes allocated until the fd closes, so `packBytesAfter` would report space the filesystem has not reclaimed |
| **Unreachable object inside a `.promisor` pack** (ADR-733) | **27** | Pin Z's setup with the promisor pack's objects made **unreachable** before `git gc`; assert whether they land in the new promisor pack, the cruft pack, or nowhere. §P9 takes the **retain** direction meanwhile — the recoverable way to be wrong — and a correction is one subtraction at step 4 |

## Mutation obligations — assignment

Every `// Stryker disable … equivalent` proof this change moves must be **re-proved against the new
structure or removed**. A proof carried forward across a structural change is falsified by
construction, and Stryker anchors on the **expression** line, so a moved line silently orphans it.

| Proof | Part | Note |
|---|---|---|
| `internal/pack-offset-table.ts:130` | 8 | Written **specifically about `bisectLeft` over a `Float64Array`** — replacing the structure falsifies it |
| `domain/storage/pack-index.ts:167`, `:238` | 8 | Only if `searchIndexPosition` / `readOffset` move |
| `internal/bounded-map.ts` (`ArrayDeclaration`) | 4 | The line is rewritten by the consolidation |
| `node-file-system.ts:112`, `:120` (`mapConcurrent`) | 4 | Both sit on rewritten lines |
| `commands/range-diff.ts:99` | 4 | Its bound is re-pointed |
| `domain/commit/binary-heap.ts:54` | 6 | Only if the part rewrites that line |
| `node-file-system.ts:978` (`resolveRead`'s `..` prefilter) | 7, 21 | Part 7 gives `resolveWrite` the same prefilter; Part 21 restructures the read predicate |
| `internal/fsck/object-cache.ts:359` | 12 | Its justification **cites the old default** — falsified by the flip |
| `commands/fetch.ts:278` | 12 | Under the flipped default the `ObjectLiteral` `{}` mutant becomes equivalent and will survive un-suppressed. Drop the now-redundant explicit `false` **or** widen the proof — decide and state which |
| `repository/wrap-fs-validator.ts:12`, `:24` | 21 | ⚠️ there are **exactly two**, not three |
| `node-compressor.ts:38`, `:47`, `:205` | 19 | Only if the size gate moves those lines |
| `fetch-pack.ts:220` | 18 | The tail-tick proof sits inside the rewritten drain |
| `internal/symlinked-leading-path.ts:70`, `:85` | 17 | Only if single-flighting moves those lines |
| `object-resolver.ts:156`, `:169`, `:176`, `:447`, `:452` | 6, 9, 12, 14 | Re-prove in whichever part rewrites the line — the file is touched by four parts |

**Never** add a new suppression to make a mutant go away. `mutation-budgets.json`: `domain`
break 99 / low 100 · `application` break 95 / low 98 · `adapters` break 85 / low 90 · `infra`
(`ports`, `operators`, `transport`, `progress.ts`) break 90 / low 95. A new port file lands in
**`infra`**; a new domain module in **`domain`**.
