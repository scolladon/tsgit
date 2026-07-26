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
  docs/spike/stryker-vitest-empty-run-survivors.md): under load the runner
  occasionally scores a mutant run that executed ZERO of its filtered tests as
  "survived" (hitCount 0). Any survivor may therefore be a phantom. Before
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
- Commit kills as `test(mutation): <module>`; re-run `npm run validate`.

## CI

The `mutation` CI job is a real per-bucket budget gate (score counts timeouts +
survivors; app ≥95) but stays non-blocking at merge — the local triage above is the
gate. Avoid mutable-index loops; minimise equivalent guards.
