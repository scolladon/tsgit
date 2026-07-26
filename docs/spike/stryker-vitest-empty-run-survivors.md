# Spike — Stryker × vitest-4 non-deterministic verdicts: root cause and verified fix

**Date:** 2026-07-26 · **Backlog:** 27.5 · **Upstream:** stryker-js#6073 (open), repro
[`stryker-pertest-flip-repro`](https://github.com/scolladon/stryker-pertest-flip-repro)

## TL;DR

The vitest-runner **scores a mutant run that executed zero tests as "survived"**.
Under real Stryker load, ~5 % of filtered mutant runs complete with their test
tasks *collected but never executed* (no results ever arrive — proven not
in-flight). Since no test "failed", `toMutantRunResult` reports **survived**:
these are the phantom survivors, and they flip run-to-run because the loss is
timing-dependent. A **retry guard** in `mutantRun` (re-issue the run when a
non-empty filter yields zero executed tests) eliminates the flip completely —
verified 5/5 identical reports on the repro, genuine survivors untouched.

## The mis-verdict mechanism (proven)

`VitestTestRunner.run()` (`@stryker-mutator/vitest-runner` 9.6.1):

1. `mutantRun(options)` → `run({ testIds: options.testFilter, … })` →
   `await this.ctx.start(testFilesToRun)` on a **shared, long-lived** Vitest
   instance (one per Stryker test-runner child process), preceded by the
   `state.filesMap.clear()` hack the code itself labels "kind of a hack".
2. Results are read back from `ctx.state.getFiles()` and filtered by
   `.filter((test) => test.result)` — the comment says "if no result: it was
   skipped because of bail".
3. When the run is lost, the state contains the correct files with tasks
   **mode `run`/`queued` and no `result`** — the bail-filter silently drops all
   of them → `tests: []` → no failure → **survived**, `hitCount 0`.

The runner cannot distinguish "everything was bail-skipped" from "nothing ran".
That conflation is the defect that turns a lost run into a wrong verdict.

## Evidence chain (every claim instrumented, all on vitest 4.1.9/4.1.10 + stryker 9.6.1)

| # | Experiment | Result |
|---|---|---|
| 1 | tsgit named files (correspond/patch-text/range-diff), forks vs threads pools | Reports **byte-identical**; all verdicts verified correct by hand-applied mutants vs the full covering suite (299 tests); the 2 residual survivors are genuine. The 23.6-era "proven false survivor" was a **mutant-identity mixup** (three `ConditionalExpression→true` mutants share one guard line) |
| 2 | `coverageAnalysis` all/off (needs `ignoreStatic:false`) | Identical verdicts — not an attribution bug |
| 3 | Repro flip harness, 4.1.9 and 4.1.10 | **Flips on both** — version drift did not fix it |
| 4 | Repro with `pool: 'threads'` in user config | Still flips — moot anyway: the runner **forces** `pool:'threads', maxThreads/minThreads:1, maxWorkers:1, maxConcurrency:1, bail:1` at `createVitest` |
| 5 | Repro with `vitest.related: false` | Still flips — `related` not involved (tsgit's `related:false` does **not** protect it) |
| 6 | Dry-run coverage meta probe | `files=8 withMeta=8 perTestIds=21` stable every run — coverage collection intact |
| 7 | Per-mutant verdict probe | **Every** unstable verdict is `survived(tests=0, hitCount=0)`; verdicts with ≥1 executed test are stable; survivors decompose exactly as genuine + empty-run artifacts |
| 8 | Empty-run state dump | Correct files dispatched, tasks collected, **all result-less** (`run`/`queued`), correct name pattern, no swallowed `FILES_NOT_FOUND` |
| 9 | Settle-wait prototype (poll state ≤10 s before reading) | **Fails** — all waits hit the deadline: results are never coming; the run is lost, not late |
| 10 | Supported-API prototype (`rerunTestSpecifications` + `setGlobalTestNamePattern`) | **Still loses runs** (14 empty runs) — not an API-misuse-only issue |
| 11 | **Retry-guard prototype** (re-run on empty, ≤3, error on exhaustion) | **Flip eliminated 5/5**; 16 retries absorbed; no exhaustion; genuine survivors stable |
| 12 | Pure-vitest isolation loop (stryker's exact `createVitest` options; ±`filesMap.clear`, ±config mutation, ±bail failures, ±`provide()`/setup-file mimicry; 150 reruns each) | **Zero losses in every variant** — vitest driven identically is clean outside Stryker |
| 13 | Sequence/timeline probes in real Stryker | Empties cluster **immediately after bail-aborted runs** (`killed` with 1 executed test); `ctx.onCancel` **never fires** (bail aborts worker-side); empties also occur on a process's first `start()` |
| 14 | Isolation loop **inside a real Stryker sandbox** — instrumented sources, the real setup file, real mutant activation (a killing mutant bail-aborts every other run), repeated `ctx.start()` per run exactly as the runner does | **0 losses / 100 checked runs** (100/100 bail aborts confirmed) |
| 15 | Contention: 8 of those sandbox-interior loops in parallel | **0 losses / 800 checked runs** — even machine saturation does not reproduce it outside real Stryker orchestration |

## Where the bug lives

- **stryker-js vitest-runner (definite, fix-worthy regardless of vitest):** an
  invalid run — non-empty `testFilter`, zero executed tests — must never be
  scored *survived*. The verified fix: retry the run; if it stays empty, return
  an error result so Stryker reschedules, never a survival. This is robust
  against any underlying loss mechanism.
- **vitest 4 (suspected but NOT demonstrable in isolation):** a run on a live
  instance can complete with tasks collected but unexecuted, silently —
  strongly correlated with a preceding worker-side **bail abort**. However,
  ~1,400 isolation runs reproducing every extractable ingredient — stryker's
  exact options, state clearing, config mutation, bail failures, provides and
  setup file, instrumented sources inside a real sandbox, repeated
  `ctx.start()`, and 8-way contention — show **zero** losses. The trigger
  needs Stryker's actual child-process orchestration, so a vitest issue
  cannot be filed yet (no standalone repro would back it); the defensive
  fix in the stryker runner is the actionable remedy either way.

## Impact on tsgit

- The mutation gate's verdicts on the 27.5-named files are **correct today**;
  the two residual `correspond.ts` survivors are genuine (L118 `j>=0→true` is
  provably equivalent — `computeAssignment` returns a complete assignment so
  `j≥0` always holds; L67 operand survivor needs an equivalence proof or a kill
  test).
- No tsgit config change can prevent phantom survivors (experiments 1–5); the
  documented triage procedure (hand-apply + run the **full covering set**, with
  an external watchdog for loop mutants) remains the local mitigation until the
  upstream fix lands.
- Triage gotchas now codified: three same-line `→true` mutants (whole guard +
  one per operand) — hand-test the *exact* operand; a same-named test file is
  not the covering set (use the report's `coveredBy`/`killedBy`); infinite-loop
  mutants hang vitest synchronously — wrap hand-runs in a watchdog.

## Contribution plan (pending decision)

1. **stryker-js PR** — port the retry guard to
   `packages/vitest-runner/src/vitest-test-runner.ts` + unit test; reference
   #6073 with this evidence chain and the repro's before/after.
2. **#6073 update** — root-cause narrative (this document, condensed) so the
   maintainer sees the mechanism even before the PR.
3. **vitest issue** — only once the sandbox-interior experiment yields a
   vitest-only repro; otherwise the claim isn't actionable for them.

## Addendum (same day) — trigger pinned: bail cancellation racing the result flush

Probes inside vitest's main chunk (`executeTests`, `cancelCurrentRun`, the
worker→main `onCancel` RPC, `state.cancelFiles`) closed the remaining gap.
The lost runs are **not** an external scheduler fault: they are the run's own
`bail: 1` (which the runner always passes to vitest unless `disableBail`).

Sequence, observed in 13/13 empty verdicts: a covering test fails (the mutant
is being killed) → the worker immediately fires `rpc().onCancel("test-failure")`
while the failing result is still in vitest's **throttled task-update batch** →
main handles the cancel first → `pool.cancel()` force-stops the workers before
the batch is applied (the kill evidence is destroyed) → `state.cancelFiles`
registers the files as bare result-less tasks → the run resolves as complete →
the runner scores "survived". **The phantom survivors were mutants being
killed.** Whether the batch beats the force-stop is a main-event-loop timing
race — which is why an idle isolation loop can never lose it (the batch always
lands first) and only a loaded Stryker main process can.

Two more corrections to the sections above:

- "Not config-fixable" holds only for the levers enumerated there.
  **`disableBail: true` removes the trigger entirely** — verified 5/5
  deterministic reports on the repro (cost: all covering tests run per mutant,
  ≈1.5× slower; loop mutants shift Killed→Timeout, both detected). Adopted in
  `stryker.config.mjs` per ADR-508.
- The "zero `ctx.onCancel` events" observation in experiment 13 was a probe
  artifact: vitest **clears `_onCancelListeners` at every run start**, so a
  listener registered once at init logs nothing from the second run on.
  Cancels flow on every bail-kill.
