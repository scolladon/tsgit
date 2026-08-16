# Vitest pool / prepush worker-cap pilot — measurement record (W8)

Records the probe and the three-variable measurement for the harness pilot, per the revert
rule (R12): a variable ships only if its median wall-clock win over three or more alternating
rounds exceeds the round-to-round spread, with zero pass/fail verdict changes and zero new
flakes. All three variables were measured; **all three were reverted**. That is a complete,
successful outcome for this pilot, not a partial one.

## Environment

- `darwin-arm64 / node v22.22.3 / Apple M3 Pro / 11 logical cores`
- `git version 2.55.0`, `npm 12.0.1`, `macOS 26.5.2`

Every number below is local, dev-machine — not a published perf claim.

## Step 0 — the env-sharing probe (mandatory prerequisite)

Whether a vitest worker thread sees its own `process.env` or a live view of the parent's
decides whether `pool: 'threads'` is even safe to trial, given `vitest.config.ts`'s `env`
block and the two `process.env`-writing unit files. This was settled empirically, not from
memory, before any config edit.

**Node-level probe** (throwaway script, `worker_threads` directly): a parent process sets
`PROBE_VAR=set-by-parent`, spawns a worker that reads it, overwrites it to
`set-by-worker`, and reports back. Result:

```
worker1 saw before=set-by-parent after=set-by-worker (mutation happened inside the worker)
parent process.env.PROBE_VAR AFTER worker1 mutated it: set-by-parent   ← unchanged
worker2 (fresh worker) saw before=set-by-parent                        ← did not inherit worker1's mutation
```

Each worker thread receives an independent copy of `process.env` at spawn time; mutations
inside one worker are invisible to the parent and to sibling workers. This matches Node's
documented default (`worker.SHARE_ENV` is required to opt into a live, shared view — nothing
in vitest's thread pool passes it).

**Vitest-level probe**: the two `process.env`-writing unit files plus the five
`vi.stubEnv`/`vi.stubGlobal`/`vi.setSystemTime` files, run together under
`--pool=threads`:

```
npx vitest run --project unit --pool=threads \
  test/unit/adapters/node/node-env-reader.test.ts \
  test/unit/adapters/node/node-file-system.test.ts \
  test/unit/adapter-detect.test.ts \
  test/unit/application/primitives/deprecation.test.ts \
  test/unit/application/primitives/reflog-identity.test.ts \
  test/unit/repository/default-cwd.test.ts \
  test/unit/repository/repository.test.ts
```

Result: **7 files passed, 284 tests passed, 1 skipped.** The threads pool was safe to trial.

## Measurement hygiene

Wireit's freshness check (`Fingerprint.equal` against the single fingerprint file recorded by
the previous run) and, separately, its local cache-hit lookup, both short-circuit a script
whose current inputs match a state wireit has already seen — a second identical invocation
returned in 0.1–0.3 s instead of re-running. Every timed round below therefore combines:

- `WIREIT_CACHE=none` on the invocation (disables cache-hit restoration), and
- clearing the task's own `.wireit/<task>/fingerprint` file immediately before the round
  (variables 1–2: the `test:unit` task) or `rm -rf .wireit` before the round (variable 3:
  the full `prepush` graph, so every one of its 25 dependencies is forced cold, not just the
  top-level task).

Verified directly: an unmodified-config round run back-to-back without this clearing was
skipped ("Ran 0 scripts and skipped 2 in 0.1s"); the same round with the fingerprint cleared
ran the full suite (28–31 s). Every number in the tables below is a genuine cold run.

## Variable 1 — `pool: 'threads'` (`isolate: true`, vitest default)

Oracle: `npm run test:unit`, three alternating rounds baseline vs. variant.

| Round | Baseline (forks, committed) | Variant (`pool: 'threads'`) |
|---|---|---|
| 1 | 30.05 s | 29.11 s |
| 2 | 30.68 s | 29.17 s |
| 3 | 31.68 s | 31.07 s |
| **Median** | **30.68 s** | **29.17 s** |
| Spread (max − min) | 1.63 s | 1.96 s |

Every round: 595/595 test files passed, 12963 tests passed, 2 skipped — identical across all
six rounds, no flakes.

Median win: 1.51 s. Both sides' round-to-round spread (1.63 s / 1.96 s) is larger than the
win. **Does not clear R12 — reverted.** `git checkout -- vitest.config.ts` (no edit had been
kept beyond the trial).

## Variable 2 — `isolate: false` on the forks pool

Oracle: `npm run test:unit`, three alternating rounds baseline vs. variant. Measured twice:
the first set ran immediately after variable 1's six rounds and produced one outlier baseline
round (thermal/back-to-back-load artefact, not attributable to the variant); the second set
re-ran after a 20 s cool-down and is the controlled reading the decision is based on.

**Set 1 (uncontrolled — reported for transparency, not used for the decision):**

| Round | Baseline | Variant (`isolate: false`) |
|---|---|---|
| 1 | 53.28 s | 29.79 s |
| 2 | 35.46 s | 30.24 s |
| 3 | 36.17 s | 32.47 s |
| **Median** | **36.17 s** | **30.24 s** |
| Spread | 17.82 s (dominated by the round-1 outlier) | 2.68 s |

**Set 2 (controlled, 20 s idle before the first round):**

| Round | Baseline | Variant (`isolate: false`) |
|---|---|---|
| 1 | 35.04 s | 26.90 s |
| 2 | 30.95 s | 26.21 s |
| 3 | 31.04 s | 26.21 s |
| **Median** | **31.04 s** | **26.21 s** |
| Spread | 4.09 s | 0.69 s |

