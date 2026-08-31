# Mutation — tsgit override (Stryker; replaces the mutation Procedure body)

The engine preamble already probed the config and the engine invariants still bind
(run-lock, PR-waits-for-triage, docs-in-parallel, never destroy the worktree mid-run).

## Run

- **Line-range scoping is the default**: derive each file's contiguous changed regions
  from `git diff --no-ext-diff main...HEAD` and pass one `<file>:<start>-<end>` entry
  per region — the same file may appear several times. Widen to the whole file only
  when the diff blankets it (mostly-changed file, or a file-wide mechanical rename
  where ranges add noise). After the refactor phase, **widen to whole-file scope ONLY
  for files the refactor actually restructured** (moved/extracted/renamed within) —
  files it merely line-touched stay line-range scoped. Whole-file scope surfaces
  pre-existing survivors, so the triage step MUST filter them back to the diff's lines;
  never write kill tests for survivors outside the change (the step-5 run swept in 4
  pre-existing `error.ts` survivors exactly this way).

```bash
./node_modules/.bin/stryker run --incremental \
  --mutate "src/a.ts:42-118,src/a.ts:300-340,src/b.ts"   # run in background + write run-lock
```

- ONE `--mutate` flag with a comma list — repeated flags override each other.
- **Always `--incremental`** — `stryker.config.json` wires
  `incrementalFile: reports/stryker-incremental.json` (gitignored, never committed),
  so the post-triage re-run only re-tests affected mutants. Inconsistent-looking
  results (stale kills, impossible survivors) → rebuild with `--force`.
- Never the full tree (intractable locally; the dry run also flakes on the
  compileGlob perf test).
- **Concurrency safety:** start the run only AFTER Stryker's sandbox copy completes;
  never run `npm install` in the worktree while the run executes.

## Triage (feeds forge:mutation-triager)

- Filter survivors/no-coverage to the diff's lines only — pre-existing-line survivors
  are out of scope.
- **vitest-4 phantom-survivor caveat** (stryker-js#6073, root-caused in
  docs/spike/stryker-vitest-empty-run-survivors.md): with `bail` enabled the
  runner occasionally scores a mutant run that executed ZERO of its filtered
  tests as "survived" (hitCount 0) — bail's cancellation destroys the kill
  evidence. `stryker.config.mjs` sets `disableBail: true` to remove that race.
  **`disableBail` does NOT eliminate phantoms — measured.** One triage of 36
  in-scope survivors found **6 phantoms**: three static-mutant mis-scores, and
  three `LogicalOperator` survivors that failed 1 of 42 tests the moment the
  exact replacement was applied. Treat every survivor as possibly phantom; the
  hand-verify step below is load-bearing, not a formality. Before
  writing any kill test, hand-verify — with three traps to avoid:
  1. **Apply the mutant's EXACT replacement** from the report (`replacement`
     field), not a paraphrase: a guard line carries several `→ true` mutants
     (whole condition + one per operand) and they have different verdicts.
  2. **Run the full covering set**, not the same-named test file: resolve the
     report's `coveredBy`/`killedBy` ids — killers often live in sibling files
     (e.g. `*.characterization.test.ts`).
  3. **Wrap the run in an external watchdog** (kill vitest after ~75 s): a
     loop mutant hangs vitest synchronously; test timeouts cannot fire.
  A FAILING (or watchdog-killed) run proves the mutant is killed — record it as
  a phantom survivor, no test needed. Only a genuinely passing full-covering-set
  run makes the survivor real. For deeper checks, the sandbox honours
  `__STRYKER_ACTIVE_MUTANT__`.
- Equivalent mutants: inline `// Stryker disable next-line <mutators>: equivalent — <why>`
  with one line of proof — no central catalogue. This suppresses the proven-equivalent
  mutant (it leaves the score denominator) and is the hook-permitted form (a bare
  Stryker-disable without an `equivalent` rationale stays blocked). Typical provable cases:
  loop bounds where out-of-bounds reads return `undefined` with identical outcome; search
  start offsets in homogeneous data.
- Kill-test patterns: assert error DATA (code/reason/value) not just the class —
  StringLiteral mutants survive type-only checks; isolated tests per guard condition
  in `if (A || B)`; try/catch + direct `.data` assertions over `toThrow(objectContaining)`.
- **Expected shape of a triage, measured over 36 in-scope survivors:** 20 real kills,
  6 phantoms, 10 provable equivalents. If a triage reports far fewer equivalents than
  that, someone is writing contrived tests against equivalent mutants; far fewer real
  kills and someone is calling real gaps equivalent. Two of the 20 real kills were not
  test gaps at all but latent defects the mutant exposed — a `(a ?? b) && c` chain
  returning the wrong operand, and a guard that let a short non-directory match win over
  the correct longer one. That is the return on doing this properly.
- **A `(mutator, line)` pair can hold both an equivalent and a real mutant.** A
  `disable next-line` binds by that pair, not by replacement value, so suppressing the
  equivalent would swallow the real one. When that happens, leave it unsuppressed and
  record the equivalence in the run record and the PR instead.
- Commit kills as `test(mutation): <module>`; re-run `npm run validate`.

## CI

The `mutation` CI job is a real per-bucket budget gate (score counts timeouts +
survivors; app ≥95) but stays non-blocking at merge — the local triage above is the
gate. Avoid mutable-index loops; minimise equivalent guards.