Every round in both sets: 595/595 files, 12963 tests passed, 2 skipped — identical, no
flakes, across all twelve `test:unit` rounds. On the controlled set, the 4.83 s median win
clearly exceeds both sides' spread — by the unit-suite oracle alone this cleared R12 and the
variant was kept, pending the write-up step.

**Reverted anyway, for a reason the unit-suite oracle could not see.** While measuring
variable 3 (below), a full `npm run prepush` run — with `isolate: false` still applied —
failed three assertions in `test/unit/index-node-root-canonicalisation.test.ts`, part of the
`test:coverage` task running alongside the rest of the `validate` graph:

```
expected 0 to be greater than 0
expected { shim: 1, adapter: +0 } to deeply equal { shim: 1, adapter: 1 }
```

That file's oracle is a `vi.mock('node:fs/promises', …)` call-count spy. `vi.mock` hoisting
and per-file module-registry resets are exactly what `isolate: true` (vitest's default)
guarantees and `isolate: false` gives up — with isolation off, `src/index.node.ts` can resolve
`node:fs/promises` from a module graph a *different* test file already initialised in the
same worker, bypassing this file's freshly wrapped spy and under-counting its calls. This
hazard was not on the design's isolation-audit checklist (which covered `process.cwd`
mutation, `process.env` writes, `vi.stubEnv`/`vi.stubGlobal`/`vi.setSystemTime`, and
module-scope `let` — not module-level `vi.mock` on Node builtins), and the plain
`npm run test:unit` rounds above never happened to hit the ordering that triggers it. Running
the full `validate`/`prepush` graph is exactly the condition this suite runs under for real,
so it counts.

This is a real, reproduced pass → fail transition attributable to the variant. Per R12 —
"changes any test's pass/fail verdict … is reverted immediately regardless of speed" — the
measured win does not save it. **Reverted.** `git checkout -- vitest.config.ts`. Re-running
the same standalone `npm run test:integration` afterwards (`isolate: false` still applied, no
concurrent load) passed cleanly (124/124 files, 1655/1655 tests) — confirming the trigger is
the *combination* of `isolate: false` with a module-registry collision under real concurrent
load, not integration tests being unsafe on their own.

## Variable 3 — `WIREIT_PARALLEL=11` cap on `prepush`

By default, `WIREIT_PARALLEL` is `os.cpus().length * 2` (22 on this host); `validate` declares
22 dependencies, so wireit can start all of them at once, including four vitest tasks each
capable of `maxWorkers: '100%'` (11 workers) — worst case ≈44 vitest workers on 11 cores,
alongside rollup, typedoc, biome, cspell, size-limit and attw. The candidate cap tested here
is `WIREIT_PARALLEL=11`, one wireit task slot per logical core, applied as an env prefix on
the invocation (the mechanism the design points at for `.husky/pre-push`'s hook line).

Oracle: `npm run prepush`, three alternating rounds baseline vs. variant, measured against the
**pristine** `vitest.config.ts` (both reverted variables above left no trace, so this is the
same config `main` carries).

An earlier exploratory attempt at this measurement (discarded, not counted below) surfaced two
unrelated problems that had to be resolved before a clean run was possible: a pre-existing
`check:spelling` gap (`unfetched`, introduced by an earlier commit on this branch,
`3cb7c7fd`, and unrelated to this part — fixed by adding the word to `cspell.json`, folded
into this part's commit since it blocks this part's own gate), and a single, non-reproducing
`has-code-changes.sh` integration-test failure under heavy uncapped load that did not recur in
any of the six official rounds below and is not attributed to any variable here.

| Round | Baseline (default `WIREIT_PARALLEL`) | Variant (`WIREIT_PARALLEL=11`) |
|---|---|---|
| 1 | 127.25 s | 127.74 s |
| 2 | 118.09 s | 118.45 s |
| 3 | 115.79 s | 107.90 s |
| **Median** | **118.09 s** | **118.45 s** |
| Spread | 11.46 s | 19.84 s |

Every round: `npm run prepush` exited 0, "Ran 25 scripts and skipped 0" — full `validate`
graph plus `check:doc-typedoc`, all green, identical across all six rounds, no flakes.

The variant's median is 0.36 s *slower* than baseline — no win at all, let alone one exceeding
either side's spread. Capping wireit's task-launch concurrency does not shorten
`npm run prepush`'s wall clock on this host: the critical path is dominated by the long-pole
tasks (`test:coverage`, `check:exports`, …), and throttling how many *other* tasks may start
alongside them does not shorten that path — it only makes short tasks queue behind the cap
instead of starting immediately. **Does not clear R12 — reverted.** No file was left modified
(`.husky/pre-push` was never edited; the cap was applied as a bare env-var prefix for
measurement only).

## Outcome

| Variable | Median win | Cleared spread? | Verdict changes? | Kept? |
|---|---|---|---|---|
| 1 — `pool: 'threads'` | 1.51 s | No | None | Reverted |
| 2 — `isolate: false` | 4.83 s (controlled set) | Yes | Yes — under real load | Reverted |
| 3 — `WIREIT_PARALLEL=11` cap | −0.36 s | No | None | Reverted |

All three variables are reverted; `vitest.config.ts` and `.husky/pre-push` are byte-identical
to the pre-pilot committed state. This is the honest close for R12: "measured, no win,
reverted" for variables 1 and 3, and "measured, real win, real regression, reverted" for
variable 2 — every one of them a completed measurement, not a skipped one.
